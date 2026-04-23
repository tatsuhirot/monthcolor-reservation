/**
 * api/admin-action.js
 * POST /api/admin-action
 * スタッフ用: 予約のキャンセル・変更をキューに追加
 *
 * リクエストボディ:
 *   action  : 'cancel' | 'update'
 *   id      : 対象予約のUUID
 *   updateData?: { date, time, name, menuName, memo }  ← update 時のみ
 */

const { put, head } = require('@vercel/blob');
const { v4: uuidv4 } = require('uuid');

const QUEUE_KEY = 'reservations-queue.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  const { action, id, updateData } = req.body || {};
  if (!action || !id) {
    return res.status(400).json({ error: 'action と id は必須です' });
  }

  try {
    const queue = await loadQueue();
    const target = queue.find(r => r.id === id);
    if (!target) return res.status(404).json({ error: '予約が見つかりません' });

    if (action === 'cancel') {
      if (target.status === 'pending') {
        // まだ未処理 → Blob だけキャンセルすればOK（SalonBoard には未登録）
        target.status = 'cancelled';
        target.processedAt = new Date().toISOString();
        console.log(`✅ pending 予約をキャンセル: ${id}`);
      } else if (target.status === 'completed') {
        // SalonBoard 登録済み → worker にキャンセルタスクを積む
        queue.push({
          id:        uuidv4(),
          type:      'cancel',
          status:    'pending',
          targetId:  id,
          data:      target.data,  // 日時・名前をキャンセル特定に使う
          createdAt: new Date().toISOString(),
          processedAt: null,
          error:     null,
        });
        target.status = 'cancel_requested';
        console.log(`📋 SalonBoard キャンセルタスクを追加: ${id}`);
      } else {
        return res.status(400).json({ error: `${target.status} の予約はキャンセルできません` });
      }

    } else if (action === 'update') {
      if (!updateData) return res.status(400).json({ error: 'updateData が必要です' });

      if (target.status === 'pending') {
        // まだ未処理 → データを直接書き換えるだけでOK
        target.data = { ...target.data, ...updateData };
        target.updatedAt = new Date().toISOString();
        console.log(`✅ pending 予約を更新: ${id}`);
      } else if (target.status === 'completed') {
        // SalonBoard 登録済み → 旧予約キャンセル＋新規登録タスクを積む
        const newData = { ...target.data, ...updateData };
        queue.push({
          id:        uuidv4(),
          type:      'cancel',
          status:    'pending',
          targetId:  id,
          data:      target.data,   // キャンセル対象（旧データ）
          createdAt: new Date().toISOString(),
          processedAt: null,
          error:     null,
        });
        queue.push({
          id:        uuidv4(),
          type:      'register',
          status:    'pending',
          data:      newData,       // 再登録（新データ）
          createdAt: new Date().toISOString(),
          processedAt: null,
          error:     null,
        });
        target.status = 'update_requested';
        target.data = newData;
        console.log(`📋 SalonBoard 変更タスク（キャンセル＋再登録）を追加: ${id}`);
      } else {
        return res.status(400).json({ error: `${target.status} の予約は変更できません` });
      }

    } else {
      return res.status(400).json({ error: `不明なアクション: ${action}` });
    }

    await saveQueue(queue);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('❌ admin-action エラー:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function checkAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  return token === (process.env.ADMIN_PASSWORD || '');
}

async function loadQueue() {
  try {
    const blob = await head(QUEUE_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blob) return [];
    const res = await fetch(blob.url);
    return await res.json();
  } catch {
    return [];
  }
}

async function saveQueue(queue) {
  await put(QUEUE_KEY, JSON.stringify(queue, null, 2), {
    access:          'public',
    token:           process.env.BLOB_READ_WRITE_TOKEN,
    allowOverwrite:  true,
    contentType:     'application/json',
    addRandomSuffix: false,
  });
}
