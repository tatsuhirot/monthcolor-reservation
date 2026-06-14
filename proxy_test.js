/**
 * proxy_test.js — Stage 1: 住宅IPプロキシ経由でSalonBoardに到達できるか実験する
 *
 * ★ 事前準備 ★
 *   .env に以下を追記（プロバイダのダッシュボードからコピー）:
 *     PROXY_SERVER=http://ホスト:ポート
 *     PROXY_USERNAME=ユーザー名
 *     PROXY_PASSWORD=パスワード
 *   ※ sticky session（同一IP 30分維持）+ 国=Japan の設定で発行すること
 *
 * ★ 実行 ★
 *   node proxy_test.js
 *
 * ★ 判定の流れ ★
 *   Test A: 出口IPの確認（日本の住宅IPになっているか）
 *   Test B: salonboard.com ログインページが開くか（Akamaiの門前払いチェック）
 *   Test C: 手動ログイン → スケジュールページが開くか（実用性チェック）
 *
 * ※ 本番プロファイル(.state/chrome-profile)は使わない。実験専用の
 *   .state/chrome-profile-proxy を使うので、いまの正常なセッションには影響しない。
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const PROFILE_DIR = path.join(__dirname, '.state', 'chrome-profile-proxy');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

(async () => {
  const server = process.env.PROXY_SERVER;
  if (!server) {
    console.error('❌ .env に PROXY_SERVER がありません。');
    console.error('   PROXY_SERVER=http://ホスト:ポート');
    console.error('   PROXY_USERNAME=ユーザー名');
    console.error('   PROXY_PASSWORD=パスワード  を追記してください。');
    process.exit(1);
  }

  console.log(`🌐 プロキシ経由で実験用Chrome起動 (${server})`);
  console.log(`   プロファイル: ${PROFILE_DIR}（本番とは別）\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    proxy: {
      server,
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined,
    },
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    // ── Test A: 出口IPの確認 ──────────────────────────────────────
    console.log('── Test A: 出口IPの確認 ──');
    try {
      await page.goto('https://ipinfo.io/json', { timeout: 45_000 });
      const info = JSON.parse(await page.evaluate(() => document.body.innerText));
      console.log(`   IP: ${info.ip} / 国: ${info.country} / 地域: ${info.region} ${info.city}`);
      console.log(`   回線(org): ${info.org}`);
      if (info.country !== 'JP') console.log('   ⚠️  日本のIPではありません！プロバイダ側で国=Japanを指定してください');
      else console.log('   ✅ 日本のIPです');
      console.log('   ※ orgがNTT/KDDI/SoftBank等の一般ISPなら住宅IP。Amazon/Google/DataCamp等ならデータセンターIP（NG）');
    } catch (e) {
      console.log(`   ❌ プロキシ経由で外に出られません: ${e.message.split('\n')[0]}`);
      console.log('   → PROXY_SERVER/USERNAME/PASSWORD を確認してください');
      return;
    }

    // ── Test B: SalonBoard 門前払いチェック ──────────────────────
    console.log('\n── Test B: salonboard.com に到達できるか ──');
    try {
      await page.goto('https://salonboard.com/login/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const title = await page.title();
      if (page.url().startsWith('chrome-error')) throw new Error('接続リセット');
      console.log(`   ✅ 到達成功: ${title}`);
    } catch (e) {
      console.log(`   ❌ ブロックされました: ${e.message.split('\n')[0]}`);
      console.log('   → このプロキシではStage 1失敗。別プロバイダを試すか、ミニPC案に集中');
      return;
    }

    // ── Test C: 手動ログイン → スケジュールページ ─────────────────
    // Enter入力は使わず、ログイン完了（URLが/loginから離れる）を自動検知する
    console.log('\n── Test C: 手動ログイン ──');
    console.log('   開いているChromeウィンドウでSalonBoardにログインしてください。');
    console.log('   （ログイン完了を自動検知します。最大10分待ちます）');
    let loggedIn = false;
    for (let i = 0; i < 200; i++) {
      await page.waitForTimeout(3000);
      const url = page.url();
      const title = await page.title().catch(() => '');
      if (!url.includes('/login') && !title.includes('ログイン') && !url.startsWith('chrome-error')) {
        loggedIn = true;
        console.log(`   ✅ ログイン検知: ${title} (${url.slice(0, 60)})`);
        break;
      }
    }
    if (!loggedIn) {
      console.log('   ⚠️  10分以内にログインを検知できませんでした。もう一度実行してください。');
      return;
    }
    await page.waitForTimeout(2000);

    const dateKey = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');
    await page.goto(`https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
      { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const result = await page.evaluate(() => ({
      title: document.title,
      expired: (document.body?.innerText || '').includes('ログインの有効期限'),
    }));
    if (result.title.includes('スケジュール') && !result.expired) {
      console.log(`   ✅ スケジュールページ表示成功！（${result.title}）`);
      console.log('\n🎉 Stage 1 合格！このプロキシはSalonBoardに使える可能性が高いです。');
      console.log('   セッションはプロファイルに保存されました。次は同じ設定で');
      console.log('   check_session.js → 軽い自動アクセスを数日試して安定性を確認します。');
    } else {
      console.log(`   ⚠️  スケジュールページに到達できず（${result.title}）`);
      console.log('   ログインが完了しているか確認して、もう一度実行してください。');
    }
  } finally {
    await context.close();
  }
})().catch(e => { console.error('FATAL:', e.message.split('\n')[0]); process.exit(1); });
