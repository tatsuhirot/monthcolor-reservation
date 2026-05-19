/**
 * api/salonboard.js
 * (salonboard-date.js + slots.js + today-reservations.js を統合)
 *
 * GET /api/salonboard                     → 空き枠データ（slots と同等）
 * GET /api/salonboard?date=YYYY-MM-DD     → 指定日の予約一覧（salonboard-date と同等）
 * GET /api/salonboard?today=1             → 今日のSB予約（today-reservations と同等）
 */

const { head } = require('@vercel/blob');
const { CAPACITY, ALL_TIMES, buildBookedMap, loadQueue } = require('./_shared');

const SLOTS_KEY = 'slots-data.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date, today } = req.query;

  // ── 空き枠データ（認証不要）──────────────────────────────────
  // ベース: slots-data.json（sync_slots.js が SalonBoard からスクレイピング）の serviceSlots
  // 追加差し引き: reservations-queue.json（このシステム経由の pending/completed 予約）
  if (!date && !today) {
    try {
      const serviceParam = req.query.service;
      const cap = CAPACITY[serviceParam] || 1;
      const token = process.env.BLOB_READ_WRITE_TOKEN;

      // サービスID → SalonBoard 表示名マップ
      const SERVICE_JP = {
        hair:  'カラー',
        white: 'ホワイトニング',
        lash:  'まつ毛パーマ',
        spa:   'ドライヘッドスパ',
      };
      const jpName = SERVICE_JP[serviceParam];

      // slots-data.json からベース空き枠を取得
      let slotsBase = null; // null = フォールバック（全枠表示）
      let updatedAt = null;
      try {
        const blobMeta = await head(SLOTS_KEY, { token });
        if (blobMeta) {
          const blobData = await fetch(blobMeta.url).then(r => r.json());
          updatedAt = blobData.updatedAt || null;
          if (jpName && blobData.serviceSlots) {
            // サービス別: serviceSlots[date][jpName]
            slotsBase = {};
            for (const [d, svcMap] of Object.entries(blobData.serviceSlots)) {
              slotsBase[d] = svcMap[jpName] || [];
            }
          } else {
            // service 未指定: 全体スロット
            slotsBase = blobData.slots || null;
          }
        }
      } catch (e) {
        console.warn('⚠️ slots-data.json 取得失敗（フォールバック）:', e.message);
      }

      // queue 予約をさらに差し引く
      const queue = await loadQueue(token);
      const booked = buildBookedMap(queue, serviceParam);

      const slots = {};
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      for (let d = new Date(now); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        if (slotsBase === null) {
          // フォールバック: 全枠から queue 分だけ差し引き
          slots[dateStr] = ALL_TIMES.filter(t => (booked[`${dateStr}:${t}`] || 0) < cap);
        } else {
          // SalonBoard 空き枠から queue 分をさらに差し引き
          slots[dateStr] = (slotsBase[dateStr] || []).filter(
            t => (booked[`${dateStr}:${t}`] || 0) < cap
          );
        }
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ updatedAt: updatedAt || new Date().toISOString(), slots });
    } catch (e) {
      console.error('⚠️ 空き枠計算エラー:', e.message);
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
