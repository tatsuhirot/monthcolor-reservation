/**
 * import_from_email.js
 * HPB通知メールのテキストを解析して SalonBoard に一括登録する
 *
 * 【使い方】
 *   1. HPBから届いたメール本文を emails/ フォルダに .txt で保存
 *   2. node import_from_email.js
 *
 * 【メールファイルの置き方】
 *   003_開発/hpb-calendar/emails/予約_20260427_山田太郎.txt
 *   ※ファイル名は何でもOK、.txt なら全部読む
 *
 * 【対応メール形式】
 *   ■予約番号   BE77532488
 *   ■氏名       山田 太郎（ヤマダ タロウ）
 *   ■来店日時   2026年04月27日（月）16:00
 *   ■スタイリスト  ヘア　カラー
 *   ■メニュー   カラー
 *   ■ご利用クーポン  【平日★全員OK】リタッチカラー
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── 設定 ─────────────────────────────────────────────────────
const EMAILS_DIR  = path.join(__dirname, 'emails');
const STATE_PATH  = path.join(__dirname, '../state/salonboard-state.json');
const STATE_DIR   = path.join(__dirname, '../state');
const SCHEDULE_BASE = 'https://salonboard.com/CLP/bt/schedule/salonSchedule/';
const REGISTER_BASE = 'https://salonboard.com/CLP/bt/reserve/ext/extReserveRegist/';

// スタッフ名 → stylistId のマッピング（hpb-register.html から取得）
const STAFF_MAP = {
  'ヘア　カラー':    'T000779306',
  'ヘアカラー':      'T000779306',
  'ヘア カラー':     'T000779306',
  'ホワイト　ニング': 'T000865452',
  'ホワイトニング':  'T000865452',
  'まつげ　パーマ':  'T000900387',
  'まつげパーマ':    'T000900387',
  'ドライ　ヘッドスパ': 'T000919766',
  'ドライヘッドスパ': 'T000919766',
  'フリー':         '0000000000',
};

// ── メール解析 ───────────────────────────────────────────────

function parseEmail(text) {
  const get = (label) => {
    const re = new RegExp(`■${label}\\s*[\\r\\n]+?　?(.+?)(?:[\\r\\n]|$)`);
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };

  const reserveNo    = get('予約番号');
  const nameRaw      = get('氏名');
  const dateTimeRaw  = get('来店日時');
  const stylistRaw   = get('スタイリスト');
  const menuRaw      = get('メニュー');
  // クーポン: 【...】で始まる行を取得
  const couponBlockMatch = text.match(/■ご利用クーポン[\s\S]*?(【[^】]+】[^\r\n]*)/);
  const couponRaw = couponBlockMatch ? couponBlockMatch[1].trim() : get('ご利用クーポン');

  // 氏名解析: "山田 太郎（ヤマダ タロウ）"
  const nameMatch = nameRaw.match(/^(.+?)(?:（(.+?)）)?$/);
  const kanjiName = nameMatch ? nameMatch[1].trim() : nameRaw;
  const kanaName  = nameMatch && nameMatch[2] ? nameMatch[2].trim() : '';

  const [kanjiSei, kanjiMei] = splitName(kanjiName);
  const [kanaSei,  kanaMei]  = splitName(kanaName);

  // 来店日時解析: "2026年04月27日（月）16:00"
  const dtMatch = dateTimeRaw.match(/(\d{4})年(\d{2})月(\d{2})日.+?(\d{2}):(\d{2})/);
  let date = '', timeVal = '';
  if (dtMatch) {
    date    = `${dtMatch[1]}${dtMatch[2]}${dtMatch[3]}`; // "20260427"
    timeVal = `${dtMatch[4]}${dtMatch[5]}`;              // "1600"
  }

  // スタッフID解決
  const stylistId = resolveStaffId(stylistRaw);

  return {
    reserveNo,
    date,
    timeVal,
    kanjiSei, kanjiMei,
    kanaSei,  kanaMei,
    stylistRaw, stylistId,
    menuRaw,
    couponRaw,
    memo: `HPB予約番号: ${reserveNo}`,
  };
}

function splitName(fullName) {
  // スペース（全角・半角）で分割
  const parts = fullName.split(/[\s　]+/);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join(' ')];
  return [fullName, ''];
}

function resolveStaffId(staffRaw) {
  // 全角スペースを正規化して照合
  const normalized = staffRaw.replace(/　/g, ' ').trim();
  for (const [key, id] of Object.entries(STAFF_MAP)) {
    if (key.replace(/　/g, ' ').trim() === normalized) return id;
  }
  // 部分一致でフォールバック
  for (const [key, id] of Object.entries(STAFF_MAP)) {
    if (normalized.includes(key.replace(/　/g, ' ').trim())) return id;
  }
  console.warn(`  ⚠️  スタッフ "${staffRaw}" が STAFF_MAP に見つかりません → フリーで登録`);
  return '0000000000';
}

// ── メールファイル一覧取得 ────────────────────────────────────

function loadEmailFiles() {
  if (!fs.existsSync(EMAILS_DIR)) {
    fs.mkdirSync(EMAILS_DIR, { recursive: true });
    console.log(`📁 emails/ フォルダを作成しました。メール本文を .txt で保存してください。`);
    return [];
  }
  return fs.readdirSync(EMAILS_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({
      file: f,
      text: fs.readFileSync(path.join(EMAILS_DIR, f), 'utf-8'),
    }));
}

// ── SalonBoard 登録処理 ──────────────────────────────────────

async function registerOne(page, rsv) {
  const { date, timeVal, kanjiSei, kanjiMei, kanaSei, kanaMei,
          stylistId, couponRaw, memo } = rsv;

  // 登録フォームURLに直接アクセス（日付付き）
  const url = `${REGISTER_BASE}?date=${date}&stylistId=${stylistId}&time=${timeVal}`;
  console.log(`  🌐 ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // ── スタッフ選択 ─────────────────────────────────────
  await page.selectOption('select[name="stylistId"]', stylistId).catch(() => {});

  // ── 時間選択 ─────────────────────────────────────────
  await page.selectOption('select[name="time"]', timeVal).catch(() => {});

  // ── クーポン選択（部分一致） ──────────────────────────
  if (couponRaw) {
    const couponSelect = page.locator('select[name="netCouponId"]');
    const options = await couponSelect.locator('option').all();
    for (const opt of options) {
      const text = await opt.textContent();
      if (text && text.includes(couponRaw.replace(/【.*?】/g, '').trim())) {
        const val = await opt.getAttribute('value');
        await couponSelect.selectOption(val);
        console.log(`  🎟  クーポン選択: ${text.trim()}`);
        break;
      }
    }
  }

  // ── 氏名入力 ─────────────────────────────────────────
  if (kanaSei)   await page.fill('#nmSeiKana', kanaSei);
  if (kanaMei)   await page.fill('#nmMeiKana', kanaMei);
  if (kanjiSei)  await page.fill('#nmSei', kanjiSei);
  if (kanjiMei)  await page.fill('#nmMei', kanjiMei);

  // ── メモ（予約番号） ──────────────────────────────────
  await page.fill('#rsvEtc', memo);

  // ── 登録ボタンをクリック ──────────────────────────────
  await page.click('#regist');
  await page.waitForTimeout(1500);

  // 完了確認
  const currentUrl = page.url();
  if (currentUrl.includes('reserveDetail') || currentUrl.includes('salonSchedule')) {
    console.log(`  ✅ 登録成功`);
    return true;
  } else {
    // エラーメッセージを確認
    const errMsg = await page.textContent('.mod_err_msg, .error, .alert').catch(() => '');
    console.error(`  ❌ 登録失敗: ${errMsg || '不明なエラー'} (URL: ${currentUrl})`);
    return false;
  }
}

// ── メイン ───────────────────────────────────────────────────

(async () => {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  // メールファイル読み込み
  const emailFiles = loadEmailFiles();
  if (emailFiles.length === 0) {
    console.log('\n❌ emails/ フォルダに .txt ファイルがありません。');
    console.log('   HPBメール本文を emails/予約_日付_名前.txt として保存してください。');
    process.exit(0);
  }

  // メール解析
  const reservations = emailFiles.map(({ file, text }) => {
    const rsv = parseEmail(text);
    console.log(`📧 ${file} → ${rsv.date} ${rsv.timeVal} ${rsv.kanjiSei}${rsv.kanjiMei} [${rsv.reserveNo}]`);
    return rsv;
  }).filter(r => r.date && r.timeVal);

  console.log(`\n合計 ${reservations.length} 件を登録します。`);

  // ブラウザ起動
  const hasSession = fs.existsSync(STATE_PATH);
  const browser = await chromium.launch({ headless: false });
  const context = hasSession
    ? await browser.newContext({ storageState: STATE_PATH })
    : await browser.newContext();
  const page = await context.newPage();

  // ログイン確認
  await page.goto('https://salonboard.com/login/', { waitUntil: 'networkidle' });
  const isLoggedIn = !!(await page.$('.scheduleArea, .sideMenuArea, #jsiSchedule'));
  if (!isLoggedIn) {
    console.log('\n===========================================================');
    console.log('ブラウザでログインしてください。完了後、自動的に続行します。');
    console.log('===========================================================\n');
    await page.waitForURL(/salonboard\.com\/(CLP|CLS)\//, { timeout: 0 });
    await page.waitForTimeout(2000);
    await context.storageState({ path: STATE_PATH });
    console.log('✅ セッションを保存しました\n');
  }

  // 一括登録
  let successCount = 0;
  for (const rsv of reservations) {
    console.log(`\n[${rsv.reserveNo}] ${rsv.date} ${rsv.timeVal} ${rsv.kanjiSei} ${rsv.kanjiMei}`);
    const ok = await registerOne(page, rsv);
    if (ok) successCount++;
    await page.waitForTimeout(1000); // サーバー負荷軽減
  }

  console.log(`\n=== 完了: ${successCount}/${reservations.length} 件登録成功 ===`);

  await context.storageState({ path: STATE_PATH });
  await browser.close();
})();
