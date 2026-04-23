/**
 * api/test-email.js — メール送信テスト用エンドポイント（開発・診断用）
 *
 * GET /api/test-email?to=xxx@example.com
 * Resend API でテストメールを送信し、レスポンスをそのまま返す。
 * ADMIN_PASSWORD をクエリパラメータで認証（?pwd=xxx）
 */

require('dotenv').config();
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const { to } = req.query;
  if (!to) {
    return res.status(400).json({ error: '?to=メールアドレス が必要です' });
  }

  // 環境変数チェック
  const envCheck = {
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    MAIL_FROM:      process.env.MAIL_FROM || '(未設定 — デフォルト使用)',
    to,
  };

  if (!process.env.RESEND_API_KEY) {
    return res.status(200).json({ error: 'RESEND_API_KEY 未設定', envCheck });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    const result = await resend.emails.send({
      from:    process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
      to,
      subject: '【テスト】MONTH COLOR メール送信確認',
      html: `
<body style="font-family:sans-serif;padding:32px;">
  <h2>メール送信テスト</h2>
  <p>このメールが届いていれば、Resend の設定は正常です。</p>
  <p>送信時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</p>
</body>`,
    });

    return res.status(200).json({
      success: true,
      resendResponse: result,
      envCheck,
    });

  } catch (err) {
    return res.status(200).json({
      success: false,
      error:   err.message,
      detail:  err,
      envCheck,
    });
  }
};
