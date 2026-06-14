/**
 * relogin.js — ワーカー専用プロファイルのセッションを手動ログインで復活させる
 *
 * ★ 使い方 ★
 *   node relogin.js
 *   → Chromeが開くのでSalonBoardにログインするだけ（Enter不要・自動検知）
 *   → ログイン後、スケジュールページの表示まで自動確認して終了
 *
 * セッションが切れる主な原因: 同じアカウントで他の場所（サロンスタッフ・
 * 普段使いChrome・プロキシ実験等）からログインすると蹴り出される（1アカウント1セッション）
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

const PROFILE_DIR = process.env.SALONBOARD_PROFILE_DIR ||
                    path.join(__dirname, '.state', 'chrome-profile');

(async () => {
  console.log(`🌐 ワーカー専用プロファイルで起動 (${PROFILE_DIR})`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto('https://salonboard.com/login/', { waitUntil: 'domcontentloaded', timeout: 90_000 });

    // すでにセッションが生きていてTOPに飛ばされた場合はログイン不要
    if (!page.url().includes('/login')) {
      console.log('✅ セッションは既に有効です（ログイン不要）');
    } else {
      console.log('   開いたChromeウィンドウでSalonBoardにログインしてください。');
      console.log('   （ログイン完了を自動検知します。最大10分待ちます）');
      let loggedIn = false;
      for (let i = 0; i < 200; i++) {
        await page.waitForTimeout(3000);
        const url = page.url();
        const title = await page.title().catch(() => '');
        if (!url.includes('/login') && !title.includes('ログイン') && !url.startsWith('chrome-error')) {
          loggedIn = true;
          console.log(`   ✅ ログイン検知: ${title}`);
          break;
        }
      }
      if (!loggedIn) {
        console.log('   ⚠️  10分以内にログインを検知できませんでした。もう一度実行してください。');
        return;
      }
    }

    // スケジュールページで最終確認
    await page.waitForTimeout(2000);
    const dateKey = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');
    await page.goto(`https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
      { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const title = await page.title();
    if (title.includes('スケジュール')) {
      console.log('🎉 セッション復活完了！workerがそのまま使えます。');
    } else {
      console.log(`⚠️  スケジュールページに到達できず: ${title}`);
    }
  } finally {
    await context.close();
  }
})().catch(e => { console.error('FATAL:', e.message.split('\n')[0]); process.exit(1); });
