/**
 * api/_shared.js — 予約ロジック共通定数・関数
 */

const { head } = require('@vercel/blob');

const QUEUE_KEY = 'reservations-queue.json';

// サービス別の同時予約可能枠数
const CAPACITY = { hair: 6, white: 1, lash: 2, spa: 1 };

// メニュー別施術時間（分）
const MENU_DURATION = {
  h1: 70, h2: 90, h3: 90, h4: 120,
  w1: 30, w2: 60,
  l1: 60, l2: 75,
  s1: 30, s2: 60, s3: 90,
};

// 予約フォームで選択できる全時間帯（30分刻み）
const ALL_TIMES = [
  '09:00','09:30','10:00','10:30','11:00','11:30',
  '12:00','12:30','13:00','13:30','14:00','14:30',
  '15:00','15:30','16:00','16:30','17:00','17:30',
  '18:00','18:30','19:00',
];

// 開始時刻と施術時間から占有スロット一覧を返す
// 例: ('10:00', 'h4') → ['10:00','10:30','11:00','11:30']
function getOccupiedSlots(timeStr, menuId) {
  const durationMin = MENU_DURATION[menuId] || 60;
  const [h, m] = timeStr.split(':').map(Number);
  const startMin = h * 60 + m;
  const slotCount = Math.ceil(durationMin / 30);
  return Array.from({ length: slotCount }, (_, i) => {
    const t = startMin + i * 30;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  });
}

// staffCategory の正規化（旧データ互換: "ヘア　カラー" → "hair" 等）
function normalizeCategory(raw) {
  if (['hair', 'white', 'lash', 'spa'].includes(raw)) return raw;
  const s = (raw || '').replace(/[\s　]/g, '');
  if (/ホワイトニング/.test(s))               return 'white';
  if (/まつ[毛げ]|ラッシュ/.test(s))          return 'lash';
  if (/ヘッドスパ|スパ/.test(s))              return 'spa';
  if (/ヘア|カラー/.test(s))                  return 'hair';
  return null; // 判定不能
}

// queue から (date, time) ごとの予約数を集計して返す
// 戻り値: { "YYYY-MM-DD:HH:MM": count }
function buildBookedMap(queue, serviceParam) {
  const booked = {};
  for (const r of queue) {
    const category = normalizeCategory(r.data?.staffCategory);
    if (serviceParam && category !== serviceParam) continue;
    if (!['pending', 'processing', 'completed'].includes(r.status)) continue;
    const slots = getOccupiedSlots(r.data.time, r.data.menuId);
    for (const slot of slots) {
      const key = serviceParam
        ? `${r.data.date}:${slot}`
        : `${r.data.staffCategory}:${r.data.date}:${slot}`;
      booked[key] = (booked[key] || 0) + 1;
    }
  }
  return booked;
}

// Blob から queue を読み込む
async function loadQueue(token) {
  try {
    const blob = await head(QUEUE_KEY, { token });
    if (!blob) return [];
    const res = await fetch(blob.url);
    return await res.json();
  } catch {
    return [];
  }
}

module.exports = { CAPACITY, MENU_DURATION, ALL_TIMES, getOccupiedSlots, buildBookedMap, loadQueue, QUEUE_KEY };
