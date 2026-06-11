/**
 * cookie更新.js — 実Chromeで手動ログイン → セッションを memo.txt / .state に保存
 *
 * ★ 使い方 ★
 *   node cookie更新.js
 *   1) 実Chromeが開く → SalonBoardに「手動で」ログインする（Akamai/キャプチャは人が突破）
 *   2) スケジュール画面まで入れたら、ターミナルに戻って Enter を押す
 *   3) memo.txt と .state/salonboard.json が更新される
 *
 * ※ worker.js と同じ実Chrome（channel:'chrome'）で取得するので
 *   Akamaiのフィンガープリント照合に通る。自動入力はしない（Akamai対策）。
 */
require('dotenv').config();
const { chromium } = require('playwright');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const memoPath  = path.join(__dirname, 'memo.txt');

function waitEnter(msg) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

(async () => {
  console.log('\n==============================================');
  console.log('  SalonBoard セッション更新（実Chrome・手動ログイン）');
  console.log('==============================================\n');

  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('🌐 Chromeが開きました。');
  console.log('   → SalonBoardに「手動で」ログインしてください。');
  console.log('   → スケジュール画面まで入れたら、ここに戻って Enter を押してください。\n');

  await waitEnter('✅ ログインできたら Enter ▶ ');

  // 念のため現在のページがエラー/ログイン画面でないか確認
  const status = await page.evaluate(() => {
    const title = document.title || '';
    const body = document.body ? document.body.innerText : '';
    const expired = title.includes('エラー') || body.includes('ログインの有効期限が切れ');
    const onLogin = location.href.includes('/login');
    return { url: location.href, title, expired, onLogin };
  }).catch(() => ({ url: page.url(), title: '?', expired: false, onLogin: false }));

  if (status.onLogin || status.expired) {
    console.log(`\n⚠️ まだログインできていないようです（${status.title} / ${status.url}）`);
    console.log('   ログインを完了してから、もう一度 Enter を押してください。');
    await waitEnter('✅ ログイン完了で Enter ▶ ');
  }

  await context.storageState({ path: statePath });
  fs.copyFileSync(statePath, memoPath);
  await browser.close();

  const n = JSON.parse(fs.readFileSync(statePath, 'utf-8')).cookies.length;
  console.log(`\n💾 セッション保存完了（Cookie ${n}件）`);
  console.log('   → .state/salonboard.json と memo.txt を更新しました。');
  console.log('   → 続けて「node worker.js」で予約登録を実行できます。\n');
})().catch(e => { console.error('\n❌ エラー:', e.message); process.exit(1); });
