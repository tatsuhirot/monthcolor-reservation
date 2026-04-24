/**
 * sync_from_email.js
 * HPB通知メール（新規予約・キャンセル・変更）を解析して
 * Vercel Blob の予約キューを更新する。
 *
 * ※ HPB → SalonBoard の反映は自動なので Playwright 不要。
 *    このスクリプトはあくまで「自社キュー（Blob）を最新に保つ」のが目的。
 *
 * 使い方:
 *   1. emails/ フォルダにHPBメール本文を .txt で保存
 *   2. node sync_from_email.js
 *
 * 処理後は emails/processed/ に移動する。
 */

require('dotenv').config();
const { put, head } = require('@vercel/blob');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) console.log('🔍 DRY-RUN モード: Blob への書き込みはスキップします\n');

// ── スタッフ通知（LINE Notify / メール） ──────────────────────────────
async function notifyStaff(label, { date, time, name, menuName }) {
  const dateLabel = date
    ? new Date(date).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
    : date;

  const body = [
    `📅 ${dateLabel || date} ${time}`,
    `👤 ${name} 様`,
    menuName ? `💈 ${menuName}` : null,
  ].filter(Boolean).join('\n');

  if (isDryRun) {
    console.log(`  📣 [DRY-RUN] スタッフ通知:\n【${label}】\n${body}`);
    return;
  }

  const tasks = [];

  if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_OWNER_USER_ID) {
    tasks.push(
      fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          to: process.env.LINE_OWNER_USER_ID,
          messages: [{ type: 'text', text: `【${label}】\n${body}` }],
        }),
      }).then(r => { if (!r.ok) throw new Error(`LINE Push ${r.status}`); })
    );
  }

  if (process.env.STAFF_NOTIFY_EMAIL && process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    tasks.push(
      resend.emails.send({
        from:    process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
        to:      process.env.STAFF_NOTIFY_EMAIL,
        subject: `【${label}】${dateLabel || date} ${time} — ${name} 様`,
        text:    body,
      })
    );
  }

  if (tasks.length > 0) await Promise.all(tasks);
}

const EMAILS_DIR    = path.join(__dirname, 'emails');
const PROCESSED_DIR = path.join(__dirname, 'emails', 'processed');
const QUEUE_KEY     = 'reservations-queue.json';

// ── メール種別判定 ────────────────────────────────────────────────
function detectEmailType(text) {
  if (text.includes('キャンセルがありました') || text.includes('キャンセルになりました')) {
    return 'cancel';
  }
  if (text.includes('変更がありました') || text.includes('変更になりました') ||
      text.includes('ご予約内容が変更') || text.includes('予約変更')) {
    return 'change';
  }
  // 新規予約
  if (text.includes('ご予約がありました') || text.includes('予約がありました') ||
      text.includes('ご予約を承りました') || text.includes('予約確認')) {
    return 'new';
  }
  return 'unknown';
}

// ── メール解析（共通フィールド） ───────────────────────────────────
function parseEmail(text) {
  const get = (label) => {
    const re = new RegExp(`■${label}[\\s\\S]*?　?([^\\r\\n]+)`);
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };

  const reserveNo   = get('予約番号');
  const nameRaw     = get('氏名');
  const dateTimeRaw = get('来店日時');
  const stylistRaw  = get('スタイリスト');
  const menuRaw     = get('メニュー');

  // 氏名: "山田 太郎（ヤマダ タロウ）"
  const nameMatch = nameRaw.match(/^(.+?)(?:（(.+?)）)?$/);
  const kanjiName = nameMatch ? nameMatch[1].trim() : nameRaw;
  const kanaName  = nameMatch?.[2]?.trim() || '';

  // 来店日時: "2026年04月27日（月）16:00"
  const dtMatch = dateTimeRaw.match(/(\d{4})年(\d{2})月(\d{2})日[^0-9]*(\d{2}):(\d{2})/);
  const date = dtMatch ? `${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}` : '';
  const time = dtMatch ? `${dtMatch[4]}:${dtMatch[5]}` : '';

  // クーポン（メニュー名として使う）
  const couponMatch = text.match(/【([^】]+)】/);
  const menuName = couponMatch ? couponMatch[1] : menuRaw;

  return { reserveNo, kanjiName, kanaName, date, time, stylistRaw, menuName };
}

