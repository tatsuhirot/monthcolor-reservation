/**
 * api/sales.js — 売上データ取得
 *
 * GET /api/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
 * → sales-log.json から期間フィルタして返す
 * → 集計サマリーも含む
 */

require('dotenv').config();
const { head } = require('@vercel/blob');

const SALES_KEY   = 'sales-log.json';
const VISITS_KEY  = 'visits-log.json';

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 管理パスワード認証
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  const { from, to } = req.query;

  try {
    // sales-log 取得
    let sales = [];
    try {
      const meta = await head(SALES_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
      if (meta) sales = await fetch(meta.url).then(r => r.json());
    } catch { /* Blob未存在は空で処理 */ }

    // 期間フィルタ
    if (from || to) {
      sales = sales.filter(s => {
        if (from && s.date < from) return false;
        if (to   && s.date > to)   return false;
        return true;
      });
    }

    // visits-log（当日チェックイン済み = 未会計）取得
    let checkedIn = [];
    try {
      const vmeta = await head(VISITS_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
      if (vmeta) {
        const visits = await fetch(vmeta.url).then(r => r.json());
        const today  = new Date().toISOString().slice(0, 10);
        checkedIn = visits.filter(v => v.status === 'checkedin' && v.date === today);
      }
    } catch { /* skip */ }

    // ── 集計 ──────────────────────────────────────────────────
    const totalRevenue = sales.reduce((s, r) => s + (r.finalPrice || 0), 0);
    const totalCount   = sales.length;

    // メニューカテゴリ別
    const byCategory = {};
    for (const s of sales) {
      const cat = s.category || '不明';
      if (!byCategory[cat]) byCategory[cat] = { count: 0, revenue: 0 };
      byCategory[cat].count++;
      byCategory[cat].revenue += s.finalPrice || 0;
    }

    // 支払方法別
    const byPayment = { cash: { count: 0, revenue: 0 }, card: { count: 0, revenue: 0 }, qr: { count: 0, revenue: 0 } };
    for (const s of sales) {
      const p = s.payment || 'cash';
      if (byPayment[p]) { byPayment[p].count++; byPayment[p].revenue += s.finalPrice || 0; }
    }

    // 日別売上
    const byDate = {};
    for (const s of sales) {
      if (!byDate[s.date]) byDate[s.date] = { count: 0, revenue: 0 };
      byDate[s.date].count++;
      byDate[s.date].revenue += s.finalPrice || 0;
    }

    // リピート顧客（同電話番号が2回以上）
    const phoneCounts = {};
    for (const s of sales) {
      if (s.phone) phoneCounts[s.phone] = (phoneCounts[s.phone] || 0) + 1;
    }
    const repeatCount = Object.values(phoneCounts).filter(n => n >= 2).length;
    const uniqueCustomers = Object.keys(phoneCounts).length;
    const repeatRate = uniqueCustomers > 0 ? Math.round(repeatCount / uniqueCustomers * 100) : 0;

    return res.status(200).json({
      records: sales,
      summary: {
        totalRevenue,
        totalCount,
        repeatRate,
        uniqueCustomers,
        byCategory,
        byPayment,
        byDate,
      },
      checkedIn,
    });
  } catch (e) {
    console.error('sales API error:', e);
    return res.status(500).json({ error: e.message });
  }
};
