/**
 * api/cron-remind.js — 予約前日リマインダー（Vercel Cron）
 *
 * vercel.json の crons で毎日 10:00 UTC（19:00 JST）に実行される。
 * 翌日の予約を持つお客様にリマインダーメールを送信する。
 *
 * GET /api/cron-remind
 * ヘッダー: Authorization: Bearer {CRON_SECRET} （Vercelが自動付与）
 */

require('dotenv').config();
const { head } = require('@vercel/blob');
const { Resend } = require('resend');

const QUEUE_KEY = 'reservations-queue.json';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Vercel Cron の認証（CRON_SECRET 環境変数）
  const authHeader = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 翌日の日付文字列（YYYY-MM-DD）
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;

  // 予約キュー読み込み
  let queue = [];
  try {
    const meta = await head(QUEUE_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (meta) queue = await fetch(meta.url).then(r => r.json());
  } catch (e) {
    console.error('キュー読み込み失敗:', e.message);
    return res.status(500).json({ error: 'キュー読み込み失敗' });
  }

  // 翌日の予約でメールアドレスありのものだけ抽出
  const targets = queue.filter(r =>
    r.data?.date === tomorrowStr &&
    r.data?.email &&
    r.status !== 'cancelled'
  );

  if (!targets.length) {
    console.log(`📅 ${tomorrowStr}: リマインダー対象なし`);
    return res.status(200).json({ sent: 0, date: tomorrowStr });
  }

  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY 未設定 — リマインダースキップ');
    return res.status(200).json({ sent: 0, skipped: targets.length });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const results = await Promise.allSettled(targets.map(r => sendReminder(resend, r.data)));

  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`📧 リマインダー: ${sent}件送信 / ${failed}件失敗 (${tomorrowStr})`);

  return res.status(200).json({ sent, failed, date: tomorrowStr });
};

// ── リマインダーメール送信 ────────────────────────────────────────
async function sendReminder(resend, { date, time, name, menuName, email, phone }) {
  const dateLabel = new Date(date).toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });

  await resend.emails.send({
    from:    process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
    to:      email,
    subject: `【明日のご予約リマインダー】${dateLabel} ${time} — MONTH COLOR`,
    html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans',Meiryo,sans-serif;background:#f5f5f5;padding:32px 16px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#1a1a1a;padding:28px 32px;">
      <p style="color:#c9a87a;font-size:11px;letter-spacing:3px;margin:0 0 6px;">MONTH COLOR</p>
      <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600;">明日のご予約のお知らせ</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#333;line-height:1.8;margin:0 0 24px;">
        ${name} 様<br><br>
        明日のご予約のお時間が近づいてまいりました。<br>
        お気をつけてお越しください。
      </p>

      <!-- 予約ハイライト -->
      <div style="background:#f9f6f2;border-radius:10px;padding:20px 24px;margin-bottom:24px;text-align:center;">
        <p style="color:#c9a87a;font-size:11px;letter-spacing:2px;margin:0 0 8px;">YOUR APPOINTMENT</p>
        <p style="color:#1a1a1a;font-size:22px;font-weight:700;margin:0 0 4px;">${dateLabel}</p>
        <p style="color:#1a1a1a;font-size:28px;font-weight:700;margin:0 0 8px;">${time}</p>
        <p style="color:#666;font-size:14px;margin:0;">${menuName || '施術'}</p>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;width:30%;">場所</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:13px;">
            MONTH COLOR 東陽町<br>
            東京都江東区東陽4-1-2 大朋ビル4F
          </td>
        </tr>
        <tr>
          <td style="padding:11px 0;color:#888;font-size:13px;">アクセス</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:13px;">東京メトロ東西線 東陽町駅 徒歩3分</td>
        </tr>
      </table>

      <p style="color:#888;font-size:12px;line-height:1.8;margin:0;">
        ご変更・キャンセルのご連絡は前日までにお電話にてお願いいたします。<br>
        当日のキャンセルはご遠慮ください。
      </p>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;border-top:1px solid #e8e8e8;">
      <p style="color:#aaa;font-size:11px;margin:0;text-align:center;">
        © MONTH COLOR — このメールは予約システムから自動送信されました
      </p>
    </div>
  </div>
</body>
</html>`,
  });

  console.log(`📧 リマインダー送信: ${email} / ${date} ${time}`);
}
