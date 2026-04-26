/**
 * worker.js — ローカル予約処理ワーカー
 *
 * Vercel Blob の予約キューを取得し、
 * pending な予約を Playwright で SalonBoard に登録する。
 *
 * 使い方:
 *   node worker.js          # 未処理の予約を全件処理して終了
 *   node worker.js --watch  # 60秒ごとにポーリング（常時起動）
 *
 * VPS 移行時はこのファイルをそのままサーバーに置いて
 *   node worker.js --watch
 * で動かすだけでOK。
 */

require('dotenv').config();
const { put, head } = require('@vercel/blob');
const { firefox } = require('playwright');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const QUEUE_KEY         = 'reservations-queue.json';
const POLL_INTERVAL     = 60_000;        // 60秒ごとにキュー確認
const SLOTS_SYNC_INTERVAL = 60 * 60_000; // 1時間ごとに空き枠同期
const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const lockPath  = path.join(stateDir, 'playwright.lock'); // Playwright 排他ロック
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

const isWatch = process.argv.includes('--watch');
const isRetry = process.argv.includes('--retry');

let lastSlotsSync = 0; // 最後に空き枠同期した時刻

// ── メイン ───────────────────────────────────────────────────────
async function main() {
  if (isRetry) {
    console.log('🔁 リトライモード: failed な予約を再処理します\n');
    await retryFailed();
  } else if (isWatch) {
    console.log(`🔄 ウォッチモード: ${POLL_INTERVAL / 1000}秒ごとにキューを確認 / 1時間ごとに空き枠同期`);
    console.log('   終了するには Ctrl+C\n');
    while (true) {
      await processQueue();
      await syncSlotsIfNeeded();
      await sleep(POLL_INTERVAL);
    }
  } else {
    await processQueue();
  }
}

// ── 空き枠同期（1時間ごと、Playwright ロックで排他制御） ───────────────
async function syncSlotsIfNeeded() {
  const elapsed = Date.now() - lastSlotsSync;
  if (elapsed < SLOTS_SYNC_INTERVAL) return; // まだ時間になっていない

  // Playwright がすでに動いている場合はスキップ
  if (fs.existsSync(lockPath)) {
    console.log(`[${now()}] ⏭ 空き枠同期スキップ（Playwright ロック中）`);
    return;
  }

  console.log(`[${now()}] 🗓 空き枠同期を開始します...`);
  // ロックは sync_slots.js 自身が管理する（ここで書くと子プロセスが弾かれる）

  const result = spawnSync('node', ['sync_slots.js'], {
    cwd: __dirname,
    stdio: 'inherit',  // ログをそのまま表示
    timeout: 5 * 60_000, // 5分タイムアウト
  });
  if (result.status === 0) {
    lastSlotsSync = Date.now();
    console.log(`[${now()}] ✅ 空き枠同期完了`);
  } else {
    console.error(`[${now()}] ❌ 空き枠同期失敗 (exit: ${result.status})`);
  }
}

// ── リトライ処理 ──────────────────────────────────────────────────
async function retryFailed() {
  const queue = await loadQueue();
  const failed = queue.filter(r => r.status === 'failed');

  if (failed.length === 0) {
    console.log(`[${now()}] ✅ 失敗した予約はありません`);
    return;
  }

  console.log(`[${now()}] 🔁 失敗した予約: ${failed.length}件 → pending に戻して再処理します\n`);

  for (const r of failed) {
    r.status = 'pending';
    r.error  = null;
    r.retriedAt = new Date().toISOString();
  }
  await saveQueue(queue);
  await processQueue();
}

// ── キュー処理 ────────────────────────────────────────────────────
async function processQueue() {
  const queue = await loadQueue();
  const pending = queue.filter(r => r.status === 'pending');

  if (pending.length === 0) {
    console.log(`[${now()}] ✅ 未処理の予約はありません`);
    return;
  }

  console.log(`[${now()}] 📋 未処理の予約: ${pending.length}件`);

  for (const reservation of pending) {
    const { id, type = 'register', data } = reservation;
    console.log(`\n[${now()}] ⏳ 処理中 [${type}]: ${id} / ${data.date} ${data.time} / ${data.name}`);

    // ステータスを processing に更新（二重処理防止）
    await updateStatus(queue, id, 'processing');

    try {
      if (type === 'register') {
        await registerInSalonBoard(data);
      } else if (type === 'cancel') {
        await cancelInSalonBoard(data);
      }
      await updateStatus(queue, id, 'completed');
      console.log(`[${now()}] ✅ 完了 [${type}]: ${id}`);
    } catch (err) {
      console.error(`[${now()}] ❌ 失敗 [${type}]: ${id} — ${err.message}`);
      await updateStatus(queue, id, 'failed', err.message);
    }
  }
}

