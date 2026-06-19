/**
 * api/products.js — 物販マスタ CRUD
 *
 * GET    /api/products[?activeOnly=1]   一覧
 * POST   /api/products                  追加({name,price}) or 更新({id,name,price,active})
 * DELETE /api/products?id=p001          論理削除(active:false)
 * 認証: Authorization: Bearer ${COMINGSOON_PASSWORD}
 */

require('dotenv').config();
const storage = require('../../lib/storage');

const PRODUCTS_KEY = 'product-master.json';

async function loadBlob() {
  try { return (await storage.get(PRODUCTS_KEY)) || []; } catch { return []; }
}
// 注: storage.put は文字列をそのまま受けるため、ここで JSON 化して渡す
async function saveBlob(data) {
  await storage.put(PRODUCTS_KEY, JSON.stringify(data, null, 2));
}

function nextId(products) {
  const max = products.reduce((m, p) => {
    const n = Number(String(p.id || '').replace(/^p/, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `p${String(max + 1).padStart(3, '0')}`;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${(process.env.COMINGSOON_PASSWORD || '').trim()}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  try {
    const products = await loadBlob();

    if (req.method === 'GET') {
      const list = req.query && req.query.activeOnly
        ? products.filter(p => p.active !== false)
        : products;
      return res.status(200).json({ products: list });
    }

    if (req.method === 'POST') {
      const { id, name, price, active } = req.body || {};
      if (!name || typeof price !== 'number') {
        return res.status(400).json({ error: 'name と price(数値) は必須です' });
      }
      if (id) {
        const idx = products.findIndex(p => p.id === id);
        if (idx === -1) return res.status(404).json({ error: '商品が見つかりません' });
        products[idx] = { ...products[idx], name, price, active: active !== false };
        await saveBlob(products);
        return res.status(200).json({ ok: true, product: products[idx] });
      }
      const product = { id: nextId(products), name, price, active: true };
      products.push(product);
      await saveBlob(products);
      return res.status(200).json({ ok: true, product });
    }

    if (req.method === 'DELETE') {
      const id = req.query && req.query.id;
      if (!id) return res.status(400).json({ error: 'id は必須です' });
      const idx = products.findIndex(p => p.id === id);
      if (idx === -1) return res.status(404).json({ error: '商品が見つかりません' });
      products[idx].active = false;
      await saveBlob(products);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('products API error:', e);
    return res.status(500).json({ error: e.message });
  }
};
