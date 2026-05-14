/**
 * api/salonboard.js
 * (salonboard-date.js + slots.js + today-reservations.js を統合)
 *
 * GET /api/salonboard                     → 空き枠データ（slots と同等）
 * GET /api/salonboard?date=YYYY-MM-DD     → 指定日の予約一覧（salonboard-date と同等）
 * GET /api/salonboard?today=1             → 今日のSB予約（today-reservations と同等）
 */

const { head, list } = require('@vercel/blob');
const SLOTS_KEY = 'slots-data.json';

// サービス別の同時予約可能枠数
const CAPACITY = { hair: 6, white: 1, lash: 2, spa: 1 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date, today } = req.query;

  // ── 空き枠データ（認証不要）──────────────────────────────────
  if (!date && !today) {
    try {
      const { blobs } = await list({
        prefix: SLOTS_KEY, limit: 1,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      if (!blobs.length) return res.status(200).json({ updatedAt: null, slots: null });
      const data = await fetch(blobs[0].url).then(r => r.json());

      // ?service=hair などが指定された場合、自社フォーム予約済み枠を差し引く
      const serviceParam = req.query.service;
      if (serviceParam && data.slots) {
        const cap = CAPACITY[serviceParam] || 1;
        try {
          const queueMeta = await head('reservations-queue.json', { token: process.env.BLOB_READ_WRITE_TOKEN });
          if (queueMeta) {
            const queue = await fetch(queueMeta.url).then(r => r.json()).catch(() => []);
            // サービス・日時ごとの予約数を集計
            const booked = {};
            for (const r of queue) {
              if (r.data?.staffCategory === serviceParam && ['pending', 'processing', 'completed'].includes(r.status)) {
                const key = `${r.data.date}:${r.data.time}`;
                booked[key] = (booked[key] || 0) + 1;
              }
            }
            // 満席の時間帯を除外
            for (const dateStr of Object.keys(data.slots)) {
              data.slots[dateStr] = (data.slots[dateStr] || []).filter(time => {
                const key = `${dateStr}:${time}`;
                return (booked[key] || 0) < cap;
              });
            }
          }
        } catch (e) {
          // キュー取得失敗は無視（スロットデータをそのまま返す）
          console.warn('⚠️ キュー取得失敗（スロット差し引きスキップ）:', e.message);
        }
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(data);
    } catch (e) {
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