// ── 変更メール解析（変更後の日時を取得） ────────────────────────────
function parseChangeEmail(text) {
  const base = parseEmail(text);

  // 変更後の日時を探す（実際のHPBフォーマット: "■変更後の来店情報\n来店日時: YYYY年MM月DD日（曜日）HH:MM"）
  const afterMatch = text.match(/■変更後の来店情報[\s\S]*?来店日時:\s*(\d{4})年(\d{2})月(\d{2})日[^0-9]*(\d{2}):(\d{2})/);
  if (afterMatch) {
    base.newDate = `${afterMatch[1]}-${afterMatch[2]}-${afterMatch[3]}`;
    base.newTime = `${afterMatch[4]}:${afterMatch[5]}`;
  }

  return base;
}

// ── Blob キュー操作 ───────────────────────────────────────────────
async function loadQueue() {
  if (isDryRun) return [];
  try {
    const blob = await head(QUEUE_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blob) return [];
    const res = await fetch(blob.url);
    return await res.json();
  } catch {
    return [];
  }
}

async function saveQueue(queue) {
  if (isDryRun) {
    console.log('\n📋 [DRY-RUN] 保存されるキュー内容:');
    console.log(JSON.stringify(queue, null, 2));
    return;
  }
  await put(QUEUE_KEY, JSON.stringify(queue, null, 2), {
    access:          'public',
    token:           process.env.BLOB_READ_WRITE_TOKEN,
    allowOverwrite:  true,
    contentType:     'application/json',
    addRandomSuffix: false,
  });
}

// 予約番号 or 日時+名前 でキューを検索
function findInQueue(queue, { reserveNo, date, time, kanjiName }) {
  // 予約番号で検索（最優先）
  if (reserveNo) {
    const found = queue.find(r => r.hpbReserveNo === reserveNo);
    if (found) return found;
  }
  // 日時＋名前で検索（フォールバック）
  return queue.find(r =>
    r.data?.date === date &&
    r.data?.time === time &&
    r.data?.name?.includes(kanjiName.split(/\s/)[0])
  );
}

// ── 各メールタイプの処理 ──────────────────────────────────────────
function handleNew(queue, parsed, fileName) {
  const { reserveNo, kanjiName, kanaName, date, time, stylistRaw, menuName } = parsed;

  // 重複チェック（同じ予約番号がすでにある場合はスキップ）
  if (reserveNo && queue.find(r => r.hpbReserveNo === reserveNo)) {
    console.log(`  ⏭  スキップ（重複）: ${reserveNo}`);
    return false;
  }

  queue.push({
    id:           uuidv4(),
    type:         'register',
    source:       'hpb',              // HPB経由
    status:       'completed',        // HPB→SalonBoardは自動反映済み
    hpbReserveNo: reserveNo,
    data: {
      date,
      time,
      name:          kanjiName,
      kanaName,
      menuName,
      staffCategory: stylistRaw,
      phone:         '',
      email:         '',
      memo:          `HPB予約番号: ${reserveNo}`,
    },
    createdAt:   new Date().toISOString(),
    processedAt: new Date().toISOString(),
    emailFile:   fileName,
    error:       null,
  });

  console.log(`  ✅ 新規予約をキューに追加: ${date} ${time} / ${kanjiName} [${reserveNo}]`);
  return true;
}

async function handleCancel(queue, parsed, fileName) {
  const target = findInQueue(queue, parsed);

  if (!target) {
    // キューに見つからない場合はキャンセル記録として追加
    console.warn(`  ⚠️  対応する予約がキューに見つかりません → キャンセル記録として追加`);
    const newEntry = {
      id:           uuidv4(),
      type:         'register',
      source:       'hpb',
      status:       'cancelled',
      hpbReserveNo: parsed.reserveNo,
      data: {
        date:     parsed.date,
        time:     parsed.time,
        name:     parsed.kanjiName,
        menuName: parsed.menuName,
        memo:     `HPB予約番号: ${parsed.reserveNo}（HPBよりキャンセル）`,
      },
      createdAt:   new Date().toISOString(),
      processedAt: new Date().toISOString(),
      emailFile:   fileName,
      error:       null,
    };
    queue.push(newEntry);
    await notifyStaff('HPBキャンセル', newEntry.data)
      .catch(e => console.warn('  ⚠️ スタッフ通知失敗:', e.message));
    return true;
  }

  target.status      = 'cancelled';
  target.processedAt = new Date().toISOString();
  target.cancelledBy = 'hpb';
  target.emailFile   = fileName;
  console.log(`  ✅ キャンセル反映: ${target.data.date} ${target.data.time} / ${target.data.name} [${parsed.reserveNo}]`);
  await notifyStaff('HPBキャンセル', target.data)
    .catch(e => console.warn('  ⚠️ スタッフ通知失敗:', e.message));
  return true;
}

