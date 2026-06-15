// api/menu.js — GET /api/menu  menu-master.json を配信
const storage = require('../lib/storage');

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const menu = (await storage.get('menu-master.json')) || [];
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ ok: true, menu });
  } catch (err) {
    console.error('menu取得エラー:', err.message);
    return res.status(200).json({ ok: false, menu: [] });
  }
};
