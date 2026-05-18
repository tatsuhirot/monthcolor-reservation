/**
 * api/salonboard.js
 * (salonboard-date.js + slots.js + today-reservations.js を統合)
 *
 * GET /api/salonboard                     → 空き枠データ（slots と同等）
 * GET /api/salonboard?date=YYYY-MM-DD     → 指定日の予約一覧（salonboard-date と同等）
 * GET /api/salonboard?today=1             → 今日のSB予約（today-reservations と同等）
 */

const { head, list } = require('@vercel/blob');
const { CAPACITY, ALL_TIMES, buildBookedMap, loadQueue, normalizeCategory, getOccupiedSlots, menuToCategory, occupiedFromTimeRange } = require('./_shared');

const SLOTS_KEY = 'slots-data.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date, today } = req.query;

  // ── 空き枠データ（認証不要）──────────────────────────────────
  // 情報源1: comingsoon-{date}.json（cs-syncが毎日自動更新、SalonBoard実データ）
  // 情報源2: reservations-queue.json（Web直接予約のpending/processing分）
  if (!date && !today) {
    try {
      const serviceParam = req.query.service;
      const cap = CAPACITY[serviceParam] || 1;
      const token = process.env.BLOB_READ_WRITE_TOKEN;

      // queueとcomingsoonブロブ一覧を並列取得
      const [queue, { blobs: comingsoonBlobs }] = await Promise.all([
        loadQueue(token),
        list({ prefix: 'comingsoon-', token }),
      ]);

      // comingsoon-YYYY-MM-DD.json のみを対象（comingsoon-today.jsonは除外）
      const dateBlobs = comingsoonBlobs.filter(b =>
        /comingsoon-\d{4}-\d{2}-\d{2}\.json$/.test(b.pathname)
      );

      // comingsoonファイルを並列ロード
      const comingsoonDataList = await Promise.all(
        dateBlobs.map(b => fetch(b.url).then(r => r.json()))
      );

      // comingsoonデータからbookedマップを構築
      const booked = {};
      const comingsoonDates = new Set();

      for (const data of comingsoonDataList) {
        if (!data?.date || !Array.isArray(data.reservations)) continue;
        comingsoonDates.add(data.date);
        for (const r of data.reservations) {
          const category = menuToCategory(r.menu);
          if (serviceParam && category !== serviceParam) continue;
          const slots = occupiedFromTimeRange(r.timeRange, r.time);
          for (const slot of slots) {
            const key = `${data.date}:${slot}`;
            booked[key] = (booked[key] || 0) + 1;
          }
        }
      }

      // queueエントリを追加:
      // - pending/processing: comingsoon未反映の可能性があるため常に加算
      // - completed: comingsoonが存在しない日付のみ加算（二重計上を防ぐ）
      for (const r of queue) {
        const isPendingOrProcessing = ['pending', 'processing'].includes(r.status);
        const isCompletedUncovered = r.status === 'completed' && !comingsoonDates.has(r.data?.date);
        if (!isPendingOrProcessing && !isCompletedUncovered) continue;
        const category = normalizeCategory(r.data?.staffCategory);
        if (serviceParam && category !== serviceParam) continue;
        const occupied = getOccupiedSlots(r.data.time, r.data.menuId);
        for (const slot of occupied) {
          const key = `${r.data.date}:${slot}`;
          booked[key] = (booked[key] || 0) + 1;
        }
      }

      // 今日から2ヶ月分の空き時間を計算
      const slots = {};
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      for (let d = new Date(now); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        slots[dateStr] = ALL_TIMES.filter(t => (booked[`${dateStr}:${t}`] || 0) < cap);
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ updatedAt: new Date().toISOString(), slots });
    } catch (e) {
      console.error('⚠️ 空き枠計算エラー:', e.message);
      return res.status(200).json({ updatedAt: null, slots: null });
    }
  }

  // 以下は認証あり
  const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (auth !== (process.env.COMINGSOON_PASSWORD || '').trim()) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  // ── 今日のSB予約（?today=1）─────────────────────────────────
  if (today) {
    try {
      const blob = await head('today-reservations.json', {
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      if (!blob) return res.status(200).json({ updatedAt: null, date: null, reservations: [] });
      const data = await fetch(blob.url).then(r => r.json());
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(data);
    } catch (e) {
      return res.status(200).json({ updatedAt: null, date: null, reservations: [] });
    }
  }

  // ── 指定日の予約（?date=YYYY-MM-DD）──────────────────────────
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date パラメータが必要です (YYYY-MM-DD)' });
  }
  const month = date.slice(0, 7);
  try {
    const meta = await head(`salonboard-${month}.json`, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!meta) {
      return res.status(200).json({
        date, reservations: [],
        message: 'データ未取得。GitHub Actions（sync_slots.js）の実行が必要です。',
      });
    }
    const data = await fetch(meta.url).then(r => r.json());
    const reservations = (data.reservations || {})[date] || [];
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ date, updatedAt: data.updatedAt, reservations });
  } catch (e) {
    return res.status(200).json({ date, reservations: [], error: e.message });
  }
};
