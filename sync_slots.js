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
const TODAY_RES_KEY = 'today-reservations.json';

// ── ヘルパー（parse_calendar.js と共通） ─────────────────────────
function extractSpan(block, className) {
  const re = new RegExp(`class="${className}[^"]*"[^>]*>([^<]*)<`);
  const m = block.match(re);
  return m ? m[1].trim() : '';
}
function extractCustomer(block) {
  const m = block.match(/class="[^"]*reserveItemCustomer[^"]*">([^<]+)</);
  return m ? m[1].trim() : '不明';
}
function fmtDate8(raw) {
  if (!raw || raw.length !== 8) return raw || '';
  return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
}
function fmtTime4(raw) {
  if (!raw || raw.length !== 4) return raw || '';
  return `${raw.slice(0,2)}:${raw.slice(2,4)}`;
}

// スケジュール画面から stylistId→メニュー名 マッピングを抽出
function parseStylistMap(html) {
  const map = {};
  const re = /id="stylist_(T\d+|0+)"[\s\S]*?class="name[^"]*"[^>]*>(?:<[^>]+>)*([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    map[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  }
  return map;
}

// SalonBoard スケジュール画面から予約済みブロックを抽出
// SalonBoardの予約スロットは30分固定（計算済みスタイル高さ≈56px/slot で確認済み）
function addMins(timeStr, mins) {
  const [h, mn] = timeStr.split(':').map(Number);
  const total = h * 60 + mn + mins;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// HPB予約（hpbId あり）も直接/電話予約（hpbId なし）も両方取得する
function parseReservations(html, stylistMap) {
  const reservations = [];
  const re = /id="(reserve_item_\w+)"([\s\S]*?)(?=id="reserve_item_|id="empty_time_|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block     = m[2];
    const hpbId     = extractSpan(block, 'panel_reserve_id');
    const rawDate   = extractSpan(block, 'panel_reserve_date');
    const rawStart  = extractSpan(block, 'panel_reserve_start');
    const stylistId = extractSpan(block, 'panel_reserve_stylistId');
    // extractCustomer は未取得時に '不明' を返すため null 扱いにする
    const rawCustomer = extractCustomer(block);
    const customer = rawCustomer !== '不明' ? rawCustomer : '';

    // 日付・開始時刻が取れない不正ブロックはスキップ
    if (!rawDate || !rawStart) continue;

    const frameNumber = parseInt(extractSpan(block, 'frameNumber') || '1', 10);
    const startTime = fmtTime4(rawStart);
    const endTime   = addMins(startTime, frameNumber * 30);  // frameNumber × 30分が実際の所要時間

    reservations.push({
      hpbId:    hpbId || null,
      source:   hpbId ? 'hpb' : 'direct',  // 'hpb' = HPB経由 / 'direct' = 電話・店頭
      date:     fmtDate8(rawDate),
      time:     startTime,
      timeRange: `${startTime}-${endTime}`,
      menuName:     (stylistMap && stylistMap[stylistId]) || stylistId || '—',
      customerName: customer || '—',
    });
  }
  return reservations.sort((a, b) => a.time.localeCompare(b.time));
}

// parse_calendar.js と同じ正規表現で空き枠を抽出
function parseEmptySlots(html) {
  // id="empty_time_sid_fix_20260514_0930_T000779306_0"
  const emptyRe = /id="empty_time_sid_fix_(\d{8})_(\d{4})_(T\d+)_(\d+)"/g;
  const seen = new Set();
  // slotsByDate: date → time → Set<stylistId>（空きスタイリスト人数を保持）
  const slotsByDate = {};
  let m;
  while ((m = emptyRe.exec(html)) !== null) {
    const key = `${m[1]}_${m[2]}_${m[3]}_${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`;
    const time = `${m[2].slice(0,2)}:${m[2].slice(2,4)}`;
    const stylistId = m[3];
    if (!slotsByDate[date]) slotsByDate[date] = {};
    if (!slotsByDate[date][time]) slotsByDate[date][time] = new Set();
    slotsByDate[date][time].add(stylistId);
  }
  // slots: { date: [sorted times] }（既存互換）
  // slotCounts: { date: { time: freeCount } }（admin.html で動的 capacity に使用）
  const slots = {};
  const slotCounts = {};
  for (const [date, timeMap] of Object.entries(slotsByDate)) {
    const sortedTimes = Object.keys(timeMap).sort();
    slots[date] = sortedTimes;
    slotCounts[date] = {};
    for (const time of sortedTimes) {
      slotCounts[date][time] = timeMap[time].size;
    }
  }
  return { slots, slotCounts };
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

      // SP版はAJAX認証のためURLが変化しない → クリック後にトップページへ遷移してセッションを安定させる
      await loginBtn.click();
      await page.waitForTimeout(3000); // AJAX完了を待つ

      // 一旦 PC版トップページへ移動（SP→スケジュール直行はクラッシュする）
      await page.goto('https://salonboard.com/CLP/bt/top/', {
        waitUntil: 'domcontentloaded', timeout: 30_000,
      });
      await page.waitForTimeout(1500);
      const topUrl = page.url();

      if (topUrl.includes('/login')) {
        // ログインページにリダイレクトされた → 認証失敗
        await page.screenshot({ path: path.join(tmpDir, 'salonboard-login-fail.png'), fullPage: true }).catch(() => null);
        if (fs.existsSync(statePath)) {
          fs.rmSync(statePath, { force: true });
          console.warn('⚠️  セッションファイルを削除しました');
        }
        throw new Error(`SalonBoard login failed (redirected to login): ${topUrl}`);
      }

      // スケジュールページへ移動
      await page.goto('https://salonboard.com/CLP/bt/schedule/salonSchedule/', {
        waitUntil: 'domcontentloaded', timeout: 30_000,
      });
      await page.waitForTimeout(1000);
      const afterUrl = page.url();

      await context.storageState({ path: statePath });
      console.log('✅ SalonBoard ログイン完了 →', afterUrl);
    } else {
      console.log('✅ SalonBoard セッション再利用');
    }

    // ── 1日ずつ全日をスキャン ─────────────────────────────────────
    // SalonBoardは ?date=YYYYMMDD で1日単位のデータを返すため、日ごとに取得する
    const allSlots = {};
    const allSlotCounts = {};
    const reservationsByMonth = {}; // { "YYYY-MM": { "YYYY-MM-DD": [...] } }
    const now = new Date();
    const todayKey = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const endDate = new Date(now.getFullYear(), now.getMonth() + monthCount, 0); // 最終月末

    let current = new Date(now);
    let todayReservations = [];

    while (current <= endDate) {
      const dateKey  = `${current.getFullYear()}${String(current.getMonth()+1).padStart(2,'0')}${String(current.getDate()).padStart(2,'0')}`;
      const dateLabel = `${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,'0')}-${String(current.getDate()).padStart(2,'0')}`;
      const monthKey  = dateLabel.slice(0, 7);
      const label     = `${current.getFullYear()}/${current.getMonth()+1}/${current.getDate()}`;

      // ページクラッシュ時は1回リトライ
      let html;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await page.goto(
            `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
            { waitUntil: 'domcontentloaded', timeout: 30_000 }
          );
          await page.waitForTimeout(1500);
          html = await page.content();
          break;
        } catch (e) {
          if (attempt === 0 && (e.message.includes('crashed') || e.message.includes('closed') || e.name === 'TimeoutError')) {
            console.warn(`⚠️  ${label}: ページクラッシュ、リトライ中...`);
            await page.waitForTimeout(2000);
          } else {
            throw e;
          }
        }
      }
      const { slots, slotCounts } = parseEmptySlots(html);
      const stylistMap = parseStylistMap(html);
      const dayRes     = parseReservations(html, stylistMap);

      // 予約データを月別に蓄積
      if (dayRes.length > 0) {
        if (!reservationsByMonth[monthKey]) reservationsByMonth[monthKey] = {};
        reservationsByMonth[monthKey][dateLabel] = dayRes;
      }

      // 今日だけ追加ログ＆today-reservations 用に保持
      if (dateKey === todayKey) {
        todayReservations = dayRes;
        console.log(`🗂  メニューマップ: ${JSON.stringify(stylistMap)}`);
        console.log(`📋 今日の予約: ${todayReservations.length}件`);
      }

      const dayCount  = Object.keys(slots).length;
      const slotCount = Object.values(slots).reduce((s, a) => s + a.length, 0);
      if (dayCount > 0) {
        Object.assign(allSlots, slots);
        Object.assign(allSlotCounts, slotCounts);
        console.log(`✅ ${label}: ${slotCount}枠 / 予約${dayRes.length}件`);
      }

      current.setDate(current.getDate() + 1);
    }
    console.log(`\n合計: ${Object.keys(allSlots).length}日分の空き枠を取得`);

    // ── 月別予約データを Blob に保存 ────────────────────────────
    const updatedAt = new Date().toISOString();
    for (const [month, data] of Object.entries(reservationsByMonth)) {
      const payload = JSON.stringify({ updatedAt, month, reservations: data }, null, 2);
      await put(`salonboard-${month}.json`, payload, {
        access: 'public', addRandomSuffix: false, allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      const totalRes = Object.values(data).reduce((s, a) => s + a.length, 0);
      console.log(`✅ salonboard-${month}.json 保存 (${Object.keys(data).length}日 / ${totalRes}件)`);
    }

    await context.storageState({ path: statePath });

    // ── Vercel Blob に保存 ──────────────────────────────────────
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), slots: allSlots, slotCounts: allSlotCounts }, null, 2);
    await put(SLOTS_KEY, payload, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const totalDays  = Object.keys(allSlots).length;
    const totalSlots = Object.values(allSlots).reduce((s, a) => s + a.length, 0);
    console.log(`\n✅ slots-data.json をBlobに保存 (${totalDays}日分 / ${totalSlots}枠)`);

    // ── 今日の予約を Blob に保存 ────────────────────────────────
    const todayPayload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      date: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
      reservations: todayReservations,
    }, null, 2);
    await put(TODAY_RES_KEY, todayPayload, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    console.log(`✅ today-reservations.json をBlobに保存 (${todayReservations.length}件)`);

  } finally {
    await browser.close();
    if (ownLock) fs.rmSync(lockPath, { force: true });
  }
}

syncSlots().catch(err => {
  console.error('❌ sync_slots エラー:', err);
  process.exit(1);
});
