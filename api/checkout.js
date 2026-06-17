/**
 * api/checkout.js — 会計確定（予約ベース）
 *
 * POST /api/checkout
 * Body: { reservationId, items[], products[], discount:{type,value}, payment, tendered }
 * → reservations-queue.json の予約に data.checkout を書き visitStatus=paid に更新
 * → sales-log.json に複数明細の売上を追記
 */

require('dotenv').config();
const storage = require('../lib/storage');
const { computeCheckout, nextSlipNo } = require('../lib/checkout');
const { Resend } = require('resend');

const QUEUE_KEY = 'reservations-queue.json';
const SALES_KEY = 'sales-log.json';

async function loadBlob(key) {
  try { return (await storage.get(key)) || []; } catch { return []; }
}
async function saveBlob(key, data) {
  await storage.put(key, JSON.stringify(data, null, 2));
}

async function sendLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to    = process.env.LINE_OWNER_USER_ID;
  if (!token || !to) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
  } catch (e) { console.error('LINE通知失敗:', e.message); }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${(process.env.COMINGSOON_PASSWORD || '').trim()}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  const {
    reservationId, items = [], products = [],
    discount = { type: 'amount', value: 0 }, payment, tendered = null,
  } = req.body || {};

  if (!reservationId || !payment) {
    return res.status(400).json({ error: 'reservationId, payment は必須です' });
  }
  if (!['cash', 'card', 'qr'].includes(payment)) {
    return res.status(400).json({ error: 'payment は cash / card / qr のいずれかです' });
  }

  const merged = [
    ...items.map(it => ({ kind: 'service', code: it.code || null, name: it.name, price: Number(it.price) || 0, qty: Number(it.qty) || 1 })),
    ...products.map(p => ({ kind: 'product', id: p.id || null, name: p.name, price: Number(p.price) || 0, qty: Number(p.qty) || 1 })),
  ];
  if (merged.length === 0) {
    return res.status(400).json({ error: '明細が1件以上必要です' });
  }

  try {
    const queue = await loadBlob(QUEUE_KEY);
    const idx = queue.findIndex(r => r.id === reservationId);
    if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });
    const rsv = queue[idx];
    if (rsv.data && rsv.data.visitStatus === 'paid') {
      return res.status(409).json({ error: '既に会計済みです' });
    }

    let computed;
    try {
      computed = computeCheckout({ items: merged, discount, payment, tendered });
    } catch (e) {
      return res.status(400).json({ error: e.message }); // 釣り銭マイナス
    }

    const sales = await loadBlob(SALES_KEY);
    const salesSameDay = sales.filter(s => s.date === rsv.data.date).length;
    const slipNo = nextSlipNo(rsv.data.date, salesSameDay);
    const checkoutAt = new Date().toISOString();
    const tenderedVal = payment === 'cash' ? Number(tendered) : null;

    const checkout = {
      slipNo, items: merged, discount,
      subtotal: computed.subtotal, discountAmount: computed.discountAmount,
      total: computed.total, taxIncluded: computed.taxIncluded,
      payment, tendered: tenderedVal, change: computed.change, paidAt: checkoutAt,
    };
    rsv.data.checkout = checkout;
    rsv.data.visitStatus = 'paid';
    queue[idx] = rsv;
    await saveBlob(QUEUE_KEY, queue);

    const saleRecord = {
      reservationId, slipNo, date: rsv.data.date, time: rsv.data.time,
      customer: rsv.data.name, phone: rsv.data.phone || '',
      items: merged,
      subtotal: computed.subtotal, discount, discountAmount: computed.discountAmount,
      total: computed.total, taxIncluded: computed.taxIncluded,
      payment, tendered: tenderedVal, change: computed.change,
      staff: rsv.data.staff || '', checkoutAt,
    };
    sales.push(saleRecord);
    await saveBlob(SALES_KEY, sales);

    console.log(`✅ 会計完了: ${slipNo} / ${rsv.data.name} / ¥${computed.total} (${payment})`);

    if (rsv.data.email && process.env.RESEND_API_KEY) {
      sendThankYouEmail({ sale: saleRecord, email: rsv.data.email }).catch(() => {});
    }

    const payLabel = { cash: '💴 現金', card: '💳 カード', qr: '📱 QR払い' }[payment] || payment;
    const itemLines = merged.map(i => `・${i.name} ×${i.qty} ¥${(i.price * i.qty).toLocaleString()}`).join('\n');
    const discLine = computed.discountAmount > 0 ? `\n割引: -¥${computed.discountAmount.toLocaleString()}` : '';
    sendLine(
      `💰 会計完了 [${slipNo}]\n━━━━━━━━━━━\n` +
      `お客様: ${rsv.data.name}\n${itemLines}${discLine}\n` +
      `合計: ¥${computed.total.toLocaleString()}\n支払: ${payLabel}\n━━━━━━━━━━━`
    );

    return res.status(200).json({ ok: true, slipNo, total: computed.total, change: computed.change, sale: saleRecord });
  } catch (e) {
    console.error('checkout API error:', e);
    return res.status(500).json({ error: e.message });
  }
};

// ── サンクスメール ────────────────────────────────────────────────
async function sendThankYouEmail({ sale, email }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const payLabel = { cash: '現金', card: 'カード', qr: 'QR払い' }[sale.payment] || sale.payment;
  const visitDate = new Date(sale.date).toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });
  const menuSummary = (sale.items || []).map(i => `${i.name}×${i.qty}`).join('、');
  await resend.emails.send({
    from:    process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
    to:      email,
    subject: `ご来店ありがとうございました — MONTH COLOR`,
    html: `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans',Meiryo,sans-serif;background:#f5f5f5;padding:32px 16px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#1a1a1a;padding:28px 32px;">
      <p style="color:#c9a87a;font-size:11px;letter-spacing:3px;margin:0 0 6px;">MONTH COLOR</p>
      <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600;">ご来店ありがとうございました</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#333;line-height:1.8;margin:0 0 24px;">
        ${sale.customer} 様<br><br>本日はご来店いただきありがとうございました。<br>またのご来店をお待ちしております。
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
        <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:11px 0;color:#888;font-size:13px;width:30%;">ご来店日</td><td style="padding:11px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${visitDate}</td></tr>
        <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:11px 0;color:#888;font-size:13px;">内容</td><td style="padding:11px 0;color:#1a1a1a;font-size:14px;">${menuSummary}</td></tr>
        <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:11px 0;color:#888;font-size:13px;">お会計</td><td style="padding:11px 0;color:#1a1a1a;font-size:14px;font-weight:600;">¥${sale.total.toLocaleString()}（${payLabel}）</td></tr>
      </table>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${process.env.SITE_URL || 'https://monthcolor-reservation.vercel.app'}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:.05em;">次回のご予約はこちら →</a>
      </div>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;border-top:1px solid #e8e8e8;">
      <p style="color:#aaa;font-size:11px;margin:0;text-align:center;">© MONTH COLOR 東陽町 / 東京都江東区東陽4-1-2 大朋ビル4F</p>
    </div>
  </div>
</body></html>`,
  });
  console.log(`📧 サンクスメール送信: ${email}`);
}
