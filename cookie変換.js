/**
 * cookie変換.js — Cookie-Editorの「Export as JSON」を Playwright storageState に変換
 *
 * ★ 使い方 ★
 *   1) 普段のChromeでSalonBoardにログイン
 *   2) Cookie-Editor → Export → Export as JSON
 *   3) このフォルダの cookies_raw.json に貼り付けて保存
 *   4) node cookie変換.js
 *   → memo.txt と .state/salonboard.json を更新
 *
 * Cookie-Editor形式 { name, value, domain, path, secure, httpOnly,
 *   expirationDate(秒), sameSite } を Playwright形式に正規化する。
 */
const fs = require('fs');
const path = require('path');

const rawPath   = path.join(__dirname, 'cookies_raw.json');
const memoPath  = path.join(__dirname, 'memo.txt');
const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');

if (!fs.existsSync(rawPath)) {
  console.error('❌ cookies_raw.json が見つかりません。Cookie-Editorのexportを貼り付けて保存してください。');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
const list = Array.isArray(raw) ? raw : (raw.cookies || []);

const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };

const cookies = list.map(c => {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: sameSiteMap[String(c.sameSite || '').toLowerCase()] || 'Lax',
  };
  // 有効期限: Cookie-Editorは秒。session cookieはexpirationDateなし → -1
  if (typeof c.expirationDate === 'number') {
    out.expires = Math.round(c.expirationDate);
  } else if (typeof c.expires === 'number') {
    out.expires = Math.round(c.expires);
  } else {
    out.expires = -1;
  }
  return out;
});

const state = { cookies, origins: [] };

if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
const json = JSON.stringify(state, null, 2);
fs.writeFileSync(statePath, json);
fs.writeFileSync(memoPath, json);

const sb = cookies.filter(c => String(c.domain).includes('salonboard'));
console.log(`✅ 変換完了: Cookie ${cookies.length}件（うち salonboard 系 ${sb.length}件）`);
console.log('   → memo.txt と .state/salonboard.json を更新しました。');
const key = ['_abck', 'bm_sv', 'GalileoCookie', 'R2SESSIONID_CNC', 'HPB_SB_USER_ID'];
const have = key.filter(k => cookies.some(c => c.name === k));
console.log(`   重要Cookie確認: ${have.join(', ') || 'なし(要注意)'}`);
console.log('\n   続けて「node worker.js」で予約登録を実行できます。');