// ── SalonBoard 登録（server.js から移植）──────────────────────────
async function registerInSalonBoard({ date, time, name, menuName }) {
  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const browser = await firefox.launch({ headless });
  const context = fs.existsSync(statePath)
    ? await browser.newContext({ storageState: statePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('   🔐 SalonBoard にアクセス中...');
    await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const isLoggedIn = await page.$('#jsiSchedule, .scheduleArea, .sideMenuArea, .sp-menu, [class*="schedule"]');
    if (!isLoggedIn) {
      const loginId = process.env.SALONBOARD_LOGIN_ID;
      const loginPw = process.env.SALONBOARD_PASSWORD;
      if (!loginId || !loginPw) throw new Error('SALONBOARD_LOGIN_ID / SALONBOARD_PASSWORD が .env に未設定です');

      await page.fill('input[name="userId"], input[name="loginId"], input[type="text"]', loginId);
      await page.fill('input[name="password"], #password, input[type="password"]', loginPw);
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 }),
          page.click('.loginBtnSize, button[type="submit"], input[type="submit"]'),
        ]);
      } catch {
        const url = page.url();
        await page.screenshot({ path: '/tmp/salonboard-login-fail-worker.png', fullPage: true }).catch(() => null);
        throw new Error(`SalonBoard login timeout at: ${url}`);
      }
      const afterUrl = page.url();
      if (afterUrl.includes('/login')) {
        throw new Error(`SalonBoard login failed - redirected back to login: ${afterUrl}`);
      }
      await context.storageState({ path: statePath });
      console.log('   ✅ ログイン成功 →', afterUrl);
    }

    const dateKey = date.replace(/-/g, '');
    await page.goto(
      `https://salonboard.com/CLP/bt/schedule/salonSchedule/?pv_date=${dateKey}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(1500);

    const stylistId = await resolveStaffId(page);
    const timeKey   = time.replace(':', '');
    const slotPattern = `empty_time_sid_fix_${dateKey}_${timeKey}_${stylistId}`;

    const slot = await page.$(`[id^="${slotPattern}"]`);
    if (!slot) throw new Error(`空き枠が見つかりません（${date} ${time}）`);

    await slot.click();
    await page.waitForTimeout(1500);

    const newBtn = await page.$('[href*="reserveInput"], .newReserveBtn, a:has-text("新規予約")');
    if (newBtn) {
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 3000 }).catch(() => null),
        newBtn.click(),
      ]);
      if (popup) {
        await popup.waitForLoadState('networkidle');
        await fillForm(popup, { name, menuName });
        await context.storageState({ path: statePath });
        return;
      }
      await page.waitForLoadState('networkidle');
    }

    await fillForm(page, { name, menuName });
    await context.storageState({ path: statePath });

  } finally {
    await browser.close();
  }
}

async function fillForm(page, { name, menuName }) {
  const nameField = await page.$(
    'input[name*="customerName"], input[id*="customerName"], input[placeholder*="お客様"]'
  );
  if (nameField) {
    await nameField.fill(name);
    console.log(`   ✏️  顧客名: ${name}`);
  }

  if (menuName) {
    const menuSel = await page.$('select[name*="menu"], select[id*="menu"]');
    if (menuSel) {
      const options = await menuSel.$$('option');
      for (const opt of options) {
        const text = await opt.textContent();
        if (text.includes(menuName)) {
          await menuSel.selectOption({ label: text.trim() });
          console.log(`   ✏️  メニュー: ${text.trim()}`);
          break;
        }
      }
    }
  }

  const confirmBtn = await page.$('button:has-text("確認"), input[value*="確認"]');
  if (confirmBtn) { await confirmBtn.click(); await page.waitForTimeout(1000); }

  const submitBtn = await page.$('button:has-text("登録"), input[value*="登録"]');
  if (submitBtn) {
    await submitBtn.click();
    await page.waitForURL(/reserveComplete|reserveFinish|reserveDetail/, { timeout: 30_000 });
  }
}

// ── SalonBoard キャンセル ─────────────────────────────────────────
async function cancelInSalonBoard({ date, time, name }) {
  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const browser = await firefox.launch({ headless });
  const context = fs.existsSync(statePath)
    ? await browser.newContext({ storageState: statePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    // ログイン確認
    await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const isLoggedIn = await page.$('#jsiSchedule, .scheduleArea, .sideMenuArea, .sp-menu, [class*="schedule"]');
    if (!isLoggedIn) {
      const loginId = process.env.SALONBOARD_LOGIN_ID;
      const loginPw = process.env.SALONBOARD_PASSWORD;
      if (!loginId || !loginPw) throw new Error('認証情報が未設定です');
      await page.fill('input[name="userId"], input[name="loginId"], input[type="text"]', loginId);
      await page.fill('input[name="password"], #password, input[type="password"]', loginPw);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 }),
        page.click('.loginBtnSize, button[type="submit"], input[type="submit"]'),
      ]);
      await context.storageState({ path: statePath });
    }

    // スケジュールページで該当予約ブロックを探す
    const dateKey = date.replace(/-/g, '');
    await page.goto(
      `https://salonboard.com/CLP/bt/schedule/salonSchedule/?pv_date=${dateKey}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(1500);

    const timeKey = time.replace(':', '');

    // 予約済みブロックのセレクター（※実機テストで要確認）
    // SalonBoard では予約済みセルは .reserveBlock や [id^="reserve_"] などの場合が多い
    const reserveBlock = await page.$(
      `[id*="${dateKey}"][id*="${timeKey}"]:not([id^="empty_"])` +
      `, .reserveBlock[data-time="${timeKey}"]` +
      `, td[id*="${timeKey}"] .reserveItem`
    );

    if (!reserveBlock) {
      throw new Error(
        `キャンセル対象の予約ブロックが見つかりません（${date} ${time} / ${name}）。` +
        `手動でSalonBoardを確認してください。`
      );
    }

    await reserveBlock.click();
    await page.waitForTimeout(1500);

    // 詳細ページ or ポップアップでキャンセルボタンを押す
    const cancelBtn = await page.$(
      'a:has-text("キャンセル"), button:has-text("キャンセル"), ' +
      'a:has-text("削除"), button:has-text("削除"), ' +
      'input[value*="キャンセル"], input[value*="削除"]'
    );
    if (!cancelBtn) throw new Error('キャンセルボタンが見つかりません。手動で操作してください。');

    await cancelBtn.click();
    await page.waitForTimeout(1000);

    // 確認ダイアログがある場合
    const confirmBtn = await page.$(
      'button:has-text("OK"), button:has-text("はい"), input[value="OK"], input[value="はい"]'
    );
    if (confirmBtn) await confirmBtn.click();

    await page.waitForTimeout(1000);
    await context.storageState({ path: statePath });
    console.log(`   ✅ SalonBoard キャンセル完了: ${date} ${time} / ${name}`);

  } finally {
    await browser.close();
  }
}

