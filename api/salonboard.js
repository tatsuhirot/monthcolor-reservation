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
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
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
