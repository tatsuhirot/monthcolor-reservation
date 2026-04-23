/**
 * server.js
 * 自社予約フォーム（reservation.html）から予約を受け取り、
 * Playwright でサロンボードに自動登録する API サーバー
 *
 * 起動: node server.js
 * ポート: 3001（環境変数 PORT で変更可能）
 *
 * .env に以下を設定してください:
 *   SALONBOARD_LOGIN_ID=your_login_id
 *   SALONBOARD_PASSWORD=your_password
 *   ALLOWED_ORIGINS=https://your-reservation-site.vercel.app
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS 設定 ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.startsWith('http://localhost') || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: ${origin} は許可されていません`));
    }
  }
}));
app.use(express.json());

// ── ヘルスチェック ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── セッション管理 ─────────────────────────────────────────────
const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

// ── POST /api/reserve ──────────────────────────────────────────
/**
 * リクエストボディ (JSON):
 *   date          string  "YYYY-MM-DD"
 *   time          string  "HH:MM"
 *   name          string  お客様名（漢字 or カナ）
 *   menuName      string  メニュー名（SalonBoard上のメニュー名と部分一致）
 *   staffCategory string  reservation.html 上の staff.id（hair/white/lash/spa）
 *   phone         string  電話番号
 *   email         string  メールアドレス
 *   memo          string  備考
 */
