// scripts/import_menu_master.js
// 使い方: node scripts/import_menu_master.js "_temp/items_MONTH COLOR_20260615.csv"
//        --preview を付けると保存せず先頭を表示
require('dotenv').config();
const fs = require('fs');
const storage = require('../lib/storage');
const { parseMenuCsv } = require('../lib/menu');

const MENU_KEY = 'menu-master.json';

(async () => {
  const file = process.argv[2];
  const preview = process.argv.includes('--preview');
  if (!file) { console.error('CSVパスを渡してください'); process.exit(1); }

  const buf = fs.readFileSync(file);
  const text = new TextDecoder('shift_jis').decode(buf);
  const rows = parseMenuCsv(text);
  console.log(`変換: ${rows.length}件 / 分類 ${new Set(rows.map(r => r.category)).size}種`);

  if (preview) { console.log(JSON.stringify(rows.slice(0, 5), null, 2)); return; }
  await storage.put(MENU_KEY, JSON.stringify(rows, null, 2));
  console.log(`✅ ${MENU_KEY} に保存しました`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
