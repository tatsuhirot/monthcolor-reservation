/**
 * api/comingsoon-today.js
 * GET /api/comingsoon-today
 * スタッフ用: 1cs.jp (coming-soon) から取得した今日の予約一覧を返す（パスワード認証付き）
 *
 * データは sync_comingsoon.js が comingsoon-today.json として Blob に保存する。
 */

const { head } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (auth !== (process.env.ADMIN_PASSWORD || '').trim()) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  try {
    const blob = await head('comingsoon-today.json', {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!blob) {
      return res.status(200).json({ updatedAt: null, date: null, reservations: [] });
    }
    const data = await fetch(blob.url).then(r => r.json());
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ updatedAt: null, date: null, reservations: [] });
  }
};
