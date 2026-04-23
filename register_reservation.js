/**
 * register_reservation.js
 * SalonBoard にログインして指定の予約枠に予約を登録する
 *
 * 使い方:
 *   node register_reservation.js --date 2026-05-14 --time 10:00 --name "山田 太郎" --menu "カラー"
 *
 * オプション:
 *   --date   来店日 (YYYY-MM-DD)
 *   --time   来店時間 (HH:MM)
 *   --name   お客様名
 *   --menu   メニュー名（部分一致で選択）
 *   --staff  スタッフ名（省略時は最初のスタッフ）
 *   --dry    実際に登録せずフォームまで確認するだけ
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── 引数パース ───────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const targetDate  = getArg('date');   // "2026-05-14"
const targetTime  = getArg('time');   // "10:00"
const customerName = getArg('name');  // "山田 太郎"
const menuName    = getArg('menu');   // "カラー"
const staffName   = getArg('staff');
const isDry       = args.includes('--dry');

if (!targetDate || !targetTime) {
  console.error('❌ --date と --time は必須です');
  console.error('例: node register_reservation.js --date 2026-05-14 --time 10:00 --name "山田 太郎" --menu "カラー"');
  process.exit(1);
}

// ── セッション管理 ───────────────────────────────────────────
const stateDir   = path.join(__dirname, '../state');
const statePath  = path.join(stateDir, 'salonboard-state.json');

if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

// ── メイン ───────────────────────────────────────────────────
(async () => {
  const hasSession = fs.existsSync(statePath);
  const browser = await chromium.launch({ headless: false });
  const context = hasSession
    ? await browser.newContext({ storageState: statePath })
    : await browser.newContext();
  const page = await context.newPage();

  // ── ログイン ─────────────────────────────────────────────
  console.log('🔐 SalonBoard へアクセス中...');
  await page.goto('https://salonboard.com/login/', { waitUntil: 'networkidle' });

  const isLoggedIn = await page.$('#jsiSchedule, .scheduleArea, .sideMenuArea');
  if (!isLoggedIn) {
    console.log('\n===========================================================');
    console.log('ブラウザでログインしてください。');
    console.log('ログイン完了後、スケジュールページが開くまで待ちます。');
    console.log('===========================================================\n');
    // スケジュールページか管理トップに遷移するまで待機
    await page.waitForURL(/salonboard\.com\/(CLP|CLS)\//, { timeout: 0 });
    await page.waitForTimeout(2000);
    await context.storageState({ path: statePath });
    console.log('✅ セッションを保存しました');
  }

  // ── スケジュールページへ移動 ──────────────────────────────
  // 日付をYYYYMMDD形式に変換
  const dateKey = targetDate.replace(/-/g, '');
  const scheduleUrl = `https://salonboard.com/CLP/bt/schedule/salonSchedule/?pv_date=${dateKey}`;

  console.log(`\n📅 ${targetDate} のスケジュールページへ移動...`);
  await page.goto(scheduleUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // ── 空き枠をクリック ─────────────────────────────────────
  // 時間を HHMM 形式に変換 (例: "10:00" → "1000")
  const timeKey = targetTime.replace(':', '');

  // スタッフIDを取得（スタッフ名から特定するか、最初のスタッフを使う）
  let stylistId = await resolveStaffId(page, staffName);

  // 空き枠ID: empty_time_sid_fix_{DATE}_{TIME}_{STYLIST}_{SEAT}
  const slotPattern = `empty_time_sid_fix_${dateKey}_${timeKey}_${stylistId}`;

  console.log(`\n🎯 枠を探しています: ${slotPattern}_*`);
  const slot = await page.$(`[id^="${slotPattern}"]`);

  if (!slot) {
    console.error(`❌ 枠が見つかりません: ${slotPattern}_*`);
    console.error('   すでに埋まっているか、日付・時間・スタッフIDが一致していない可能性があります。');
    await browser.close();
    process.exit(1);
  }

  console.log(`✅ 枠を発見: ${await slot.getAttribute('id')}`);

  if (isDry) {
    console.log('\n🔍 --dry モード: フォームを開かず終了します');
    await browser.close();
    return;
  }

  // 枠をクリックして予約登録フォームを開く
  await slot.click();
  await page.waitForTimeout(1500);

  // ── フォーム入力 ─────────────────────────────────────────
  // ポップアップまたは新しいページでフォームが開く
  // 「新規予約登録」ボタンが表示される場合はクリック
  const newReserveBtn = await page.$('[href*="reserveInput"], .newReserveBtn, a:has-text("新規予約")');
  if (newReserveBtn) {
    console.log('📋 予約登録フォームへ移動...');
    await newReserveBtn.click();
    await page.waitForLoadState('networkidle');
  }

  // お客様名を入力
  if (customerName) {
    const nameField = await page.$(
      'input[name*="customerName"], input[id*="customerName"], input[placeholder*="お客様"]'
    );
    if (nameField) {
      await nameField.fill(customerName);
      console.log(`✏️  お客様名: ${customerName}`);
    } else {
      console.warn('⚠️  お客様名フィールドが見つかりません（手動で入力してください）');
    }
  }

  // メニューを選択
  if (menuName) {
    const menuField = await page.$(
      'select[name*="menu"], select[id*="menu"], input[name*="menu"]'
    );
    if (menuField) {
      const tag = await menuField.evaluate(el => el.tagName);
      if (tag === 'SELECT') {
        // セレクトボックスからメニュー名が部分一致する選択肢を選ぶ
        const options = await menuField.$$('option');
        let matched = false;
        for (const opt of options) {
          const text = await opt.textContent();
          if (text.includes(menuName)) {
            await menuField.selectOption({ label: text.trim() });
            console.log(`✏️  メニュー選択: ${text.trim()}`);
            matched = true;
            break;
          }
        }
        if (!matched) console.warn(`⚠️  メニュー "${menuName}" が見つかりません`);
      } else {
        await menuField.fill(menuName);
        console.log(`✏️  メニュー入力: ${menuName}`);
      }
    } else {
      console.warn('⚠️  メニューフィールドが見つかりません（手動で入力してください）');
    }
  }

  // ── 確認 ────────────────────────────────────────────────
  console.log('\n===========================================================');
  console.log('フォームへの自動入力が完了しました。');
  console.log('内容を確認して、ブラウザから「確認」ボタンを押してください。');
  if (isDry) console.log('（--dry モードのため自動送信はしません）');
  console.log('===========================================================\n');

  // ブラウザを開いたままにして手動確認を待つ
  // 「登録完了」ページへ遷移したら自動終了
  try {
    await page.waitForURL(/reserveComplete|reserveFinish|reserveDetail/, { timeout: 120_000 });
    console.log('✅ 予約登録が完了しました！');
    await context.storageState({ path: statePath }); // セッション更新
  } catch {
    console.log('（120秒でタイムアウト。ブラウザを閉じてください）');
  }

  await browser.close();
})();

// ── スタッフID取得 ────────────────────────────────────────────
async function resolveStaffId(page, staffName) {
  // ページ内の empty_time_sid_fix_* から stylistId を取得
  const firstSlotId = await page.evaluate(() => {
    const el = document.querySelector('[id^="empty_time_sid_fix_"]');
    return el ? el.id : null;
  });

  if (firstSlotId) {
    // "empty_time_sid_fix_20260514_0930_T000779306_0" → "T000779306"
    const parts = firstSlotId.split('_');
    const stylistIdx = parts.findIndex(p => p.startsWith('T') && p.length > 5);
    if (stylistIdx !== -1) {
      const id = parts[stylistIdx];
      console.log(`👤 スタッフID自動検出: ${id}`);
      return id;
    }
  }

  // スタッフ名からIDを検索
  if (staffName) {
    const staffId = await page.evaluate((name) => {
      const links = document.querySelectorAll('[data-stylist-id], [id*="staff"]');
      for (const el of links) {
        if (el.textContent.includes(name)) {
          return el.dataset.stylistId || el.id;
        }
      }
      return null;
    }, staffName);
    if (staffId) return staffId;
  }

  console.warn('⚠️  スタッフIDを自動検出できませんでした。T000779306 を使用します。');
  return 'T000779306';
}
