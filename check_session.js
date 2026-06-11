/**
 * check_session.js — セッション有効性を1アクセスだけで確認する（削除処理なし）
 */
const { launchHumanBrowser } = require('./lib/human-browser');

(async () => {
  const dateKey = process.argv[2] || '20260702';
  const { browser, page } = await launchHumanBrowser('.state/salonboard.json');
  try {
    const url = `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`;
    console.log('アクセス中:', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const info = await page.evaluate(() => ({
      title: document.title || '',
      expired: (document.title || '').includes('エラー') ||
        (document.body?.innerText || '').includes('ログインの有効期限が切れ') ||
        (document.body?.innerText || '').includes('再度ログインしなおして'),
      emptySlots: document.querySelectorAll('[id^="empty_time_sid_fix_"]').length,
    }));

    console.log('URL:', page.url());
    console.log('タイトル:', info.title);
    if (page.url().includes('/login') || info.expired) {
      console.log('❌ セッション切れ — Cookie再取得が必要');
      process.exitCode = 2;
    } else {
      console.log(`✅ セッション有効（空き枠セル: ${info.emptySlots}個検出）`);
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FATAL:', e.message.split('\n')[0]); process.exit(1); });
