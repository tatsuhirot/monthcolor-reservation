/**
 * api/slots.js — 空き枠データをVercel Blobから返す
 *
 * GET /api/slots
 * Response: { updatedAt: string|null, slots: { "YYYY-MM-DD": ["HH:MM", ...] } }
 *
 * slots-data.json は sync_slots.js が SalonBoard をスクレイピングして生成する。
 */

const { list } = require('@vercel/blob');

const SLOTS_KEY = 'slots-data.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { blobs } = await list({
      prefix: SLOTS_KEY,
      limit: 1,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!blobs.length) {
      // データ未同期: フロント側で全枠表示にフォールバック
      return res.status(200).json({ updatedAt: null, slots: null });
    }
    const data = await fetch(blobs[0].url).then(r => r.json());
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate'); // 5分キャッシュ
    return res.status(200).json(data);
  } catch (e) {
    // エラー時は全枠表示にフォールバック
    return res.status(200).json({ updatedAt: null, slots: null });
  }
};
