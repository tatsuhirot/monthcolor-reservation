/**
 * api/comingsoon.js
 * (comingsoon-today.js + comingsoon-date.js を統合)
 *
 * GET /api/comingsoon              → 今日の予約（comingsoon-today と同等）
 * GET /api/comingsoon?date=YYYY-MM-DD → 指定日の予約（comingsoon-date と同等）
 */

const storage = require('../../lib/storage');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (auth !== (process.env.COMINGSOON_PASSWORD || '').trim()) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  const date = (req.query.date || '').trim();

  try {
    // ?date 省略 → comingsoon-today.json（今日キャッシュ）を使用
    if (!date) {
      const data = await storage.get('comingsoon-today.json');
      if (!data) return res.status(200).json({ updatedAt: null, date: null, reservations: [] });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(data);
    }

    // ?date=YYYY-MM-DD → 日付指定
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: '日付フォーマットが不正です (YYYY-MM-DD)' });
    }
    const data = await storage.get(`comingsoon-${date}.json`);
    if (!data) {
      return res.status(200).json({
        updatedAt: null, date, reservations: [],
        message: 'このデータはまだ同期されていません',
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ updatedAt: null, date: date || null, reservations: [] });
  }
};
