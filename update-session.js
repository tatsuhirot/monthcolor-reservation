/**
 * update-session.js — SalonBoardセッションを手動更新してVPSに転送
 *
 * ★ 週1回ローカルPCで実行してください ★
 *   Windows: セッション更新.bat をダブルクリック
 *   Mac:     セッション更新.command をダブルクリック
 *
 * 必要な .env 設定（パスワードは不要）:
 *   SALONBOARD_LOGIN_ID=xxxxx
 *   VPS_URL=http://160.251.171.167:3001
 *   SYNC_TRIGGER_SECRET=hpb-sync-2026
 */

require('dotenv').config();
const { firefox } = require('playwright');
const readline    = require('readline');
const path        = require('path');
const fs          = require('fs');

const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const VPS_URL   = process.env.VPS_URL   || 'http://160.251.171.167:3001';
const SECRET    = process.env.SYNC_TRIGGER_SECRET;

// ── パスワードを非表示入力で取得 ──────────────────────────────────
function promptPassword(label) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(label);

    let password = '';
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (ch) => {
      switch (ch) {
        case '\r':
        case '\n':
        case '': // Ctrl+D
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(password);
          break;
        case '': // Ctrl+C
          process.exit();
          break;
        case '': // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          password += ch;
          process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

// ── メイン処理 ──────────────────────────────────────────────────
async function main() {
  console.log('\n====================================');
  console.log('  SalonBoard セッション更新ツール');
  console.log('====================================\n');

  const loginId = process.env.SALONBOARD_LOGIN_ID;
  if (!loginId) {
    console.error('❌ .env に SALONBOARD_LOGIN_ID が設定されていません');
    process.exit(1);
  }

  const password = await promptPassword('🔑 SalonBoardのパスワードを入力してください: ');
  if (!password) {
    console.error('❌ パスワードが入力されていません');
    process.exit(1);
  }

  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  // ── ① ブラウザでSalonBoardにログイン ────────────────────────
  console.log('\n🌐 SalonBoardにログイン中... (ブラウザが開きます)');
  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto('https://salonboard.com/login_sp/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[name="userId"]',   loginId);
  await page.fill('input[type="password"]', password);
  await page.click('.loginBtnSize');

  console.log('⏳ ログイン確認中...');
  await page.waitForURL('**/CLS/**', { timeout: 30000 });

  await context.storageState({ path: statePath });
  await browser.close();
  console.log('💾 セッション保存完了');

  // ── ② VPSにHTTP POSTでアップロード ─────────────────────────
  console.log(`☁️  VPSにアップロード中... (${VPS_URL})`);
  const session = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  const res = await fetch(`${VPS_URL}/api/upload-session`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-sync-secret': SECRET || '',
    },
    body: JSON.stringify({ session }),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'アップロード失敗');

  console.log('\n✅ 完了！ 次回更新は1週間後でOKです。\n');
}

main().catch(e => {
  console.error('\n❌ エラー:', e.message);
  process.exitCode = 1;
});
