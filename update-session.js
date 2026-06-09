/**
 * update-session.js — SalonBoardセッションを手動更新してVPSに転送
 *
 * ★ 週1回ローカルPCで実行してください ★
 *   （どのPCからでもOK。SSH不要）
 *
 * 使い方:
 *   node update-session.js
 *
 * 必要な .env 設定:
 *   SALONBOARD_LOGIN_ID=xxxxx
 *   SALONBOARD_PASSWORD=xxxxx
 *   VPS_URL=https://your-vps-domain.com   （例: https://monthcolor.com）
 *   SYNC_TRIGGER_SECRET=hpb-sync-2026
 */

require('dotenv').config();
const { firefox } = require('playwright');
const path = require('path');
const fs   = require('fs');

const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');

const VPS_URL = process.env.VPS_URL || 'http://160.251.171.167:3001';
const SECRET  = process.env.SYNC_TRIGGER_SECRET;

async function main() {
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  // ── ① ブラウザでSalonBoardにログイン ──────────────────────────
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

  // ── ② VPSにHTTP POSTでアップロード ───────────────────────────
  console.log(`☁️  VPSにアップロード中... (${VPS_URL})`);
  const session = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  const res = await fetch(`${VPS_URL}/api/upload-session`, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'x-sync-secret': SECRET || '',
    },
    body: JSON.stringify({ session }),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'アップロード失敗');

  console.log('✅ 完了！ 次回更新は1週間後でOKです。');
}

main().catch(e => {
  console.error('❌ エラー:', e.message);
  process.exit(1);
});
