/**
 * api/close.js — レジ締め（日次）
 * GET  /api/close?date=YYYY-MM-DD → 当日サマリ（現金/カード/QR売上・defaultFloat・既存締め）
 * POST /api/close                 → 締め確定（daily-close.json に date キーで upsert）
 * 認証: Authorization: Bearer ${COMINGSOON_PASSWORD}
 */
require('dotenv').config();
const storage = require('../../lib/storage');
const { computeClose, DEFAULT_FLOAT } = require('../../lib/close');

const SALES_KEY = 'sales-log.json';
const CLOSE_KEY = 'daily-close.json';

const amountOf = (s) => (typeof s.total === 'number' ? s.total : (s.finalPrice || 0));

// 当日の支払方法別売上合計
function salesByPayment(sales, date) {
  const acc = { cash: 0, card: 0, qr: 0 };
  for (const s of sales) {
    if (s.date !== date) continue;
    const p = s.payment || 'cash';
    if (p in acc) acc[p] += amountOf(s);
  }
  return acc;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${(process.env.COMINGSOON_PASSWORD || '').trim()}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  try {
    let sales = [];
    try { sales = (await storage.get(SALES_KEY)) || []; } catch { /* 未存在は空 */ }
    let closes = [];
    try { closes = (await storage.get(CLOSE_KEY)) || []; } catch { /* 未存在は空 */ }

    if (req.method === 'GET') {
      const date = req.query && req.query.date;
      if (!date) return res.status(400).json({ error: 'date は必須です' });
      const pay = salesByPayment(sales, date);
      const existing = closes.find(c => c.date === date) || null;
      // defaultFloat: 当日 → 最新締め → 定数 の3段フォールバック
      let defaultFloat = DEFAULT_FLOAT;
      if (existing) {
        defaultFloat = existing.float;
      } else if (closes.length) {
        const latest = closes.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
        defaultFloat = latest.float;
      }
      return res.status(200).json({
        date, existing,
        cashSales: pay.cash, cardSales: pay.card, qrSales: pay.qr,
        defaultFloat,
      });
    }

    if (req.method === 'POST') {
      const { date, float, denominations, note } = req.body || {};
      if (!date || denominations == null) {
        return res.status(400).json({ error: 'date と denominations は必須です' });
      }
      const pay = salesByPayment(sales, date);
      const calc = computeClose({ float, cashSales: pay.cash, denominations });
      const record = {
        date,
        float: Math.max(0, Number(float) || 0),
        cashSales: pay.cash,
        expectedCash: calc.expectedCash,
        denominations,
        countedCash: calc.countedCash,
        overShort: calc.overShort,
        deposit: calc.deposit,
        cardSales: pay.card,
        qrSales: pay.qr,
        note: note || '',
        closedAt: new Date().toISOString(),
      };
      const idx = closes.findIndex(c => c.date === date);
      if (idx >= 0) closes[idx] = record; else closes.push(record);
      await storage.put(CLOSE_KEY, JSON.stringify(closes));
      return res.status(200).json(record);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('close API error:', e);
    return res.status(500).json({ error: e.message });
  }
};
