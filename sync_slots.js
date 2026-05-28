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
const storage = require('./lib/storage');
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

// panel_plan ブロックから終日休日（allDayFlg=1）のスタイリストIDを抽出
// 休日行は empty_time_sid_fix の ID が HTML に残るが class に "disable panel_plan" が付く。
// この関数で holiday set を作り、activeStylists から除外する。
function parseHolidayStylists(html) {
  // panel_plan ブロックを丸ごと切り出す（greedy を避けるため [\s\S]*? を使用）
  const blockRe = /class="panel_plan">([\s\S]*?)<\/div>/g;
  const holidayIds = new Set();
  let bm;
  while ((bm = blockRe.exec(html)) !== null) {
    const block = bm[1];
    // allDayFlg=1 のブロックだけが対象
    if (!block.includes('>1<')) continue;
    const allDayM = block.match(/class="panel_plan_allDayFlg display_none"[^>]*>(\d+)</);
    if (!allDayM || allDayM[1] !== '1') continue;
    const idM = block.match(/class="panel_plan_stylistId display_none"[^>]*>([^<]+)</);
    if (idM) holidayIds.add(idM[1].trim());
  }
  return holidayIds;
}

// stylistMap の表示名をサービス種別に変換（admin.html の getServiceType と同じルール）
function getServiceTypeName(rawName) {
  if (!rawName) return 'その他';
  if (/カラー|ヘア カラー/.test(rawName))             return 'カラー';
  if (/ホワイト|ホワイトニング/.test(rawName))         return 'ホワイトニング';
  if (/ドライ|ヘッドスパ/.test(rawName))               return 'ドライヘッドスパ';
  if (/まつげ|まつ毛/.test(rawName))                   return 'まつ毛パーマ';
  return 'その他';
}

