/**
 * api/reserve.js — Vercel Serverless Function
 *
 * reservation.html から予約データを受け取り、
 * Vercel Blob の予約キューに追加する。
 * 実際の SalonBoard 登録は worker.js が担当。
 * 予約受付後、お客様に確認メールを送信する。
 */

const { put, head, del } = require('@vercel/blob');
const { v4: uuidv4 } = require('uuid');
const { Resend } = require('resend');

const QUEUE_KEY = 'reservations-queue.json';

module.exports = async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { date, time, name, menuName, staffCategory, phone, email, memo } = req.body || {};

  if (!date || !time || !name) {
    return res.status(400).json({ error: '日付・時間・お名前は必須です' });
  }

  try {
    // 既存のキューを読み込む
    const queue = await loadQueue();

    // 新しい予約をキューに追加
    const reservation = {
      id:        uuidv4(),
      status:    'pending',  // pending | processing | completed | failed
      data:      { date, time, name, menuName, staffCategory, phone, email, memo },
      createdAt: new Date().toISOString(),
      processedAt: null,
      error:     null,
    };
    queue.push(reservation);

    // Blob に保存（上書き）
    await saveQueue(queue);
    console.log(`✅ 予約キューに追加: ${reservation.id} / ${date} ${time} / ${name}`);

    // 確認メール送信（メールアドレスがある場合）
    if (email) {
      await sendConfirmEmail({ date, time, name, menuName, email, phone, memo })
        .catch(err => console.warn('⚠️ メール送信失敗:', err.message));
    }

    // スタッフ新着通知
    await sendStaffNotification({ date, time, name, menuName, phone, email, memo })
      .catch(err => console.warn('⚠️ スタッフ通知失敗:', err.message));

    return res.status(200).json({ ok: true, id: reservation.id });

  } catch (err) {
    console.error('❌ キュー保存エラー:', err.message);
    return res.status(500).json({ error: '予約の受け付けに失敗しました。お電話にてご連絡ください。' });
  }
};

