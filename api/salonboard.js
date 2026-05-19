/**
 * api/salonboard.js
 * (salonboard-date.js + slots.js + today-reservations.js を統合)
 *
 * GET /api/salonboard                     → 空き枠データ（slots と同等）
 * GET /api/salonboard?date=YYYY-MM-DD     → 指定日の予約一覧（salonboard-date と同等）
 * GET /api/salonboard?today=1             → 今日のSB予約（today-reservations と同等）
 */

const { head } = require('@vercel/blob');
const { CAPACITY, ALL_TIMES, buildBookedMap, loadQueue, normalizeCategory, occupiedFromTimeRange } = require('./_shared');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date, today } = req.query;

  // ── 空き枠データ（認証不要）──────────────────────────────────
  // ベース: salonboard-{month}.json の実予約件数 ÷ capacity で空き判定
  // 追加差し引き: reservations-queue.json（このシステム経由の予約）
  if (!date && !today) {
    try {
      const serviceParam = req.query.service;
      const cap = CAPACITY[serviceParam] || 1;
      const token = process.env.BLOB_READ_WRITE_TOKEN;

      const now = new Date(); now.setHours(0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);

      // 対象月を列挙（今月 + 来月）
      const months = new Set();
      for (let d = new Date(now); d <= end; d.setDate(d.getDate() + 1)) {
        months.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
      }

      // salonboard-{month}.json から予約件数を集計
      // bookedSB["YYYY-MM-DD:HH:MM"] = count（SalonBoard 実予約）
      const bookedSB = {};
      let updatedAt = null;
      for (const month of months) {
        try {
          const meta = await head(`salonboard-${month}.json`, { token });
          if (!meta) continue;
          const data = await fetch(meta.url).then(r => r.json());
          if (!updatedAt) updatedAt = data.updatedAt;
          for (const [dateStr, rsvs] of Object.entries(data.reservations || {})) {
            for (const r of rsvs) {
              // メニュー名からサービスカテゴリを判定
              const cat = normalizeCategory(r.menuName || '');
              if (serviceParam && cat !== serviceParam) continue;
              // 占有スロットを計算（timeRange 優先）
              const occupied = occupiedFromTimeRange(r.timeRange, r.time);
              for (const slot of occupied) {
                const key = `${dateStr}:${slot}`;
                bookedSB[key] = (bookedSB[key] || 0) + 1;
              }
            }
          }
        } catch (e) {
          console.warn(`⚠️ salonboard-${month}.json 取得失敗:`, e.message);
        }
      }

      // queue 予約もさらに差し引く
      const queue = await loadQueue(token);
      const bookedQueue = buildBookedMap(queue, serviceParam);

      const slots = {};
      for (let d = new Date(now); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        slots[dateStr] = ALL_TIMES.filter(t => {
          const key = `${dateStr}:${t}`;
          return (bookedSB[key] || 0) + (bookedQueue[key] || 0) < cap;
        });
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ updatedAt: updatedAt || new Date().toISOString(), slots });
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