// parse_calendar.js と同じ正規表現で空き枠を抽出
function parseEmptySlots(html) {
  // id="empty_time_sid_header_20260514_0930_T000779306_0" (旧: empty_time_sid_fix_)
  const emptyRe = /id="empty_time_sid_(?:fix|header)_(\d{8})_(\d{4})_(T\d+)_(\d+)"/g;
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

  // 終日休日のスタイリストIDを除外（例: 5/17 まつげパーマ・ドライヘッドスパ）
  const holidayIds = parseHolidayStylists(html);

  // slots: { date: [sorted times] }（既存互換）
  // slotCounts: { date: { time: freeCount } }（admin.html で動的 capacity に使用）
  // activeStylists: { date: [stylistId, ...] }（休日スタイリストを除いた稼働スタイリスト一覧）
  const slots = {};
  const slotCounts = {};
  const activeStylists = {};
  for (const [date, timeMap] of Object.entries(slotsByDate)) {
    slotCounts[date] = {};
    const stylistSet = new Set();
    for (const time of Object.keys(timeMap).sort()) {
      // 休日スタイリストをカウントから除外
      const activeInSlot = [...timeMap[time]].filter(id => !holidayIds.has(id));
      slotCounts[date][time] = activeInSlot.length;
      activeInSlot.forEach(id => stylistSet.add(id));
    }
    // count=0 の枠は「稼働スタイリスト全員が休日」= その時間は空き枠なし
    slots[date] = Object.keys(slotCounts[date]).filter(t => slotCounts[date][t] > 0).sort();
    activeStylists[date] = [...stylistSet].sort();
  }
  // slotsByDateRaw: serviceSlots 計算用に休日除外済みの date→time→Set<stylistId> を返す
  const slotsByDateRaw = {};
  for (const [date, timeMap] of Object.entries(slotsByDate)) {
    slotsByDateRaw[date] = {};
    for (const [time, ids] of Object.entries(timeMap)) {
      const active = [...ids].filter(id => !holidayIds.has(id));
      if (active.length > 0) slotsByDateRaw[date][time] = active;
    }
  }
  return { slots, slotCounts, activeStylists, slotsByDateRaw };
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

      // SP版はAJAX認証 → クリック後にログインページから遷移するまで待つ
      await loginBtn.click();

      // ログイン成功を確認: URLがログインページから変わるか、セッションCookieが設定されるまで最大30秒待つ
      let loginOk = false;
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(2000);
        const currentUrl = page.url();
        // URLがログインページから離れた = ログイン成功
        if (!currentUrl.includes('/login_sp/') && !currentUrl.includes('/login/')) {
          loginOk = true;
          console.log('🌐 ログイン後URL確認済み:', currentUrl);
          break;
        }
        // フォールバック: JSSESSIONIDクッキー確認
        const cookies = await context.cookies('https://salonboard.com');
        if (cookies.some(c => c.name === 'JSESSIONID')) { loginOk = true; break; }
      }
      if (!loginOk) {
        await page.screenshot({ path: path.join(tmpDir, 'salonboard-login-fail.png'), fullPage: true }).catch(() => null);
        throw new Error('SalonBoard login failed: ログインページから遷移できませんでした');
      }
      console.log('✅ ログイン成功を確認');

      // スケジュールページへ移動（CLP=PC版 → CLS=SP版の順でフォールバック）
      let afterUrl = '';
      const scheduleUrls = [
        'https://salonboard.com/CLP/bt/schedule/salonSchedule/',
        'https://salonboard.com/CLS/bt/schedule/salonSchedule/',
      ];
      let scheduleOk = false;
      for (const url of scheduleUrls) {
        try {
          console.log('📅 スケジュールページへ移動:', url);
          await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
          await page.waitForTimeout(3000); // コンテンツ読み込み待ち
          afterUrl = page.url();
          if (!afterUrl.includes('/login')) { scheduleOk = true; break; }
          console.warn('⚠️  ログインページにリダイレクトされた。次のURLを試す...');
        } catch (e) {
          console.warn(`⚠️  ${url} タイムアウト。次のURLを試す...`);
        }
      }
      if (!scheduleOk) {
        await page.screenshot({ path: path.join(tmpDir, 'salonboard-login-fail.png'), fullPage: true }).catch(() => null);
        if (fs.existsSync(statePath)) { fs.rmSync(statePath, { force: true }); }
        throw new Error(`SalonBoard スケジュールページへの移動に失敗: ${afterUrl}`);
      }

      await context.storageState({ path: statePath });
      console.log('✅ SalonBoard ログイン完了 →', afterUrl);
    } else {
      console.log('✅ SalonBoard セッション再利用');
    }

    // ── 1日ずつ全日をスキャン ─────────────────────────────────────
    // SalonBoardは ?date=YYYYMMDD で1日単位のデータを返すため、日ごとに取得する
    const allSlots = {};
    const allSlotCounts = {};
    const allActiveStylists = {};
    const allServiceSlots = {};
    let globalStylistMap = {};
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

      // ページクラッシュ・タイムアウト時は1回リトライ、それでも失敗なら空データでスキップ
      let html;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await page.goto(
            `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
            { waitUntil: 'domcontentloaded', timeout: 90_000 }
          );
          await page.waitForTimeout(1500);
          html = await page.content();
          break;
        } catch (e) {
          if (attempt === 0 && (e.message.includes('crashed') || e.message.includes('closed') || e.name === 'TimeoutError')) {
            console.warn(`⚠️  ${label}: タイムアウト、リトライ中...`);
            await page.waitForTimeout(3000);
          } else {
            console.warn(`⚠️  ${label}: 取得失敗（スキップ）: ${e.message.slice(0, 60)}`);
            html = '<html></html>'; // 空データで続行
            break;
          }
        }
      }
      const { slots, slotCounts, activeStylists, slotsByDateRaw } = parseEmptySlots(html);
      const stylistMap = parseStylistMap(html);
      if (Object.keys(stylistMap).length > 0) globalStylistMap = { ...globalStylistMap, ...stylistMap };

      // デバッグ: 最初の日だけ診断情報を出力
      if (Object.keys(allSlots).length === 0) {
        const emptyFixCount    = (html.match(/empty_time_sid_fix_/g) || []).length;
        const emptyHeaderCount = (html.match(/empty_time_sid_header_/g) || []).length;
        const stylistCount     = (html.match(/id="stylist_T/g) || []).length;
        const pageTitle = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '?';
        console.log(`🔍 [DEBUG] title="${pageTitle}" | empty_fix=${emptyFixCount} | empty_header=${emptyHeaderCount} | stylist=${stylistCount} | html_len=${html.length}`);
        if (emptyFixCount + emptyHeaderCount === 0) {
          // 問題あり: HTML冒頭500文字を出力
          console.log('🔍 [DEBUG] html先頭500:', html.slice(0, 500).replace(/\s+/g, ' '));
        }
      }

      // サービス別空き時間: { date: { serviceType: [times] } }
      for (const [date, timeMap] of Object.entries(slotsByDateRaw)) {
        const bySvc = {};
        for (const [time, stylistIds] of Object.entries(timeMap)) {
          for (const id of stylistIds) {
            const svc = getServiceTypeName(stylistMap[id] || globalStylistMap[id] || '');
            if (svc === 'その他') continue;
            if (!bySvc[svc]) bySvc[svc] = new Set();
            bySvc[svc].add(time);
          }
        }
        allServiceSlots[date] = {};
        for (const [svc, times] of Object.entries(bySvc)) {
          allServiceSlots[date][svc] = [...times].sort();
        }
      }
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
      // 空き0件でも必ずdateLabelを記録（undefined=sync対象外、[]=sync済み全埋まり を明確に区別するため）
      allSlots[dateLabel] = slots[dateLabel] ?? [];
      if (dayCount > 0) {
        Object.assign(allSlotCounts, slotCounts);
        Object.assign(allActiveStylists, activeStylists);
        console.log(`✅ ${label}: ${slotCount}枠 / 予約${dayRes.length}件`);
      } else {
        console.log(`⬜ ${label}: 空き0枠 / 予約${dayRes.length}件`);
      }

      current.setDate(current.getDate() + 1);
    }
    console.log(`\n合計: ${Object.keys(allSlots).length}日分の空き枠を取得`);

    // ── 月別予約データを Blob に保存 ────────────────────────────
    const updatedAt = new Date().toISOString();
    for (const [month, data] of Object.entries(reservationsByMonth)) {
      const payload = JSON.stringify({ updatedAt, month, reservations: data }, null, 2);
      await storage.put(`salonboard-${month}.json`, payload);
      const totalRes = Object.values(data).reduce((s, a) => s + a.length, 0);
      console.log(`✅ salonboard-${month}.json 保存 (${Object.keys(data).length}日 / ${totalRes}件)`);
    }

    await context.storageState({ path: statePath });

    // ── R2 に保存 ────────────────────────────────────────────────
    const payload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      slots: allSlots,
      slotCounts: allSlotCounts,
      activeStylists: allActiveStylists,
      stylistMap: globalStylistMap,
      serviceSlots: allServiceSlots,
    }, null, 2);
    await storage.put(SLOTS_KEY, payload);

    const totalDays  = Object.keys(allSlots).length;
    const totalSlots = Object.values(allSlots).reduce((s, a) => s + a.length, 0);
    console.log(`\n✅ slots-data.json を保存 (${totalDays}日分 / ${totalSlots}枠)`);

    // ── 今日の予約を保存 ──────────────────────────────────────────
    const todayPayload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      date: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
      reservations: todayReservations,
    }, null, 2);
    await storage.put(TODAY_RES_KEY, todayPayload);
    console.log(`✅ today-reservations.json を保存 (${todayReservations.length}件)`);

  } finally {
    await browser.close();
    if (ownLock) fs.rmSync(lockPath, { force: true });
  }
}

syncSlots().catch(err => {
  console.error('❌ sync_slots エラー:', err);
  process.exit(1);
});
