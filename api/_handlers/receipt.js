/**
 * api/receipt.js — 領収書HTML生成
 *
 * GET /api/receipt?saleId={id}
 * Authorization: Bearer {COMINGSOON_PASSWORD}
 * → 印刷用HTMLを返す（ブラウザの印刷/PDF保存に対応）
 */

require('dotenv').config();
const storage = require('../../lib/storage');

const SALES_KEY = 'sales-log.json';

async function loadBlob(key) {
  try {
    return (await storage.get(key)) || [];
  } catch {
    return [];
  }
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });
}

function formatDateTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function paymentLabel(payment) {
  return { cash: '現金', card: 'クレジットカード', qr: 'QRコード払い' }[payment] || payment;
}

function buildReceiptHtml(sale) {
  const shopName    = process.env.SHOP_NAME    || 'MONTH COLOR';
  const shopAddress = process.env.SHOP_ADDRESS || '東京都江東区東陽4丁目';
  const shopPhone   = process.env.SHOP_PHONE   || '03-6820-5623';
  const shopEmail   = process.env.SHOP_EMAIL   || '';

  const receiptNo = sale.slipNo
    || (sale.visitId ? sale.visitId.slice(0, 8).toUpperCase()
        : (sale.checkoutAt || '').replace(/\D/g, '').slice(0, 8));

  // 明細行（items[] があれば複数行、無ければ旧 menuName 単一行）
  const lineItems = Array.isArray(sale.items) && sale.items.length
    ? sale.items
    : [{ name: sale.menuName || sale.category || '施術', price: sale.price || 0, qty: 1 }];
  const itemRows = lineItems.map(it => {
    const amt = (Number(it.price) || 0) * (Number(it.qty) || 1);
    const qtyLabel = (Number(it.qty) || 1) > 1 ? ` ×${it.qty}` : '';
    return `<tr><td>${it.name}${qtyLabel}</td><td class="amount">&yen;${amt.toLocaleString()}</td></tr>`;
  }).join('');

  const subtotal      = typeof sale.subtotal === 'number' ? sale.subtotal
                        : lineItems.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
  const discountAmount = typeof sale.discountAmount === 'number' ? sale.discountAmount
                        : (typeof sale.discount === 'number' ? sale.discount : 0);
  const total          = typeof sale.total === 'number' ? sale.total
                        : (typeof sale.finalPrice === 'number' ? sale.finalPrice : subtotal - discountAmount);
  const taxIncluded    = typeof sale.taxIncluded === 'number' ? sale.taxIncluded
                        : Math.round(total - total / 1.1);

  const subtotalRow = `<tr><td>小計</td><td class="amount">&yen;${subtotal.toLocaleString()}</td></tr>`;
  const discountRow = discountAmount > 0
    ? `<tr><td>割引</td><td class="amount">-&yen;${discountAmount.toLocaleString()}</td></tr>` : '';
  const tenderedRow = (typeof sale.tendered === 'number' && sale.tendered !== null)
    ? `<tr><td>お預かり</td><td class="amount">&yen;${sale.tendered.toLocaleString()}</td></tr>
       <tr><td>お釣り</td><td class="amount">&yen;${(sale.change || 0).toLocaleString()}</td></tr>` : '';
  const itemsTable = `
    <table class="items">
      <thead><tr><th>内容</th><th>金額</th></tr></thead>
      <tbody>
        ${itemRows}
        ${subtotalRow}
        ${discountRow}
        <tr class="total-row"><td>お支払い合計</td><td class="amount">&yen;${total.toLocaleString()}</td></tr>
        <tr><td style="font-size:11px;color:#888;">（内消費税10%）</td><td class="amount" style="font-size:11px;color:#888;">&yen;${taxIncluded.toLocaleString()}</td></tr>
        ${tenderedRow}
      </tbody>
    </table>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>領収書 — ${shopName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
      font-size: 14px;
      color: #1a1a1a;
      background: #fff;
      padding: 40px 20px;
    }
    .receipt {
      max-width: 400px;
      margin: 0 auto;
      border: 1px solid #ddd;
      padding: 32px 28px;
    }
    .shop-name {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-align: center;
      margin-bottom: 4px;
    }
    .shop-info {
      font-size: 11px;
      color: #666;
      text-align: center;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    h2 {
      font-size: 18px;
      font-weight: 700;
      text-align: center;
      border-top: 2px solid #1a1a1a;
      border-bottom: 2px solid #1a1a1a;
      padding: 8px 0;
      margin-bottom: 20px;
      letter-spacing: 0.2em;
    }
    .meta {
      font-size: 12px;
      color: #555;
      margin-bottom: 20px;
      line-height: 1.8;
    }
    .meta span { font-weight: 600; color: #1a1a1a; }
    .items {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    .items th {
      font-size: 11px;
      color: #888;
      border-bottom: 1px solid #ddd;
      padding: 6px 0;
      text-align: left;
    }
    .items th:last-child, .items td:last-child { text-align: right; }
    .items td {
      padding: 8px 0;
      border-bottom: 1px solid #f0f0f0;
      vertical-align: top;
    }
    .items td.amount { font-variant-numeric: tabular-nums; }
    .total-row td {
      font-size: 16px;
      font-weight: 700;
      border-top: 2px solid #1a1a1a;
      border-bottom: none;
      padding-top: 12px;
    }
    .payment-section {
      background: #f7f7f7;
      border-radius: 4px;
      padding: 10px 12px;
      font-size: 12px;
      color: #555;
      margin-bottom: 24px;
    }
    .payment-section span { font-weight: 600; color: #1a1a1a; }
    .footer {
      text-align: center;
      font-size: 12px;
      color: #888;
      line-height: 1.8;
    }
    .print-btn {
      display: block;
      margin: 24px auto 0;
      padding: 10px 32px;
      background: #1a1a1a;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
      letter-spacing: 0.05em;
    }
    @media print {
      body { padding: 0; }
      .receipt { border: none; max-width: 100%; }
      .print-btn { display: none; }
      @page { margin: 15mm; }
    }
  </style>
</head>
<body>
  <div class="receipt">
    <div class="shop-name">${shopName}</div>
    <div class="shop-info">
      ${shopAddress}<br>
      TEL: ${shopPhone}${shopEmail ? '<br>' + shopEmail : ''}
    </div>

    <h2>領 収 書</h2>

    <div class="meta">
      受付番号:&nbsp;<span>${receiptNo}</span><br>
      発行日時:&nbsp;<span>${formatDateTime(sale.checkoutAt)}</span><br>
      ご来店日:&nbsp;<span>${formatDate(sale.date)} ${sale.time}</span><br>
      お名前:&nbsp;&nbsp;<span>${sale.customer} 様</span><br>
      担当:&nbsp;&nbsp;&nbsp;<span>${sale.staff || '―'}</span>
    </div>

    ${itemsTable}

    <div class="payment-section">
      お支払方法:&nbsp;<span>${paymentLabel(sale.payment)}</span>
    </div>

    <div class="footer">
      ご来店ありがとうございました。<br>
      またのお越しをお待ちしております。
    </div>
  </div>

  <button class="print-btn" onclick="window.print()">印刷 / PDFで保存</button>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  // 管理パスワード認証（URLパラメータも許可 — 印刷タブでHeaderが使えないため）
  const authHeader = req.headers['authorization'] || '';
  const authQuery  = req.query.token || '';
  const adminPw    = process.env.COMINGSOON_PASSWORD || '';
  const authed =
    authHeader === `Bearer ${adminPw}` ||
    authQuery  === adminPw;

  if (!authed) {
    return res.status(401).send('<h1>401 Unauthorized</h1>');
  }

  const { saleId } = req.query;
  if (!saleId) {
    return res.status(400).send('<h1>saleId が指定されていません</h1>');
  }

  const sales = await loadBlob(SALES_KEY);
  const sale  = sales.find(s =>
    s.slipNo === saleId || s.visitId === saleId || s.reservationId === saleId);
  if (!sale) {
    return res.status(404).send('<h1>売上データが見つかりません</h1>');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(buildReceiptHtml(sale));
};
