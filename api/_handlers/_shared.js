/**
 * api/_shared.js — 予約ロジック共通定数・関数
 */

const storage = require('../../lib/storage');

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

// 複数メニューの合計所要時間から占有スロットを返す
function getOccupiedSlotsForItems(timeStr, menuItems) {
  const totalMin = (menuItems || []).reduce((s, m) => s + (m.durationMin || 0), 0) || 60;
  const [h, m] = timeStr.split(':').map(Number);
  const startMin = h * 60 + m;
  const slotCount = Math.ceil(totalMin / 30);
  return Array.from({ length: slotCount }, (_, i) => {
    const t = startMin + i * 30;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  });
}

// menuItems から主サービス区分を決定（null=割引等は飛ばす）
function serviceForItems(menuItems) {
  for (const m of (menuItems || [])) {
    if (m.service) return m.service;
  }
  return 'hair';
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

// ストレージから queue を読み込む
async function loadQueue() {
  try {
    const data = await storage.get(QUEUE_KEY);
    return data || [];
  } catch {
    return [];
  }
}

// comingsoon メニュー名 → サービスカテゴリ変換
function menuToCategory(menu) {
  const s = (menu || '').replace(/[\s　]/g, '');
  if (/ホワイトニング/.test(s)) return 'white';
  if (/まつ[毛げ]/.test(s)) return 'lash';
  if (/ヘッドスパ/.test(s)) return 'spa';
  return 'hair'; // カラー・染め・トリートメント etc. すべてhair
}

// comingsoon の timeRange 文字列（例: "9:40-10:30"）から
// ALL_TIMES（30分刻み）と重なる占有スロット一覧を返す。
// off-grid開始（09:40等）でも正しくALL_TIMES槽にカウントされる。
function occupiedFromTimeRange(timeRange, fallbackTime) {
  const m = (timeRange || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (m) {
    const startMin = Number(m[1]) * 60 + Number(m[2]);
    const endMin   = Number(m[3]) * 60 + Number(m[4]);
    if (endMin > startMin) {
      // 予約時間帯 [startMin, endMin) と重なる ALL_TIMES スロットを返す
      return ALL_TIMES.filter(t => {
        const [h, min] = t.split(':').map(Number);
        const slotStart = h * 60 + min;
        return startMin < slotStart + 30 && endMin > slotStart;
      });
    }
  }
  return getOccupiedSlots(fallbackTime, null);
}

module.exports = {
  CAPACITY, MENU_DURATION, ALL_TIMES,
  getOccupiedSlots, normalizeCategory, buildBookedMap, loadQueue, QUEUE_KEY,
  menuToCategory, occupiedFromTimeRange,
  getOccupiedSlotsForItems, serviceForItems,
};
