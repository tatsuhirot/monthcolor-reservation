/**
 * api/customers.js — 顧客カルテ API
 *
 * GET /api/customers            → 全顧客一覧（電話番号でグルーピング）
 * GET /api/customers?phone=090… → 特定顧客の詳細＋来店履歴
 * GET /api/customers?name=山田  → 名前部分一致で検索
 *
 * データソース: sales-log.json（会計済み）
 */

require('dotenv').config();
const { head } = require('@vercel/blob');

const SALES_KEY = 'sales-log.json';

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  // sales-log 取得
  let sales = [];
  try {
    const meta = await head(SALES_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (meta) sales = await fetch(meta.url).then(r => r.json());
  } catch {
    return res.status(200).json({ customers: [] });
  }

  // 電話番号でグルーピング
  const byPhone = {};
  for (const s of sales) {
    const phone = s.phone || '__unknown__';
    if (!byPhone[phone]) {
      byPhone[phone] = {
        phone:      phone === '__unknown__' ? '' : phone,
        name:       s.customer || '不明',
        visits:     [],
        totalSpent: 0,
        menuCount:  {},
      };
    }
    const c = byPhone[phone];
    // 名前は最新の来店を優先
    if (s.customer) c.name = s.customer;
    c.visits.push(s);
    c.totalSpent += s.finalPrice || 0;
    if (s.menuName) c.menuCount[s.menuName] = (c.menuCount[s.menuName] || 0) + 1;
  }

  // 各顧客のサマリーを計算
  const customers = Object.values(byPhone).map(c => {
    c.visits.sort((a, b) => b.checkoutAt?.localeCompare(a.checkoutAt || '') || 0);
    const favoriteMenu = Object.entries(c.menuCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return {
      phone:        c.phone,
      name:         c.name,
      visitCount:   c.visits.length,
      lastVisit:    c.visits[0]?.date || null,
      lastMenu:     c.visits[0]?.menuName || null,
      totalSpent:   c.totalSpent,
      avgSpent:     Math.round(c.totalSpent / c.visits.length),
      favoriteMenu,
      history:      c.visits.map(v => ({
        date:       v.date,
        time:       v.time,
        menuName:   v.menuName,
        category:   v.category,
        finalPrice: v.finalPrice,
        discount:   v.discount,
        payment:    v.payment,
        checkoutAt: v.checkoutAt,
      })),
    };
  });

  // ── フィルタ ─────────────────────────────────────────────────
  const { phone, name } = req.query || {};

  if (phone) {
    const c = customers.find(c => c.phone === phone);
    if (!c) return res.status(200).json({ customer: null });
    return res.status(200).json({ customer: c });
  }

  if (name) {
    const filtered = customers.filter(c => c.name.includes(name));
    return res.status(200).json({ customers: filtered });
  }

  // 全顧客: 最終来店日降順
  customers.sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || ''));
  return res.status(200).json({ customers });
};