async function handleChange(queue, parsed, fileName) {
  const target = findInQueue(queue, parsed);
  const { newDate, newTime, kanjiName, menuName, reserveNo } = parsed;

  if (!target) {
    console.warn(`  ⚠️  対応する予約がキューに見つかりません → 変更後の内容で新規追加`);
    const newEntry = {
      id:           uuidv4(),
      type:         'register',
      source:       'hpb',
      status:       'completed',
      hpbReserveNo: reserveNo,
      data: {
        date:     newDate || parsed.date,
        time:     newTime || parsed.time,
        name:     kanjiName,
        menuName,
        memo:     `HPB予約番号: ${reserveNo}（変更後）`,
      },
      createdAt:   new Date().toISOString(),
      processedAt: new Date().toISOString(),
      emailFile:   fileName,
      error:       null,
    };
    queue.push(newEntry);
    await notifyStaff('HPB日程変更', newEntry.data)
      .catch(e => console.warn('  ⚠️ スタッフ通知失敗:', e.message));
    return true;
  }

  // 変更前の内容を記録して更新
  target.previousData = { ...target.data };
  if (newDate) target.data.date = newDate;
  if (newTime) target.data.time = newTime;
  target.status      = 'completed';
  target.processedAt = new Date().toISOString();
  target.changedBy   = 'hpb';
  target.emailFile   = fileName;
  console.log(`  ✅ 変更反映: ${target.data.date} ${target.data.time} / ${target.data.name} [${reserveNo}]`);
  await notifyStaff('HPB日程変更', target.data)
    .catch(e => console.warn('  ⚠️ スタッフ通知失敗:', e.message));
  return true;
}

// ── メイン ───────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(EMAILS_DIR)) {
    fs.mkdirSync(EMAILS_DIR, { recursive: true });
    console.log('📁 emails/ フォルダを作成しました。HPBメール本文を .txt で保存してください。');
    return;
  }
  if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  }

  const files = fs.readdirSync(EMAILS_DIR).filter(f => f.endsWith('.txt'));
  if (files.length === 0) {
    console.log('❌ emails/ に .txt ファイルがありません。');
    return;
  }

  console.log(`\n📧 ${files.length} 件のメールを処理します...\n`);

  const queue = await loadQueue();
  let changed = false;

  for (const file of files) {
    const text = fs.readFileSync(path.join(EMAILS_DIR, file), 'utf-8');
    const type = detectEmailType(text);
    console.log(`[${file}] 種別: ${type}`);

    let ok = false;
    if (type === 'new') {
      ok = handleNew(queue, parseEmail(text), file);
    } else if (type === 'cancel') {
      ok = handleCancel(queue, parseEmail(text), file);
    } else if (type === 'change') {
      ok = handleChange(queue, parseChangeEmail(text), file);
    } else {
      console.warn(`  ⚠️  種別不明のメール → スキップ（手動確認してください）`);
    }

    if (ok) {
      if (!isDryRun) {
        // 処理済みフォルダに移動
        fs.renameSync(
          path.join(EMAILS_DIR, file),
          path.join(PROCESSED_DIR, `${Date.now()}_${file}`)
        );
      }
      changed = true;
    }
  }

  if (changed) {
    await saveQueue(queue);
    if (!isDryRun) console.log('\n✅ Vercel Blob のキューを更新しました');
  } else {
    console.log('\n変更なし（処理対象メールが0件 or 全スキップ）');
  }
})();
