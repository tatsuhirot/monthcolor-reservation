/**
 * api/reservations.js
 * GET /api/reservations
 * スタッフ用: Vercel Blob の予約キューを返す（パスワード認証付き）
 */

const storage = require('../lib/storage');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // パスワード認証
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  try {
    const queue = await loadQueue();

    // 新しい順に並び替え
    queue.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ ok: true, reservations: queue });
  } catch (err) {
    console.error('❌ キュー取得エラー:', err.message);
    return res.status(500).json({ error: 'データの取得に失敗しました' });
  }
};

function checkAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  return token === (process.env.COMINGSOON_PASSWORD || '').trim();
}

async function loadQueue() {
  try {
    return (await storage.get('reservations-queue.json')) || [];
  } catch {
    return [];
  }
}