// ── スタッフ新着通知 ───────────────────────────────────────────
async function sendStaffNotification({ date, time, name, menuName, phone, email, memo }) {
  const dateLabel = new Date(date).toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });

  const summary = [
    `📅 ${dateLabel} ${time}`,
    `👤 ${name} 様`,
    `💈 ${menuName || '未選択'}`,
    phone ? `📞 ${phone}` : null,
    email ? `📧 ${email}` : null,
    memo  ? `📝 ${memo}` : null,
  ].filter(Boolean).join('\n');

  const tasks = [];

  // ── LINE Push（Messaging API）────────────────────────────
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_OWNER_USER_ID) {
    tasks.push(
      fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          to: process.env.LINE_OWNER_USER_ID,
          messages: [{ type: 'text', text: `【新規予約】\n${summary}` }],
        }),
      }).then(r => {
        if (!r.ok) throw new Error(`LINE Push ${r.status}`);
        console.log('📱 LINE Push 送信完了');
      })
    );
  }

  // ── スタッフ宛メール（Resend）──────────────────────────────
  if (process.env.STAFF_NOTIFY_EMAIL && process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    tasks.push(
      resend.emails.send({
        from:    process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
        to:      process.env.STAFF_NOTIFY_EMAIL,
        subject: `【新規予約】${dateLabel} ${time} — ${name} 様`,
        html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans',Meiryo,sans-serif;background:#f5f5f5;padding:32px 16px;margin:0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#1a1a1a;padding:24px 28px;">
      <p style="color:#c9a87a;font-size:11px;letter-spacing:3px;margin:0 0 4px;">MONTH COLOR — スタッフ通知</p>
      <h1 style="color:#fff;font-size:18px;margin:0;font-weight:600;">新規予約が入りました</h1>
    </div>
    <div style="padding:28px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;width:28%;">日時</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${dateLabel}　${time}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;">メニュー</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;">${menuName || '—'}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;">お名前</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;">${name} 様</td>
        </tr>
        ${phone ? `
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;">電話番号</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;">${phone}</td>
        </tr>` : ''}
        ${email ? `
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:11px 0;color:#888;font-size:13px;">メール</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;">${email}</td>
        </tr>` : ''}
        ${memo ? `
        <tr>
          <td style="padding:11px 0;color:#888;font-size:13px;">備考</td>
          <td style="padding:11px 0;color:#1a1a1a;font-size:14px;">${memo}</td>
        </tr>` : ''}
      </table>
    </div>
    <div style="background:#f5f5f5;padding:16px 28px;border-top:1px solid #e8e8e8;">
      <p style="color:#aaa;font-size:11px;margin:0;text-align:center;">
        このメールは予約フォームから自動送信されました
      </p>
    </div>
  </div>
</body>
</html>`,
      }).then(() => console.log(`📧 スタッフ通知メール送信: ${process.env.STAFF_NOTIFY_EMAIL}`))
    );
  }

  if (tasks.length === 0) {
    console.log('ℹ️ スタッフ通知: LINE_CHANNEL_ACCESS_TOKEN / STAFF_NOTIFY_EMAIL が未設定のためスキップ');
    return;
  }

  await Promise.all(tasks);
}

// ── キュー読み込み ─────────────────────────────────────────────
async function loadQueue() {
  try {
    const blob = await head(QUEUE_KEY, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blob) return [];
    const res = await fetch(blob.url);
    return await res.json();
  } catch {
    return [];
  }
}

// ── 確認メール送信 ─────────────────────────────────────────────
async function sendConfirmEmail({ date, time, name, menuName, email, phone, memo }) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const dateLabel = new Date(date).toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });

  await resend.emails.send({
    from:    process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
    to:      email,
    subject: `【ご予約確認】${dateLabel} ${time} — MONTH COLOR`,
    html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans',Meiryo,sans-serif;background:#f5f5f5;padding:32px 16px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">

    <!-- ヘッダー -->
    <div style="background:#1a1a1a;padding:28px 32px;">
      <p style="color:#c9a87a;font-size:11px;letter-spacing:3px;margin:0 0 6px;">MONTH COLOR</p>
      <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600;">ご予約を受け付けました</h1>
    </div>

    <!-- 本文 -->
    <div style="padding:32px;">
      <p style="color:#333;line-height:1.8;margin:0 0 24px;">
        ${name} 様<br><br>
        ご予約いただきありがとうございます。<br>
        以下の内容で予約を受け付けました。
      </p>

      <!-- 予約詳細 -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:12px 0;color:#888;font-size:13px;width:30%;">日時</td>
          <td style="padding:12px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${dateLabel}　${time}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:12px 0;color:#888;font-size:13px;">メニュー</td>
          <td style="padding:12px 0;color:#1a1a1a;font-size:14px;">${menuName || '—'}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:12px 0;color:#888;font-size:13px;">お名前</td>
          <td style="padding:12px 0;color:#1a1a1a;font-size:14px;">${name} 様</td>
        </tr>
        ${phone ? `
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:12px 0;color:#888;font-size:13px;">電話番号</td>
          <td style="padding:12px 0;color:#1a1a1a;font-size:14px;">${phone}</td>
        </tr>` : ''}
        ${memo ? `
        <tr>
          <td style="padding:12px 0;color:#888;font-size:13px;">備考</td>
          <td style="padding:12px 0;color:#1a1a1a;font-size:14px;">${memo}</td>
        </tr>` : ''}
      </table>

      <!-- サロン情報 -->
      <div style="background:#f9f6f2;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="color:#888;font-size:11px;margin:0 0 10px;letter-spacing:1px;">SALON INFO</p>
        <p style="color:#333;font-size:13px;line-height:1.8;margin:0;">
          <strong>MONTH COLOR 東陽町</strong><br>
          東京都江東区東陽町<br>
          営業時間: 10:00〜19:00（不定休）
        </p>
      </div>

      <p style="color:#888;font-size:12px;line-height:1.8;margin:0;">
        ご変更・キャンセルのご連絡はお電話にてお願いいたします。<br>
        当日のキャンセルはご遠慮ください。<br><br>
        ご不明な点がございましたらお気軽にお問い合わせください。
      </p>
    </div>

    <!-- フッター -->
    <div style="background:#f5f5f5;padding:20px 32px;border-top:1px solid #e8e8e8;">
      <p style="color:#aaa;font-size:11px;margin:0;text-align:center;">
        © MONTH COLOR — このメールに心当たりがない場合は無視してください。
      </p>
    </div>
  </div>
</body>
</html>`,
  });

  console.log(`📧 確認メール送信: ${email}`);
}

// ── キュー保存 ─────────────────────────────────────────────────
async function saveQueue(queue) {
  const content = JSON.stringify(queue, null, 2);
  await put(QUEUE_KEY, content, {
    access:        'public',
    token:         process.env.BLOB_READ_WRITE_TOKEN,
    allowOverwrite: true,
    contentType:   'application/json',
    addRandomSuffix: false,
  });
}
