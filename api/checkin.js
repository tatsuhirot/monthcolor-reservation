/**
 * api/checkin.js — 来店チェックイン
 *
 * POST /api/checkin
 * Body: { reservationId, customerName, phone, menuId, date, time, staff }
 * → visits-log.json に checkedin レコードを追加
 */

require('dotenv').config();
const { put, head } = require('@vercel/blob');
const { v4: uuidv4 } = require('uuid');

const VISITS_KEY = 'visits-log.json';
const SALES_KEY  = 'sales-log.json';

// ── LINE Push 通知 ──────────────────────────────────────────────
async function sendLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to    = process.env.LINE_OWNER_USER_ID;
  if (!token || !to) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
  } catch (e) {
    console.error('LINE通知失敗:', e.message);
  }
}

// メニューマスター（menuId から解決する場合のフォールバック用）
const MENUS_MASTER = {
  h1: { name: 'リタッチカラー',          price: 4400, category: 'ヘアカラー' },
  h2: { name: 'フルカラー',              price: 6600, category: 'ヘアカラー' },
  h3: { name: 'カラー＋トリートメント',   price: 8800, category: 'ヘアカラー' },
  h4: { name: 'ハイライト',              price: 7700, category: 'ヘアカラー' },
  w1: { name: 'セルフホワイトニング 30分', price: 3300, category: 'ホワイトニング' },
  w2: { name: 'セルフホワイトニング 60分', price: 5500, category: 'ホワイトニング' },
  l1: { name: 'まつ毛パーマ（ベーシック）', price: 5500, category: 'まつ毛パーマ' },
  l2: { name: 'まつ毛パーマ＋リフトアップ', price: 7700, category: 'まつ毛パーマ' },
  s1: { name: 'ドライヘッドスパ 30分',   price: 3300, category: 'ヘッドスパ' },
  s2: { name: 'ドライヘッドスパ 60分',   price: 5500, category: 'ヘッドスパ' },
  s3: { name: 'ドライヘッドスパ 90分',   price: 7700, category: 'ヘッドスパ' },
};

async function loadBlob(key) {
  try {
    const meta = await head(key, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!meta) return [];
    return await fetch(meta.url).then(r => r.json());
  } catch {
    return [];
  }
}
const loadVisits = () => loadBlob(VISITS_KEY);

async function saveVisits(visits) {
  await put(VISITS_KEY, JSON.stringify(visits, null, 2), {
    access: 'public',
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 管理パスワード認証
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  // フロントから menuName/price/category を直接受け取る（疎結合）
  // menuId も受け付けてフォールバックとして使う
  const { reservationId, customerName, phone, menuId, menuName, price, category, date, time, staff } = req.body || {};

  if (!customerName || !date || !time) {
    return res.status(400).json({ error: 'customerName, date, time は必須です' });
  }

  // menuName/price を優先。なければ menuId からルックアップ
  const fallback = MENUS_MASTER[menuId] || { name: '不明', price: 0, category: '不明' };
  const resolvedMenu = {
    name:     menuName     || fallback.name,
    price:    price != null ? Number(price) : fallback.price,
    category: category     || fallback.category,
  };

  const visit = {
    id:            uuidv4(),
    reservationId: reservationId || null,
    status:        'checkedin',
    customer:      { name: customerName, phone: phone || '' },
    menuId:        menuId || null,
    menuName:      resolvedMenu.name,
    category:      resolvedMenu.category,
    price:         resolvedMenu.price,
    staff:         staff || '',
    date,
    time,
    payment:       null,
    discount:      0,
    checkinAt:     new Date().toISOString(),
    checkoutAt:    null,
  };

  const visits = await loadVisits();
  visits.push(visit);
  await saveVisits(visits);

  console.log(`✅ チェックイン: ${visit.id} / ${customerName} / ${date} ${time}`);

  // リピーター検知 → LINE通知（電話番号があり過去に来店歴がある場合）
  if (phone) {
    const sales = await loadBlob(SALES_KEY);
    const pastVisits = sales.filter(s => s.phone === phone);
    if (pastVisits.length >= 1) {
      const visitCount  = pastVisits.length + 1; // 今回含む
      const totalSpent  = pastVisits.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
      const lastVisit   = pastVisits.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
      const menuCounts  = {};
      pastVisits.forEach(s => { menuCounts[s.menuName] = (menuCounts[s.menuName] || 0) + 1; });
      const favoriteMenu = Object.entries(menuCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
      const rankLabel   = visitCount >= 10 ? '🏆 VIP' : visitCount >= 5 ? '⭐ 常連' : '🔄 リピーター';

      sendLine(
        `${rankLabel} 来店！\n` +
        `━━━━━━━━━━━\n` +
        `${customerName} さん\n` +
        `来店回数: ${visitCount}回目\n` +
        `よく使うメニュー: ${favoriteMenu}\n` +
        `前回来店: ${lastVisit?.date || '—'}\n` +
        `累計利用額: ¥${totalSpent.toLocaleString()}\n` +
        `━━━━━━━━━━━\n` +
        `今日のメニュー: ${resolvedMenu.name}`
      );
    }
  }

  return res.status(200).json({ ok: true, visitId: visit.id, visit });
};
