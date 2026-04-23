/**
 * api/checkout.js — 会計確定
 *
 * POST /api/checkout
 * Body: { visitId, payment: "cash"|"card"|"qr", amount, discount }
 * → visits-log.json の該当レコードを completed に更新
 * → sales-log.json に売上レコードを追記
 */

require('dotenv').config();
const { put, head } = require('@vercel/blob');
const { Resend } = require('resend');

const VISITS_KEY = 'visits-log.json';
const SALES_KEY  = 'sales-log.json';
const QUEUE_KEY  = 'reservations-queue.json';

// ── LINE Push 通知 ──────────────────────────────────────────────
async function sendLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to    = process.env.LINE_OWNER_USER_ID;
  if (!token || !to) return; // 未設定なら無視
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

async function loadBlob(key) {
  try {
    const meta = await head(key, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!meta) return [];
    return await fetch(meta.url).then(r => r.json());
  } catch {
    return [];
  }
}

async function saveBlob(key, data) {
  await put(key, JSON.stringify(data, null, 2), {
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

  const { visitId, payment, amount, discount = 0 } = req.body || {};

  if (!visitId || !payment) {
    return res.status(400).json({ error: 'visitId, payment は必須です' });
  }
  if (!['cash', 'card', 'qr'].includes(payment)) {
    return res.status(400).json({ error: 'payment は cash / card / qr のいずれかです' });
  }

  // visits-log の該当レコードを更新
  const visits     = await loadBlob(VISITS_KEY);
  const visitIndex = visits.findIndex(v => v.id === visitId);
  if (visitIndex === -1) {
    return res.status(404).json({ error: '来店記録が見つかりません' });
  }

  const visit     = visits[visitIndex];
  const finalAmt  = typeof amount === 'number' ? amount : (visit.price - discount);

  visit.status     = 'completed';
  visit.payment    = payment;
  visit.discount   = discount;
  visit.finalPrice = finalAmt;
  visit.checkoutAt = new Date().toISOString();
  visits[visitIndex] = visit;
  await saveBlob(VISITS_KEY, visits);

  // sales-log に追記
  const sales = await loadBlob(SALES_KEY);
  const saleRecord = {
    visitId:    visit.id,
    date:       visit.date,
    time:       visit.time,
    customer:   visit.customer.name,
    phone:      visit.customer.phone,
    menuName:   visit.menuName,
    category:   visit.category,
    staff:      visit.staff,
    price:      visit.price,
    discount,
    finalPrice: finalAmt,
    payment,
    checkoutAt: visit.checkoutAt,
  };
  sales.push(saleRecord);
  await saveBlob(SALES_KEY, sales);

  console.log(`✅ 会計完了: ${visit.id} / ${visit.customer.name} / ¥${finalAmt} (${payment})`);

  // サンクスメール（予約データからメールアドレスを逆引き）
  if (visit.reservationId && process.env.RESEND_API_KEY) {
    loadBlob(QUEUE_KEY).then(queue => {
      const rsv = queue.find(r => r.id === visit.reservationId);
      if (rsv?.data?.email) {
        sendThankYouEmail({ sale: saleRecord, email: rsv.data.email }).catch(() => {});
      }
    }).catch(() => {});
  }

  // LINE 通知（失敗してもレスポンスはブロックしない）
  const payLabel = { cash: '💴 現金', card: '💳 カード', qr: '📱 QR払い' }[payment] || payment;
  const discountLine = discount > 0 ? `\n割引: -¥${discount.toLocaleString()}` : '';
  const now = new Date();
  const timeStr = `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  sendLine(
    `💰 会計完了\n` +
    `━━━━━━━━━━━\n` +
    `お客様: ${visit.customer.name}\n` +
    `メニュー: ${visit.menuName}\n` +
    `お会計: ¥${finalAmt.toLocaleString()}${discountLine}\n` +
    `支払方法: ${payLabel}\n` +
    `━━━━━━━━━━━\n` +
    timeStr
  );

  return res.status(200).json({ ok: true, sale: saleRecord });
};

// ── サンクスメール ────────────────────────────────────────────────
async function sendThankYouEmail({ sale, email }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const payLabel = { cash: '現金', card: 'カード', qr: 'QR払い' }[sale.payment] || sale.payment;
  const visitDate = new Date(sale.date).toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });

  await resend.emails.send({
    from:    process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
    to:      email,
    subject: `ご来店ありがとうございました — MONTH COLOR`,
    html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans',Meiryo,sans-serif;background:#f5f5f5;padding:32px 16px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#1a1a1a;padding:28px 32px;">
      <p style="color:#c9a87a;font-size:11px;letter-spacing:3px;margin:0 0 6px;">MONTH COLOR</p>
      <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600;">ご来店ありがとうございました</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#333;line-height:1.8;margin:0 0 24px;">
        ${sale.customer} 様<br><br>
        本日はご来店いただきありがとうございました。<br>
        またのご来店をスタッフ一同お待ちしております。
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;width:30%;">ご来店日</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${visitDate}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;">メニュー</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;">${sale.menuName}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;">お会計</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;font-weight:600;">¥${sale.finalPrice.toLocaleString()}（${payLabel}）</td>
        </tr>
      </table>

      <!-- 次回予約 CTA -->
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${process.env.SITE_URL || 'https://monthcolor-reservation.vercel.app'}"
           style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;
                  padding:14px 36px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:.05em;">
          次回のご予約はこちら →
        </a>
      </div>

      <!-- 口コミ依頼 -->
      <div style="background:#f9f6f2;border-radius:8px;padding:20px;text-align:center;">
        <p style="color:#888;font-size:12px;margin:0 0 10px;">ご来店の感想をお聞かせください</p>
        <a href="https://g.page/r/monthcolor/review"
           style="color:#e60;font-size:13px;font-weight:600;text-decoration:none;">
          ⭐ Googleで口コミを書く
        </a>
      </div>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;border-top:1px solid #e8e8e8;">
      <p style="color:#aaa;font-size:11px;margin:0;text-align:center;">
        © MONTH COLOR 東陽町 / 東京都江東区東陽4-1-2 大朋ビル4F
      </p>
    </div>
  </div>
</body>
</html>`,
  });
  console.log(`📧 サンクスメール送信: ${email}`);
}
