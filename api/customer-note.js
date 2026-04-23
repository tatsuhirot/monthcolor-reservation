/**
 * api/customer-note.js — 顧客メモ CRUD
 *
 * データ構造: customer-notes.json
 *   { [phone]: { note: string, updatedAt: ISO } }
 *   phone が空の顧客は "_unnamed_[name]" キーで保存
 *
 * GET  /api/customer-note?phone=090…   → { note, updatedAt }
 * POST /api/customer-note              → body: { phone, name, note } → 保存
 * DELETE /api/customer-note?phone=090… → 削除
 */

require('dotenv').config();
const { put, head } = require('@vercel/blob');

const NOTES_KEY = 'customer-notes.json';

function noteKey(phone, name) {
  if (phone) return phone;
  return `_unnamed_${(name || 'unknown').replace(/\s/g, '_')}`;
}

async function loadNotes() {
  try {
    const meta = await head(NOTES_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!meta) return {};
    return await fetch(meta.url).then(r => r.json());
  } catch {
    return {};
  }
}

async function saveNotes(notes) {
  await put(NOTES_KEY, JSON.stringify(notes, null, 2), {
    access: 'public',
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  // ── GET ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { phone, name, all } = req.query || {};
    const notes = await loadNotes();

    // ?all=1 → 全ノートのキー一覧（phone番号→updatedAt）を返す
    if (all === '1') {
      const summary = {};
      for (const [k, v] of Object.entries(notes)) {
        summary[k] = { updatedAt: v.updatedAt };
      }
      return res.status(200).json({ notes: summary });
    }

    const key = noteKey(phone, name);
    return res.status(200).json(notes[key] || { note: '', updatedAt: null });
  }

  // ── POST ───────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { phone, name, note } = req.body || {};
    if (note === undefined) return res.status(400).json({ error: 'note は必須です' });

    const notes = await loadNotes();
    const key   = noteKey(phone, name);

    if (!note.trim()) {
      // 空文字 = 削除
      delete notes[key];
    } else {
      notes[key] = { note: note.trim(), updatedAt: new Date().toISOString() };
    }

    await saveNotes(notes);
    return res.status(200).json({ ok: true });
  }

  // ── DELETE ─────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { phone, name } = req.query || {};
    const notes = await loadNotes();
    const key   = noteKey(phone, name);
    delete notes[key];
    await saveNotes(notes);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
