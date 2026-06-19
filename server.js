/**
 * server.js
 * ローカル開発用APIサーバー。api/ 配下の Serverless 関数（/api/reserve など）を
 * 動的にマウントし、admin/register/report 等の静的ページを配信する。
 *
 * 予約のSalonBoard送信は api/reserve.js → reservations-queue.json → worker.js が担う
 * （かつてここに在った Playwright 直叩きの POST /api/reserve は worker.js へ移管済み・削除）。
 *
 * 起動: node server.js
 * ポート: 3001（環境変数 PORT で変更可能）
 *
 * .env に以下を設定してください:
 *   ALLOWED_ORIGINS=https://your-reservation-site.vercel.app
 *   SYNC_TRIGGER_SECRET=...   （セッション更新・手動同期トリガー用）
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS 設定 ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.startsWith('http://localhost') || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: ${origin} は許可されていません`));
    }
  }
}));
app.use(express.json());

// ── 静的HTML配信 & ページルーティング ────────────────────────────
app.use(express.static(__dirname));
app.get('/admin',     (_, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/register',  (_, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/report',    (_, res) => res.sendFile(path.join(__dirname, 'report.html')));
app.get('/customers', (_, res) => res.sendFile(path.join(__dirname, 'customers.html')));
app.get('/reserve',   (_, res) => res.sendFile(path.join(__dirname, 'reservation.html')));
app.get('/close',     (_, res) => res.sendFile(path.join(__dirname, 'close.html')));

// ── api/ フォルダのServerless関数をローカルでマウント ────────────
const apiDir = path.join(__dirname, 'api');
fs.readdirSync(apiDir).filter(f => f.endsWith('.js')).forEach(file => {
  const name = file.replace('.js', '');
  try {
    const handler = require(path.join(apiDir, file));
    app.all(`/api/${name}`, handler);
    console.log(`  ✓ /api/${name}`);
  } catch(e) { console.warn(`  ✗ /api/${name}: ${e.message}`); }
});

// ── ヘルスチェック ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── セッションファイルアップロード ─────────────────────────────
// 任意のPCから node update-session.js で呼び出す（SSH不要）
app.post('/api/upload-session', (req, res) => {
  const secret = process.env.SYNC_TRIGGER_SECRET;
  if (!secret || req.headers['x-sync-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: '認証エラー' });
  }
  const { session } = req.body;
  if (!session || typeof session !== 'object') {
    return res.status(400).json({ ok: false, error: 'session が不正です' });
  }
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(session, null, 2), 'utf-8');
  console.log('📤 セッションファイル更新完了（リモートアップロード）');
  res.json({ ok: true, message: 'セッション更新完了' });
});

// ── 手動同期トリガー ───────────────────────────────────────────
// 自社サイトの管理画面から「今すぐ同期」ボタンで呼び出す
app.post('/api/trigger-sync', (req, res) => {
  const secret = process.env.SYNC_TRIGGER_SECRET;
  if (!secret || req.headers['x-sync-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: '認証エラー' });
  }
  const { spawn } = require('child_process');
  const proc = spawn('node', ['sync_slots.js'], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  proc.unref();
  console.log(`🔄 手動同期トリガー (pid: ${proc.pid})`);
  res.json({ ok: true, message: '同期を開始しました', pid: proc.pid });
});

// ── セッション管理 ─────────────────────────────────────────────
const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

// ── 起動 ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ ローカルAPIサーバー起動: http://localhost:${PORT}`);
  console.log(`   POST /api/reserve — 予約受付（api/reserve.js → worker.js が送信）`);
  console.log(`   GET  /health      — ヘルスチェック\n`);
});