async function resolveStaffId(page) {
  const firstSlotId = await page.evaluate(() => {
    const el = document.querySelector('[id^="empty_time_sid_fix_"]');
    return el ? el.id : null;
  });
  if (firstSlotId) {
    const parts = firstSlotId.split('_');
    const idx = parts.findIndex(p => p.startsWith('T') && p.length > 5);
    if (idx !== -1) return parts[idx];
  }
  return 'T000779306';
}

// ── Blob キュー操作 ───────────────────────────────────────────────
async function loadQueue() {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const blob = await head(QUEUE_KEY, { token });
    if (!blob) return [];
    const res = await fetch(blob.url);
    return await res.json();
  } catch {
    return [];
  }
}

async function updateStatus(queue, id, status, error = null) {
  const item = queue.find(r => r.id === id);
  if (!item) return;
  item.status      = status;
  item.processedAt = new Date().toISOString();
  item.error       = error;
  await saveQueue(queue);
}

async function saveQueue(queue) {
  await put(QUEUE_KEY, JSON.stringify(queue, null, 2), {
    access:          'public',
    token:           process.env.BLOB_READ_WRITE_TOKEN,
    overwrite:       true,
    contentType:     'application/json',
    addRandomSuffix: false,
  });
}

// ── ユーティリティ ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleTimeString('ja-JP'); }

main().catch(err => {
  console.error('❌ ワーカーエラー:', err.message);
  process.exit(1);
});
