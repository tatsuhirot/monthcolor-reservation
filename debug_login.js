require('dotenv').config();
const { firefox } = require('playwright');
(async () => {
  const proxy = { server: process.env.PROXY_SERVER, username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD };
  const browser = await firefox.launch({ headless: true, proxy });
  const context = await browser.newContext({
    proxy,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page.on('response', r => {
    if (r.url().includes('doLogin') || r.url().includes('/CNC/login'))
      console.log('📡', r.status(), r.url());
  });

  await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'networkidle', timeout: 60000 });
  console.log('✅ ページ到達');

  // ポップアップ（ホーム画面追加）を閉じる
  const closeBtn = await page.$('.bubbleClose');
  if (closeBtn) { await closeBtn.click(); console.log('✅ ポップアップ閉じた'); await page.waitForTimeout(500); }
  else console.log('ℹ️  .bubbleClose なし');

  // ポップアップHTML確認
  const popupHtml = await page.$eval('.bubbleBox, .bmb-popup, [id*=bubble]', el => el.outerHTML).catch(() => null);
  if (popupHtml) console.log('📦 popup:', popupHtml.slice(0, 200));

  await page.fill('input[name="userId"]', process.env.SALONBOARD_LOGIN_ID);
  await page.waitForTimeout(600);
  await page.fill('input[type="password"]', process.env.SALONBOARD_PASSWORD);
  await page.waitForTimeout(800);

  // ポップアップをDOMから完全削除
  const removed = await page.evaluate(() => {
    const els = document.querySelectorAll('[id*=bubble],[class*=bubble],[class*=Bubble],[class*=popup],[class*=overlay],[class*=bmb]');
    els.forEach(el => el.remove());
    return els.length;
  });
  console.log(`✅ ポップアップ削除: ${removed}件`);

  // ボタンをJS経由でクリック（Playwright clickより確実）
  await page.evaluate(() => {
    const btn = document.querySelector('.loginBtnSize');
    if (btn) { console.log('btn found:', btn.outerHTML.slice(0, 100)); btn.click(); }
  });
  console.log('📤 ボタンJS click');
  await page.waitForTimeout(6000);

  console.log('🌐 最終URL:', page.url());
  await page.screenshot({ path: 'debug_popup_closed.png', fullPage: true });
  console.log('📸 debug_popup_closed.png 保存');
  await browser.close();
})();
