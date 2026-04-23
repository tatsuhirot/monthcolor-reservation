/**
 * parse_calendar.js
 * hpb-reserve-calendar.html を解析して予約枠データをJSON出力する
 *
 * 使い方:
 *   node parse_calendar.js [HTMLファイルパス]
 *   node parse_calendar.js hpb-reserve-calendar.html
 */

const fs = require('fs');
const path = require('path');

const htmlPath = process.argv[2] || path.join(__dirname, 'hpb-reserve-calendar.html');

function parseCalendar(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const reservations = [];
  const emptySlots = [];

  // ── 1. 空き枠を抽出 ───────────────────────────────────────
  // id="empty_time_sid_fix_20260514_0930_T000779306_0"
  const emptyRe = /id="empty_time_sid_fix_(\d{8})_(\d{4})_(T\d+)_(\d+)"/g;
  let m;
  const seen = new Set();
  while ((m = emptyRe.exec(html)) !== null) {
    const key = `${m[1]}_${m[2]}_${m[3]}_${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emptySlots.push({
      date: formatDate(m[1]),       // "2026-05-14"
      time: formatTime(m[2]),       // "09:30"
      stylistId: m[3],              // "T000779306"
      seat: m[4],                   // "0"
      slotId: `empty_time_sid_fix_${m[1]}_${m[2]}_${m[3]}_${m[4]}`,
    });
  }

  // ── 2. 既存予約を抽出 ─────────────────────────────────────
  // 各 reserve_item_* ブロックの隠しspanから取得
  const reserveBlockRe = /id="(reserve_item_\w+)"([\s\S]*?)(?=id="reserve_item_|id="empty_time_|$)/g;
  while ((m = reserveBlockRe.exec(html)) !== null) {
    const blockId = m[1];
    const block = m[2];

    const hpbId       = extract(block, 'panel_reserve_id');
    const date        = extract(block, 'panel_reserve_date');
    const start       = extract(block, 'panel_reserve_start');
    const stylistId   = extract(block, 'panel_reserve_stylistId');
    const registered  = extract(block, 'panel_reserve_registeredFlg');
    const customer    = extractCustomer(block);

    if (!hpbId) continue;

    reservations.push({
      hpbId,
      date: formatDate(date),
      time: formatTime(start),
      stylistId,
      customer,
      registered: registered === '1',
      blockId,
    });
  }

  // 時間順ソート
  emptySlots.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  reservations.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  return { reservations, emptySlots };
}

// ── ヘルパー ─────────────────────────────────────────────────

function extract(block, className) {
  const re = new RegExp(`class="${className}[^"]*"[^>]*>([^<]*)<`);
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function extractCustomer(block) {
  const re = /class="[^"]*reserveItemCustomer[^"]*">([^<]+)</;
  const m = block.match(re);
  return m ? m[1].trim() : '不明';
}

function formatDate(raw) {
  // "20260514" → "2026-05-14"
  if (!raw || raw.length !== 8) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function formatTime(raw) {
  // "0930" → "09:30"
  if (!raw || raw.length !== 4) return raw;
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
}

// ── メイン ───────────────────────────────────────────────────

const result = parseCalendar(htmlPath);

console.log('\n=== 既存予約 (' + result.reservations.length + '件) ===');
for (const r of result.reservations) {
  const status = r.registered ? '✅登録済' : '⚠️未登録';
  console.log(`  ${r.date} ${r.time}  ${r.customer}  [${r.hpbId}]  ${status}`);
}

console.log('\n=== 空き枠 (' + result.emptySlots.length + '件) ===');
// 重複の多い空き枠は省略して先頭20件のみ表示
for (const s of result.emptySlots.slice(0, 20)) {
  console.log(`  ${s.date} ${s.time}  stylist:${s.stylistId}`);
}
if (result.emptySlots.length > 20) {
  console.log(`  ...他 ${result.emptySlots.length - 20} 件`);
}

// JSON出力
const outPath = path.join(__dirname, 'calendar_data.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(`\n✅ ${outPath} に保存しました`);
