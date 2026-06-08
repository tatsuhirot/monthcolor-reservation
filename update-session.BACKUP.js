/**
 * update-session.js — SalonBoardセッションを手動更新してVPSに転送
 *
 * ★ 週1回ローカルPCで実行してください ★
 *
 * 使い方:
 *   node update-session.js
 *
 * ※ このファイルは編集しないでください
 */

require('dotenv').config();
const { firefox } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const VPS_IP    = '160.251.171.167';
const VPS_KEY   = 'C:/Users/tatsu/.ssh/key-2026-05-20-06-01.pem';
const VPS_DEST  = `root@${VPS_IP}:~/hpb-calendar/.state/salonboard.json`;

async function main() {
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  console.log('🌐 SalonBoardにログイン中... (ブラウザが開きます)');

  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[name="userId"]',   process.env.SALONBOARD_LOGIN_ID);
  await page.fill('input[type="password"]', process.env.SALONBOARD_PASSWORD);
  await page.click('.loginBtnSize');

  console.log('⏳ ログイン中...');
  await page.waitForURL('**/CLS/**', { timeout: 30000 });

  await context.storageState({ path: statePath });
  await browser.close();
  console.log('💾 セッション保存完了');

  console.log('☁️  VPSに転送中...');
  execSync(`scp -i "${VPS_KEY}" "${statePath}" "${VPS_DEST}"`, { stdio: 'inherit' });
  console.log('✅ 完了！ 次回更新は1週間後でOKです。');
}

main().catch(e => {
  console.error('❌ エラー:', e.message);
  process.exit(1);
});
