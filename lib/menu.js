// lib/menu.js — メニューCSV(CP932)テキストを構造化する純粋関数群

const CATEGORY_DEFAULT_DURATION = [
  [/リタッチ|根元染め/, 70],
  [/全体染め.*(ロング|ダブルロング)/, 120],
  [/全体染め/, 90],
  [/カラー＋|カラーキープ|プレミアム/, 90],
  [/トリートメント/, 30],
  [/まつ[毛げ]/, 60],
  [/ヘッドスパ/, 60],
];

function serviceForCategory(category) {
  const s = (category || '').replace(/[\s　]/g, '');
  if (/割引|補正/.test(s)) return null;
  if (/ホワイトニング/.test(s)) return 'white';
  if (/まつ[毛げ]/.test(s)) return 'lash';
  if (/ヘッドスパ/.test(s)) return 'spa';
  return 'hair';
}

function durationForMenu(category, name) {
  if (serviceForCategory(category) === null) return 0;
  const m = (name || '').match(/(\d+)分/);
  if (m) return parseInt(m[1], 10);
  for (const [re, dur] of CATEGORY_DEFAULT_DURATION) {
    if (re.test(category || '')) return dur;
  }
  return 60;
}

// CSV1行を "..." 区切りでパース（フィールド内カンマは想定しない単純CSV）
function parseCsvLine(line) {
  return [...line.matchAll(/"((?:[^"])*)"/g)].map(m => m[1]);
}

function parseMenuCsv(csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {            // 0行目はヘッダ
    const c = parseCsvLine(lines[i]);
    if (c.length < 5 || !c[0]) continue;
    const category = c[1];
    const name = c[2];
    out.push({
      code: c[0],
      category,
      name,
      priceIncTax: parseInt(c[3], 10) || 0,
      priceExTax: parseInt(c[4], 10) || 0,
      defaultQty: parseInt(c[5], 10) || 1,
      service: serviceForCategory(category),
      durationMin: durationForMenu(category, name),
    });
  }
  return out;
}

module.exports = { parseMenuCsv, serviceForCategory, durationForMenu };
