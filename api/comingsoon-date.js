/**
 * api/comingsoon-date.js
 * GET /api/comingsoon-date?date=YYYY-MM-DD
 * スタッフ用: 指定日の coming-soon 予約一覧を返す（パスワード認証付き）
 *
 * データは sync_comingsoon.js が comingsoon-YYYY-MM-DD.json として Blob に保存する。
 * date パラメータ省略時は今日。
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

  // 日付パラメータ (YYYY-MM-DD)
  const date = (req.query.date || '').trim() || (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  })();

  // 簡易バリデーション
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '日付フォーマットが不正です (YYYY-MM-DD)' });
  }

  try {
    const blob = await head(`comingsoon-${date}.json`, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!blob) {
      return res.status(200).json({
        updatedAt: null, date, reservations: [],
        message: 'このデータはまだ同期されていません',
      });
    }
    const data = await fetch(blob.url).then(r => r.json());
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ updatedAt: null, date, reservations: [] });
  }
};
