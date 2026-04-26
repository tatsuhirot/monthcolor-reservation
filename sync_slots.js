/**
 * sync_slots.js — SalonBoardの空き枠をPlaywrightで取得してVercel Blobに保存
 *
 * 使い方:
 *   node sync_slots.js           # 今月・来月の空き枠を同期
 *   node sync_slots.js --months 3  # 3ヶ月分を同期
 *
 * 推奨: 1時間ごとにcronで実行
 *   npm run sync:slots
 */

require('dotenv').config();
const { firefox } = require('playwright');
const { put, head } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = os.tmpdir(); // Windows: %TEMP%, Linux: /tmp

const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const lockPath  = path.join(stateDir, 'playwright.lock');
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

// 単独実行時にロックが残っていれば古いロックを削除（プロセス死活確認）
if (fs.existsSync(lockPath)) {
  const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim());
  const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  if (!alive) {
    console.log(`⚠️  古いロックファイルを削除 (pid: ${pid} は終了済み)`);
    fs.rmSync(lockPath, { force: true });
  } else {
    console.error(`❌ 別の Playwright プロセスが起動中 (pid: ${pid})。終了します。`);
    process.exit(1);
  }
}

const SLOTS_KEY = 'slots-data.json';

// parse_calendar.js と同じ正規表現で空き枠を抽出
function parseEmptySlots(html) {
  // id="empty_time_sid_fix_20260514_0930_T000779306_0"
  const emptyRe = /id="empty_time_sid_fix_(\d{8})_(\d{4})_(T\d+)_(\d+)"/g;
  const seen = new Set();
  const slotsByDate = {};
  let m;
  while ((m = emptyRe.exec(html)) !== null) {
    const key = `${m[1]}_${m[2]}_${m[3]}_${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`;
    const time = `${m[2].slice(0,2)}:${m[2].slice(2,4)}`;
    if (!slotsByDate[date]) slotsByDate[date] = new Set();
    slotsByDate[date].add(time);
  }
  // Set → ソート済みArray
  const result = {};
  for (const [date, times] of Object.entries(slotsByDate)) {
    result[date] = [...times].sort();
  }
  return result;
}

async function syncSlots() {
  // ロック取得（worker.js から呼ばれた場合は既に取得済みのためスキップ）
  const ownLock = !fs.existsSync(lockPath);
  if (ownLock) fs.writeFileSync(lockPath, String(process.pid));
  const monthCount = parseInt(process.argv.find(a => a === '--months') ? process.argv[process.argv.indexOf('--months') + 1] : '2');

  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const browser = await firefox.launch({ headless });
  const context = fs.existsSync(statePath)
    ? await browser.newContext({ storageState: statePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    // ── ログイン ────────────────────────────────────────────────
    // SP版ログインページ（/login_sp/）を使用 — PC版より軽量でbot検知が緩い
    await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const isLoggedIn = await page.$('#jsiSchedule, .scheduleArea, .sideMenuArea, .sp-menu, [class*="schedule"]');

    if (!isLoggedIn) {
      const loginId = process.env.SALONBOARD_LOGIN_ID;
      const loginPw = process.env.SALONBOARD_PASSWORD;
      if (!loginId || !loginPw) throw new Error('SALONBOARD_LOGIN_ID / SALONBOARD_PASSWORD が .env に未設定です');

      console.log('🔑 ログインID:', loginId, '/ URL:', page.url());
      await page.screenshot({ path: path.join(tmpDir, 'salonboard-before-login.png'), fullPage: true }).catch(() => null);

      const idField = await page.$('input[name="userId"], input[name="loginId"], input[type="text"]');
      if (!idField) throw new Error('ログインIDフィールドが見つかりません（ページ構造が変わった可能性）');
      await page.fill('input[name="userId"], input[name="loginId"], input[type="text"]', loginId);
      await page.fill('input[name="password"], #password, input[type="password"]', loginPw);

      const loginBtn = await page.$('.loginBtnSize, button[type="submit"], input[type="submit"]');
      if (!loginBtn) throw new Error('ログインボタンが見つかりません');
      console.log('🖱  ログインボタンをクリック');

      // waitForURL で URL 変化を待つ（waitForNavigation より確実）
      try {
        await Promise.all([
          page.waitForURL(url => !url.includes('/login'), { timeout: 30_000 }),
          loginBtn.click(),
        ]);
      } catch {
        const url = page.url();
        await page.screenshot({ path: path.join(tmpDir, 'salonboard-login-fail.png'), fullPage: true }).catch(() => null);
        // セッションが壊れている可能性があるためリセット
        if (fs.existsSync(statePath)) {
          fs.rmSync(statePath, { force: true });
          console.warn('⚠️  セッションファイルを削除しました（次回は再ログインします）');
        }
        console.error('❌ ログインタイムアウト。現在URL:', url);
        throw new Error(`SalonBoard login timeout at: ${url}`);
      }

      const afterUrl = page.url();
      await context.storageState({ path: statePath });
      console.log('✅ SalonBoard ログイン完了 →', afterUrl);
    } else {
      console.log('✅ SalonBoard セッション再利用');
    }

    // ── 各週のカレンダーをスクレイピング ────────────────────────
    // SalonBoardは週単位表示のため、今日から1週間ごとにリクエスト
    const allSlots = {};
    const now = new Date();
    const endDate = new Date(now.getFullYear(), now.getMonth() + monthCount, 0); // 最終月末

    let weekStart = new Date(now);
    let weekIndex = 0;

    while (weekStart <= endDate) {
      const dateKey = `${weekStart.getFullYear()}${String(weekStart.getMonth()+1).padStart(2,'0')}${String(weekStart.getDate()).padStart(2,'0')}`;
      const label   = `${weekStart.getFullYear()}/${weekStart.getMonth()+1}/${weekStart.getDate()}週`;

      await page.goto(
        `https://salonboard.com/CLP/bt/schedule/salonSchedule/?pv_date=${dateKey}`,
        { waitUntil: 'networkidle' }
      );
      await page.waitForTimeout(1500);

      const html  = await page.content();
      const slots = parseEmptySlots(html);

      const dayCount  = Object.keys(slots).length;
      const slotCount = Object.values(slots).reduce((s, a) => s + a.length, 0);
      if (dayCount > 0) {
        Object.assign(allSlots, slots);
        console.log(`✅ ${label}: ${dayCount}日分 / ${slotCount}枠`);
      } else {
        console.log(`   ${label}: 空き枠なし`);
      }

      weekStart.setDate(weekStart.getDate() + 7);
      weekIndex++;
    }
    console.log(`\n合計: ${Object.keys(allSlots).length}日分の空き枠を取得`);

    await context.storageState({ path: statePath });

    // ── Vercel Blob に保存 ──────────────────────────────────────
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), slots: allSlots }, null, 2);
    await put(SLOTS_KEY, payload, {
      access: 'public',
      addRandomSuffix: false,
      overwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const totalDays  = Object.keys(allSlots).length;
    const totalSlots = Object.values(allSlots).reduce((s, a) => s + a.length, 0);
    console.log(`\n✅ slots-data.json をBlobに保存 (${totalDays}日分 / ${totalSlots}枠)`);

  } finally {
    await browser.close();
    if (ownLock) fs.rmSync(lockPath, { force: true });
  }
}

syncSlots().catch(err => {
  console.error('❌ sync_slots エラー:', err);
  process.exit(1);
});
