/**
 * F12_cookie取得.js — ChromeのF12コンソールに貼り付けてCookieを取得する
 *
 * ★ 使い方 ★
 *   1) 普段のChromeで https://salonboard.com にログイン
 *   2) スケジュールページなど salonboard.com のページを開いたまま F12 → Console タブ
 *   3) 下のコードを全部コピーして貼り付け → Enter
 *      （「✅ クリップボードにコピーしました」と出る）
 *   4) このフォルダの cookies_raw.json を開いて全選択 → 貼り付け → 保存
 *   5) Claudeに「更新したよ」と伝える（node cookie変換.js → worker.js --retry を実行します）
 *
 * 注意: document.cookie は httpOnly Cookie を読めないが、
 *       salonboard.com のAkamai系（_abck, bm_sv 等）はJS可読なのでこの方法で動く（2026-06-11実証）
 */

copy(JSON.stringify(
  document.cookie.split('; ').filter(Boolean).map(c => {
    const i = c.indexOf('=');
    return {
      name: c.slice(0, i),
      value: c.slice(i + 1),
      domain: '.salonboard.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 86400, // 仮で24時間
    };
  }),
  null, 2
));
console.log('✅ クリップボードにコピーしました → cookies_raw.json に貼り付けて保存してください');
