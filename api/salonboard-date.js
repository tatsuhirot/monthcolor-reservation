/**
 * api/salonboard-date.js
 * GET /api/salonboard-date?date=YYYY-MM-DD
 * SalonBoard の指定日予約一覧を返す（月別 Blob キャッシュから取得）
 *
 * データは sync_slots.js / GitHub Actions が毎日保存する salonboard-YYYY-MM.json を参照。
 */

const { head } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (auth !== (process.env.COMINGSOON_PASSWORD || process.env.ADMIN_PASSWORD || '').trim()) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date パラメータが必要です (YYYY-MM-DD)' });
  }

  const month = date.slice(0, 7); // YYYY-MM

  try {
    const meta = await head(`salonboard-${month}.json`, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!meta) {
      return res.status(200).json({
        date,
        reservations: [],
        message: 'データ未取得。GitHub Actions（sync_slots.js）の実行が必要です。',
      });
    }

    const data = await fetch(meta.url).then(r => r.json());
    const reservations = (data.reservations || {})[date] || [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      date,
      updatedAt: data.updatedAt,
      reservations,
    });
  } catch (e) {
    return res.status(200).json({ date, reservations: [], error: e.message });
  }
};
