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
const storage = require('./lib/storage');
const { firefox } = require('playwright');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const tmpDir = os.tmpdir();

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
  await runSyncSlots();
}

// ── 空き枠同期の実体（強制実行用。ロックチェックのみ） ───────────────────
async function runSyncSlots() {
  if (fs.existsSync(lockPath)) {
    console.log(`[${now()}] ⏭ 空き枠同期スキップ（Playwright ロック中）`);
    return;
  }

  console.log(`[${now()}] 🗓 空き枠同期を開始します...`);
  const result = spawnSync('node', ['sync_slots.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    timeout: 20 * 60_000,
  });
  if (result.status === 0) {
    lastSlotsSync = Date.now();
    console.log(`[${now()}] ✅ 空き枠同期完了`);
  } else {
    console.error(`[${now()}] ❌ 空き枠同期失敗 (exit: ${result.status})`);
  }
}

// キャンセル日が今日から3日以内か判定
function isWithin3Days(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  const diffDays = Math.floor((target - today) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= 2; // 当日(0)・翌日(1)・翌々日(2)
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
        // 直近3日以内のキャンセルは即時sync（当日は特に重要）
        if (isWithin3Days(data.date)) {
          console.log(`[${now()}] 📅 直近3日以内のキャンセル（${data.date}）→ 即時sync実行`);
          await runSyncSlots();
        }
      }
      await updateStatus(queue, id, 'completed');
      console.log(`[${now()}] ✅ 完了 [${type}]: ${id}`);
    } catch (err) {
      console.error(`[${now()}] ❌ 失敗 [${type}]: ${id} — ${err.message}`);
      await updateStatus(queue, id, 'failed', err.message);
    }
  }
}

// ── SalonBoard ログイン共通ヘルパー ──────────────────────────────────
async function ensureLoggedIn(page, context, dateKey) {
  console.log('   🔐 SalonBoard にアクセス中...');
  await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const isLoggedIn = await page.$('#jsiSchedule, .scheduleArea, .sideMenuArea, .sp-menu, [class*="schedule"]');
  if (!isLoggedIn) {
    const loginId = process.env.SALONBOARD_LOGIN_ID;
    const loginPw = process.env.SALONBOARD_PASSWORD;
    if (!loginId || !loginPw) throw new Error('SALONBOARD_LOGIN_ID / SALONBOARD_PASSWORD が .env に未設定です');

    await page.fill('input[name="userId"], input[name="loginId"], input[type="text"]', loginId);
    await page.fill('input[name="password"], #password, input[type="password"]', loginPw);
    await page.click('.loginBtnSize, button[type="submit"], input[type="submit"]');
    await page.waitForTimeout(3000); // AJAX完了を待つ

    // スケジュールページへ移動してセッションが有効か確認
    await page.goto(
      `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 }
    );
    if (page.url().includes('/login')) {
      await page.screenshot({ path: path.join(tmpDir, 'salonboard-login-fail-worker.png'), fullPage: true }).catch(() => null);
      if (fs.existsSync(statePath)) fs.rmSync(statePath, { force: true });
      throw new Error(`SalonBoard login failed`);
    }
    await context.storageState({ path: statePath });
    console.log('   ✅ ログイン成功 →', page.url());
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
    const dateKey = date.replace(/-/g, '');
    await ensureLoggedIn(page, context, dateKey);

    await page.goto(
      `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(1500);

    const timeKey = time.replace(':', '');
    // スタイリストIDを限定せず、その時間帯に空いている誰でも選ぶ（6枠対応）
    const slot = await page.$(`[id^="empty_time_sid_fix_${dateKey}_${timeKey}_"]`);
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
    const dateKey = date.replace(/-/g, '');
    await ensureLoggedIn(page, context, dateKey);

    // スケジュールページで該当予約ブロックを探す
    await page.goto(
      `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(1500);

    const timeKey = time.replace(':', '');
    const stylistId = await resolveStaffId(page);

    // SalonBoard の予約済みセルは reserve_sid_fix_{date}_{time}_{staffId} 形式
    // （empty_time_sid_fix_ の逆パターン — 調査済み）
    const reserveBlock = await page.$(
      `[id^="reserve_sid_fix_${dateKey}_${timeKey}_${stylistId}"]` +
      `, [id^="reserve_sid_fix_${dateKey}_${timeKey}_"]`  // stylistId が変わっていても拾う
    );

    if (!reserveBlock) {
      // 全予約ブロックをダンプしてデバッグログ
      const allReserveIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[id^="reserve_sid_fix_"]')).map(el => el.id)
      );
      console.error(`   ⚠️ 予約ブロック一覧: ${JSON.stringify(allReserveIds)}`);
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

// ── ストレージ キュー操作 ─────────────────────────────────────────
async function loadQueue() {
  try {
    return (await storage.get(QUEUE_KEY)) || [];
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
  await storage.put(QUEUE_KEY, JSON.stringify(queue, null, 2));
}

// ── ユーティリティ ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleTimeString('ja-JP'); }

main().catch(err => {
  console.error('❌ ワーカーエラー:', err.message);
  process.exit(1);
});
