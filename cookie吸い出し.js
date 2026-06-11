/**
 * cookie吸い出し.js — 普段使いのChromeプロファイルから SalonBoard の Cookie を直接読む
 *
 * SalonBoardにはアクセスしない（Akamaiに触れない）。
 * Chromeが内部で復号した状態のCookieを Playwright 経由で取得し、
 * memo.txt / .state/salonboard.json に保存する。
 *
 * ★ 使い方 ★
 *   1) Chromeを「完全に」終了する（タスクトレイ含め全ウィンドウ閉じる）
 *   2) node cookie吸い出し.js            … Default プロファイル
 *      node cookie吸い出し.js "Profile 1" … 別プロファイル指定
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const profile   = process.argv[2] || 'Default';
const userData  = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const memoPath  = path.join(__dirname, 'memo.txt');

(async () => {
  if (!fs.existsSync(userData)) { console.error('❌ Chrome User Data が見つかりません:', userData); process.exit(1); }
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  console.log(`🌐 Chromeプロファイル「${profile}」を開いてCookieを読み取ります...`);
  console.log('   （Chromeが完全に終了していないとロックで失敗します）\n');

  let context;
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chrome',
      headless: false,
      args: [`--profile-directory=${profile}`],
    });
  } catch (e) {
    console.error('❌ 起動失敗:', e.message);
    console.error('   → Chromeを完全に終了してから、もう一度実行してください。');
    process.exit(1);
  }

  // SalonBoardドメインのCookieを取得（アクセスはしない）
  const all = await context.cookies();
  await context.close();

  const sb = all.filter(c => /salonboard\.com$/.test(c.domain) || c.domain.includes('salonboard'));
  if (!sb.length) {
    console.error('\n❌ salonboard.com のCookieが見つかりませんでした。');
    console.error('   → このプロファイルでSalonBoardにログイン済みか確認してください。');
    console.error('   → 別プロファイルなら: node cookie吸い出し.js "Profile 1"');
    process.exit(1);
  }

  const state = { cookies: sb, origins: [] };
  const json = JSON.stringify(state, null, 2);
  fs.writeFileSync(statePath, json);
  fs.writeFileSync(memoPath, json);

  console.log(`\n💾 保存完了: salonboard Cookie ${sb.length}件`);
  const key = ['_abck', 'bm_sv', 'GalileoCookie', 'R2SESSIONID_CNC', 'HPB_SB_USER_ID'];
  const have = key.filter(k => sb.some(c => c.name === k));
  console.log(`   重要Cookie: ${have.join(', ') || '(なし・要注意)'}`);
  console.log('   → memo.txt / .state/salonboard.json を更新しました。');
  console.log('\n   続けて「node worker.js」で予約登録を実行できます。');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
