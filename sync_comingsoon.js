/**
 * sync_comingsoon.js — 1cs.jp (coming-soon) から今日の予約データをスクレイピング
 *
 * 使い方:
 *   node sync_comingsoon.js              # 今日の予約を取得してBlobに保存
 *   node sync_comingsoon.js --date YYYY-MM-DD  # 指定日
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

function getTargetDate() {
  if (dateArg) return dateArg;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
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

// ── メイン ─────────────────────────────────────────────────────────
async function syncComingSoon() {
  const loginId = process.env.COMINGSOON_LOGIN_ID;
  const loginPw = process.env.COMINGSOON_PASSWORD;
  if (!loginId || !loginPw) {
    throw new Error('COMINGSOON_LOGIN_ID / COMINGSOON_PASSWORD が .env に未設定です');
  }

  const targetDate = getTargetDate();
  // URL日付形式: YYYYMMDD
  const dateKey = targetDate.replace(/-/g, '');
  console.log(`📅 対象日: ${targetDate}`);

  const browser = await firefox.launch({ headless: true });
  const context = fs.existsSync(statePath)
    ? await browser.newContext({ storageState: statePath })
    : await browser.newContext();
  const page = await context.newPage();

  // 全ての findReserveTableDataV2 レスポンスを収集
  const allDwrTexts = [];
  page.on('response', async resp => {
    if (resp.url().includes('findReserveTableDataV2')) {
      try {
        const text = await resp.text();
        allDwrTexts.push(text);
      } catch {}
    }
  });

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

    // ── 予約管理ページへ移動（DWR が発火される） ───────────────────
    const SERVICE_URL = `https://1cs.jp/ucs/reserveService.do?StartupDate=${dateKey}`;
    console.log(`🌐 予約管理ページへ: ${SERVICE_URL}`);
    await page.goto(SERVICE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // DWR が複数回呼ばれるため十分待つ
    console.log('⏳ DWR データ読み込み待機 (10秒)...');
    await page.waitForTimeout(10_000);

    console.log(`📡 DWR レスポンス受信数: ${allDwrTexts.length}`);

    // ── 全DWRレスポンスをパース・結合 ──────────────────────────────
    const allReservations = [];
    const seenIds = new Set();

    for (const dwr of allDwrTexts) {
      const items = extractReservations(dwr);
      for (const item of items) {
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

    // 時刻順にソート
    allReservations.sort((a, b) => a.time.localeCompare(b.time));

    console.log(`\n📋 今日の予約: ${allReservations.length}件`);
    allReservations.forEach((r, i) => {
      console.log(`  [${i+1}] ${r.timeRange} | ${r.name} | ${r.menu}`);
    });

    if (allReservations.length === 0) {
      console.warn('\n⚠️  予約0件: 本日予約なし or DWRが十分に読み込まれませんでした');
    }

    // ── Vercel Blob に保存 ────────────────────────────────────────
    if (!PREVIEW) {
      const payload = JSON.stringify({
        updatedAt: new Date().toISOString(),
        date: targetDate,
        reservations: allReservations,
      }, null, 2);

      await put('comingsoon-today.json', payload, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      console.log(`\n✅ comingsoon-today.json を Blob に保存 (${allReservations.length}件)`);
    } else {
      console.log('\n[preview mode — Blob保存スキップ]');
    }

    await context.storageState({ path: statePath });
    return allReservations;

  } finally {
    await browser.close();
  }
}

syncComingSoon().catch(err => {
  console.error('❌ sync_comingsoon エラー:', err.message);
  process.exit(1);
});
