/**
 * api/cron-morning-report.js — 朝の日報 LINE Notify（Vercel Cron）
 *
 * vercel.json の crons で毎朝 23:00 UTC（8:00 JST）に実行される。
 * coming-soon と SalonBoard 両方の当日予約をまとめて LINE Notify に送信する。
 *
 * 環境変数:
 *   LINE_NOTIFY_TOKEN       — LINE Notify のアクセストークン
 *   BLOB_READ_WRITE_TOKEN   — Vercel Blob トークン
 *   CRON_SECRET             — Vercel Cron 認証シークレット（省略可）
 *   COMINGSOON_PASSWORD     — CS データ取得用（共用）
 */

require('dotenv').config();
const { head } = require('@vercel/blob');

// ── JST の今日の日付 ─────────────────────────────────────────────
function todayJST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC+9
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function jpDateLabel(dateStr) {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(dateStr + 'T00:00:00+09:00');
  return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]})`;
}

// ── CS 予約取得（Blob: comingsoon-today.json）──────────────────
async function fetchCSReservations(token) {
  try {
    const blob = await head('comingsoon-today.json', { token });
    if (!blob) return [];
    const data = await fetch(blob.url).then(r => r.json());
    return (data.reservations || []).map(r => ({
      time: r.time || (r.reserveTime || '').split('-')[0].trim() || '??:??',
      name: r.name || r.customerName || '—',
      menu: r.menuName || r.courseName || r.course || '',
      staff: r.staffName || r.staffNameKana || '',
      source: 'CS',
    }));
  } catch (e) {
    console.warn('CS 予約取得失敗:', e.message);
    return [];
  }
}

// ── SalonBoard 予約取得（Blob: salonboard-YYYY-MM.json）──────────
async function fetchSBReservations(date, token) {
  const month = date.slice(0, 7);
  try {
    const meta = await head(`salonboard-${month}.json`, { token });
    if (!meta) return [];
    const data = await fetch(meta.url).then(r => r.json());
    const list = (data.reservations || {})[date] || [];
    return list.map(r => ({
      time: r.time || r.startTime || '??:??',
      name: r.customerName || r.name || '—',
      menu: r.menuName || r.course || '',
      staff: r.staffName || '',
      source: 'SB',
    }));
  } catch (e) {
    console.warn('SalonBoard 予約取得失敗:', e.message);
    return [];
  }
}

// ── LINE Notify 送信 ─────────────────────────────────────────────
async function sendLineNotify(token, message) {
  const resp = await fetch('https://notify-api.line.me/api/notify', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `message=${encodeURIComponent(message)}`,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LINE Notify エラー: ${resp.status} ${text}`);
  }
  return resp.json();
}

// ── メッセージ組み立て ──────────────────────────────────────────
function buildMessage(date, csReservations, sbReservations) {
  const label = jpDateLabel(date);
  const csCount = csReservations.length;
  const sbCount = sbReservations.filter(r => r.time !== '??:??').length;

  const header = [
    `\n🌿 MONTH COLOR 本日の予約`,
    `${label}`,
  ];

  // CS セクション（顧客名あり）
  const csSection = [];
  if (csCount === 0) {
    csSection.push('CS: 予約なし');
  } else {
    csSection.push(`【CS】${csCount}件`);
    for (const r of csReservations) {
      const menu  = r.menu  ? ` ${r.menu}`  : '';
      const staff = r.staff ? ` [${r.staff}]` : '';
      csSection.push(`${r.time} ${r.name}${menu}${staff}`);
    }
  }

  // SalonBoard セクション（時刻スロット情報のみ）
  const sbSlots = sbReservations.filter(r => r.time !== '??:??');
  const sbSection = [];
  if (sbSlots.length === 0) {
    sbSection.push('SB: データなし');
  } else {
    sbSection.push(`【SalonBoard】${sbSlots.length}枠`);
    // 時間帯ごとにグルーピング
    const byTime = {};
    for (const r of sbSlots) {
      if (!byTime[r.time]) byTime[r.time] = [];
      byTime[r.time].push(r.menu || '予約');
    }
    for (const [time, menus] of Object.entries(byTime)) {
      const uniq = [...new Set(menus)];
      sbSection.push(`${time} ×${menus.length} ${uniq[0] || ''}`);
    }
  }

  // LINE Notify は4096文字制限 — 長すぎる場合はCS分のみ
  const sep = '\n' + '─'.repeat(18) + '\n';
  let msg = header.join('\n') + sep + csSection.join('\n') + sep + sbSection.join('\n');

  if (msg.length > 3800) {
    // SBを省略してCSのみ
    msg = header.join('\n') + sep + csSection.join('\n') + `\n\nSB: ${sbSlots.length}枠（省略）`;
  }
  if (msg.length > 3800) {
    // CSも多い場合は先頭30件
    const trimmedCS = csReservations.slice(0, 30);
    const csLines = trimmedCS.map(r => `${r.time} ${r.name}`);
    msg = header.join('\n') + sep + `【CS】${csCount}件（上位30件）\n` + csLines.join('\n') + `\n\nSB: ${sbSlots.length}枠（省略）`;
  }

  return msg;
}

// ── メインハンドラ ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Vercel Cron 認証
  const authHeader = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const lineToken = process.env.LINE_NOTIFY_TOKEN;
  if (!lineToken) {
    console.warn('LINE_NOTIFY_TOKEN 未設定 — 朝の日報スキップ');
    return res.status(200).json({ skipped: true, reason: 'LINE_NOTIFY_TOKEN not set' });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const date      = todayJST();
  console.log(`📅 朝の日報: ${date}`);

  const [csReservations, sbReservations] = await Promise.all([
    fetchCSReservations(blobToken),
    fetchSBReservations(date, blobToken),
  ]);

  const message = buildMessage(date, csReservations, sbReservations);

  console.log(message);
  console.log(`\n文字数: ${message.length}`);

  try {
    await sendLineNotify(lineToken, message);
    console.log(`✅ LINE Notify 送信完了: CS ${csReservations.length}件 / SB ${sbReservations.length}枠`);
    return res.status(200).json({
      sent: true, date,
      cs: csReservations.length,
      sb: sbReservations.length,
    });
  } catch (e) {
    console.error('❌ LINE Notify 失敗:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