app.post('/api/reserve', async (req, res) => {
  const { date, time, name, menuName, staffCategory, phone, email, memo } = req.body;

  if (!date || !time || !name) {
    return res.status(400).json({ error: '日付・時間・お名前は必須です' });
  }

  console.log(`\n📩 予約受付: ${date} ${time} / ${name} / ${menuName ?? '—'}`);

  try {
    await registerInSalonBoard({ date, time, name, menuName, staffCategory, phone, email, memo });
    res.json({ ok: true, message: 'サロンボードへの登録が完了しました' });
  } catch (err) {
    console.error('❌ 登録エラー:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── サロンボード登録 ───────────────────────────────────────────
async function registerInSalonBoard({ date, time, name, menuName }) {
  const browser = await chromium.launch({ headless: false });
  const context = fs.existsSync(statePath)
    ? await browser.newContext({ storageState: statePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    // ─ ログイン確認 ─
    console.log('🔐 サロンボードへアクセス中...');
    await page.goto('https://salonboard.com/login/', { waitUntil: 'networkidle' });

    const isLoggedIn = await page.$('#jsiSchedule, .scheduleArea, .sideMenuArea');
    if (!isLoggedIn) {
      const loginId = process.env.SALONBOARD_LOGIN_ID;
      const loginPw = process.env.SALONBOARD_PASSWORD;
      if (!loginId || !loginPw) {
        throw new Error('SALONBOARD_LOGIN_ID / SALONBOARD_PASSWORD が .env に未設定です');
      }
      await page.fill('input[name="loginId"], #loginId, input[type="text"]', loginId);
      await page.fill('input[name="password"], #password, input[type="password"]', loginPw);
      await page.click('button[type="submit"], input[type="submit"], .loginBtn');
      await page.waitForURL(/salonboard\.com\/(CLP|CLS)\//, { timeout: 30_000 });
      await context.storageState({ path: statePath });
      console.log('✅ ログイン成功・セッション保存');
    }

    // ─ スケジュールページへ移動 ─
    const dateKey = date.replace(/-/g, '');
    console.log(`📅 ${date} のスケジュールページへ移動中...`);
    await page.goto(
      `https://salonboard.com/CLP/bt/schedule/salonSchedule/?pv_date=${dateKey}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(1500);

    // ─ スタッフID取得 ─
    const stylistId = await resolveStaffId(page);

    // ─ 空き枠をクリック ─
    const timeKey     = time.replace(':', '');
    const slotPattern = `empty_time_sid_fix_${dateKey}_${timeKey}_${stylistId}`;
    console.log(`🎯 空き枠を探しています: ${slotPattern}_*`);

    const slot = await page.$(`[id^="${slotPattern}"]`);
    if (!slot) {
      throw new Error(
        `空き枠が見つかりません（${date} ${time}）。` +
        `すでに予約済みか、時間帯が存在しない可能性があります。`
      );
    }
    console.log(`✅ 枠を発見: ${await slot.getAttribute('id')}`);
    await slot.click();
    await page.waitForTimeout(1500);

    // ─ 「新規予約」ボタン（ポップアップ or リンク） ─
    const newBtn = await page.$('[href*="reserveInput"], .newReserveBtn, a:has-text("新規予約")');
    if (newBtn) {
      console.log('📋 予約入力フォームへ移動...');
      // 新しいタブで開く場合に対応
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 3000 }).catch(() => null),
        newBtn.click(),
      ]);
      if (popup) {
        await popup.waitForLoadState('networkidle');
        await fillReservationForm(popup, { name, menuName });
        await context.storageState({ path: statePath });
        return;
      }
      await page.waitForLoadState('networkidle');
    }

    // 同一ページでフォームが開いた場合
    await fillReservationForm(page, { name, menuName });
    await context.storageState({ path: statePath });

  } finally {
    await browser.close();
  }
}

// ── フォーム入力 & 登録 ────────────────────────────────────────
async function fillReservationForm(page, { name, menuName }) {
  // 顧客名
  const nameField = await page.$(
    'input[name*="customerName"], input[id*="customerName"], input[placeholder*="お客様"]'
  );
  if (nameField) {
    await nameField.fill(name);
    console.log(`✏️  顧客名: ${name}`);
  } else {
    console.warn('⚠️  顧客名フィールドが見つかりません');
  }

  // メニュー（セレクトボックスを部分一致で選択）
  if (menuName) {
    const menuSel = await page.$('select[name*="menu"], select[id*="menu"]');
    if (menuSel) {
      const options = await menuSel.$$('option');
      let matched = false;
      for (const opt of options) {
        const text = await opt.textContent();
        if (text.includes(menuName)) {
          await menuSel.selectOption({ label: text.trim() });
          console.log(`✏️  メニュー: ${text.trim()}`);
          matched = true;
          break;
        }
      }
      if (!matched) console.warn(`⚠️  メニュー「${menuName}」が選択肢に見つかりません`);
    } else {
      console.warn('⚠️  メニューフィールドが見つかりません');
    }
  }

  // 確認ボタン
  const confirmBtn = await page.$('button:has-text("確認"), input[value*="確認"]');
  if (confirmBtn) {
    await confirmBtn.click();
    await page.waitForTimeout(1000);
  }

  // 登録ボタン
  const submitBtn = await page.$('button:has-text("登録"), input[value*="登録"]');
  if (submitBtn) {
    await submitBtn.click();
    await page.waitForURL(/reserveComplete|reserveFinish|reserveDetail/, { timeout: 30_000 });
    console.log('✅ サロンボードへの予約登録完了！');
  } else {
    console.warn('⚠️  登録ボタンが見つかりません。ブラウザを確認してください。');
  }
}

// ── スタッフID自動検出 ─────────────────────────────────────────
async function resolveStaffId(page) {
  const firstSlotId = await page.evaluate(() => {
    const el = document.querySelector('[id^="empty_time_sid_fix_"]');
    return el ? el.id : null;
  });
  if (firstSlotId) {
    const parts = firstSlotId.split('_');
    const idx = parts.findIndex(p => p.startsWith('T') && p.length > 5);
    if (idx !== -1) {
      console.log(`👤 スタッフID自動検出: ${parts[idx]}`);
      return parts[idx];
    }
  }
  console.warn('⚠️  スタッフID検出不可。デフォルト T000779306 を使用');
  return 'T000779306';
}

// ── 起動 ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ 予約APIサーバー起動: http://localhost:${PORT}`);
  console.log(`   POST /api/reserve — 予約受付`);
  console.log(`   GET  /health      — ヘルスチェック\n`);
});
