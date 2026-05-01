/**
 * sync_comingsoon.js — 1cs.jp (coming-soon) から予約データをスクレイピング
 *
 * 使い方:
 *   node sync_comingsoon.js              # 今日の予約を取得してBlobに保存
 *   node sync_comingsoon.js --date YYYY-MM-DD  # 指定日
 *   node sync_comingsoon.js --days 7     # 今日から7日分を連続取得
 *   node sync_comingsoon.js --preview    # Blobに保存せず結果を表示
 *
 * 環境変数:
 *   COMINGSOON_LOGIN_ID    — 1cs.jp ログインID
 *   COMINGSOON_PASSWORD    — 1cs.jp パスワード
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob トークン
 */

require('dotenv').config();
const { firefox } = require('playwright');
const { put } = require('@vercel/blob');
const fs = require('fs'), path = require('path'), os = require('os');

const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'comingsoon.json');
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

const PREVIEW = process.argv.includes('--preview');
const dateArg  = (() => {
  const idx = process.argv.indexOf('--date');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();
const daysArg  = (() => {
  const idx = process.argv.indexOf('--days');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 1;
})();

function toDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function getTargetDates() {
  if (dateArg) return [dateArg];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  return Array.from({ length: daysArg }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return toDateStr(d);
  });
}

// ── DWR レスポンスパーサー ─────────────────────────────────────────
function parseDwr(dwr) {
  const objMap = {};

  // String: s4.customerName="値";
  const strRe = /\b(s\d+)\.(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;
  let m;
  while ((m = strRe.exec(dwr)) !== null) {
    if (!objMap[m[1]]) objMap[m[1]] = {};
    try { objMap[m[1]][m[2]] = JSON.parse('"' + m[3] + '"'); }
    catch { objMap[m[1]][m[2]] = m[3]; }
  }

  // Number: s4.id=184562200;
  const numRe = /\b(s\d+)\.(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g;
  while ((m = numRe.exec(dwr)) !== null) {
    if (!objMap[m[1]]) objMap[m[1]] = {};
    objMap[m[1]][m[2]] = Number(m[3]);
  }

  return objMap;
}

function extractReservations(dwrText) {
  const objMap = parseDwr(dwrText);
  return Object.values(objMap).filter(o => o.customerName && o.reserveTime && o.id);
}

// "HH:MM-HH:MM" → "HH:MM" (ゼロパディングで正規化)
function startTime(reserveTime) {
  const t = (reserveTime || '').split('-')[0].trim();
  if (!t) return '';
  const [h, m] = t.split(':');
  return `${h.padStart(2, '0')}:${m || '00'}`;
}

// ── 1日分を取得してBlobに保存 ──────────────────────────────────────
async function syncOneDate(page, context, targetDate) {
  const dateKey = targetDate.replace(/-/g, '');
  console.log(`\n📅 ${targetDate} を取得中...`);

  const allDwrTexts = [];
  const handler = async resp => {
    if (resp.url().includes('findReserveTableDataV2')) {
      try { allDwrTexts.push(await resp.text()); } catch {}
    }
  };
  page.on('response', handler);

  const SERVICE_URL = `https://1cs.jp/ucs/reserveService.do?StartupDate=${dateKey}`;
  await page.goto(SERVICE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(10_000);
  page.off('response', handler);

  console.log(`  📡 DWRレスポンス: ${allDwrTexts.length}件`);

  const allReservations = [];
  const seenIds = new Set();
  for (const dwr of allDwrTexts) {
    for (const item of extractReservations(dwr)) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        allReservations.push({
          id:        item.id,
          time:      startTime(item.reserveTime),
          timeRange: item.reserveTime,
          name:      item.customerName || '不明',
          nameKana:  item.customerNameKana || '',
          menu:      item.name || '',
          phone:     item.customerPhoneNo2 || item.customerPhoneNo || '',
          email:     item.customerMailAddress || '',
          visitCount: item.customerReservationCount || 0,
          note:      item.userComment || '',
          source:    'comingsoon',
        });
      }
    }
  }
  allReservations.sort((a, b) => a.time.localeCompare(b.time));
  console.log(`  📋 ${allReservations.length}件`);

  const payload = JSON.stringify({
    updatedAt: new Date().toISOString(),
    date: targetDate,
    reservations: allReservations,
  }, null, 2);

  if (!PREVIEW) {
    // 日付別Blob (comingsoon-2026-05-01.json)
    await put(`comingsoon-${targetDate}.json`, payload, {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    // 今日分は comingsoon-today.json にも保存（後方互換）
    const today = toDateStr(new Date());
    if (targetDate === today) {
      await put('comingsoon-today.json', payload, {
        access: 'public', addRandomSuffix: false, allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
    }
    console.log(`  ✅ Blobに保存: comingsoon-${targetDate}.json`);
  }

  return allReservations;
}

// ── メイン ─────────────────────────────────────────────────────────
async function syncComingSoon() {
  const loginId = process.env.COMINGSOON_LOGIN_ID;
  const loginPw = process.env.COMINGSOON_PASSWORD;
  if (!loginId || !loginPw) {
    throw new Error('COMINGSOON_LOGIN_ID / COMINGSOON_PASSWORD が .env に未設定です');
  }

  const targetDates = getTargetDates();
  console.log(`📅 取得対象: ${targetDates.join(', ')}`);

  const browser = await firefox.launch({ headless: true });
  const context = fs.existsSync(statePath)
    ? await browser.newContext({ storageState: statePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    // ── ログイン ────────────────────────────────────────────────────
    const LOGIN_URL = 'https://1cs.jp/ucs/CSCServices?_SEQUENCE=1';
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const needLogin = await page.$('#loginId');

    if (needLogin) {
      console.log('🔑 1cs.jp ログイン中...');
      await page.fill('#loginId', loginId);
      await page.fill('#loginPassword', loginPw);
      await page.click('#submit-button');
      await page.waitForTimeout(3000);

      const afterUrl = page.url();
      if (afterUrl.includes('SessionDead') || afterUrl.includes('CSCServices')) {
        await page.screenshot({ path: path.join(os.tmpdir(), 'cs_login_fail.png') }).catch(() => null);
        throw new Error(`1cs.jp ログイン失敗: ${afterUrl}`);
      }
      await context.storageState({ path: statePath });
      console.log('✅ ログイン完了');
    } else {
      console.log('✅ セッション再利用');
    }

    // ── 日付ごとに取得 ──────────────────────────────────────────────
    for (const date of targetDates) {
      await syncOneDate(page, context, date);
      if (targetDates.length > 1) await page.waitForTimeout(2000); // レート制限対策
    }

    await context.storageState({ path: statePath });

    if (PREVIEW) console.log('\n[preview mode — Blob保存スキップ]');
    console.log(`\n✅ 完了 (${targetDates.length}日分)`);

  } finally {
    await browser.close();
  }
}

syncComingSoon().catch(err => {
  console.error('❌ sync_comingsoon エラー:', err.message);
  process.exit(1);
});
