/**
 * update-session.js — SalonBoardセッションを手動更新してGitHub Secretsに登録
 *
 * 使い方（週1回ローカルで実行）:
 *   node update-session.js
 *
 * 前提:
 *   - gh CLI がインストール済み (https://cli.github.com/)
 *   - gh auth login 済み
 */

require('dotenv').config();
const { firefox } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const REPO      = 'tatsuhirot/monthcolor-reservation';

async function main() {
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  console.log('🌐 SalonBoardにログイン中... (ブラウザが開きます)');

  const browser = await firefox.launch({ headless: false }); // 見えるブラウザ
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // ログインフォームに入力
  await page.fill('input[name="userId"]', process.env.SALONBOARD_LOGIN_ID);
  await page.fill('input[type="password"]', process.env.SALONBOARD_PASSWORD);

  // 手動でログインボタンを押してもらう（または自動クリック）
  console.log('⏳ ブラウザでログインしてください。ログイン後、Enterキーを押してください...');
  await page.click('.loginBtnSize').catch(() => null);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('ログイン完了したらEnterを押してください: ', () => { rl.close(); resolve(); }));

  // セッションを保存
  await context.storageState({ path: statePath });
  await browser.close();

  const sessionJson = fs.readFileSync(statePath, 'utf-8');
  const base64 = Buffer.from(sessionJson).toString('base64');

  console.log('☁️  GitHub Secretsに登録中...');
  try {
    execSync(`gh secret set SALONBOARD_SESSION --body "${base64}" --repo ${REPO}`, { stdio: 'inherit' });
    console.log('✅ SALONBOARD_SESSION を更新しました！');
  } catch (e) {
    console.error('❌ gh CLI エラー。手動でGitHub Secretsに登録してください:');
    console.log('Secret名: SALONBOARD_SESSION');
    console.log('値（base64）:', base64.slice(0, 80) + '...');
  }
}

main().catch(console.error);
