/**
 * start.js — 予約システム 一発起動スクリプト
 *
 * やること:
 *   1. server.js (APIサーバー) を起動
 *   2. Cloudflare Tunnel を起動して公開URL を取得
 *   3. reservation.html の SERVER_URL を自動更新
 *   4. Vercel に自動再デプロイ
 *
 * 使い方:
 *   node start.js
 *
 * 終了:
 *   Ctrl+C
 */

require('dotenv').config();
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PORT             = process.env.PORT || 3001;
const RESERVATION_HTML = path.join(__dirname, 'reservation.html');

// ── メイン ───────────────────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' MONTH COLOR 予約システム 起動');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. APIサーバーをバックグラウンドで起動
  console.log('⏳ [1/4] APIサーバーを起動中...');
  const server = startServer();
  await sleep(2000); // サーバー起動待ち

  // 2. Cloudflare Tunnel を起動してURLを取得
  console.log('⏳ [2/4] Cloudflare Tunnel を起動中（最大30秒）...');
  let tunnelUrl;
  try {
    tunnelUrl = await startTunnel();
  } catch (err) {
    console.error('❌ トンネル起動失敗:', err.message);
    server.kill();
    process.exit(1);
  }
  console.log(`✅ [2/4] 公開URL取得: ${tunnelUrl}`);

  // 3. reservation.html の SERVER_URL を更新
  console.log('⏳ [3/4] reservation.html を更新中...');
  updateServerUrl(tunnelUrl);
  console.log('✅ [3/4] SERVER_URL 更新完了');

  // 4. Vercel に再デプロイ
  console.log('⏳ [4/4] Vercel にデプロイ中...');
  try {
    const vercelUrl = await deployToVercel();
    console.log(`✅ [4/4] デプロイ完了: ${vercelUrl}`);
  } catch (err) {
    console.warn('⚠️  Vercel デプロイに失敗しました:', err.message);
    console.warn('   手動で vercel --prod を実行してください');
  }

  // 起動完了
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' 予約システム 稼働中！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` API サーバー : http://localhost:${PORT}`);
  console.log(` 公開 API URL : ${tunnelUrl}`);
  console.log(' 終了するには : Ctrl+C');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Ctrl+C で全プロセス終了
  process.on('SIGINT', () => {
    console.log('\n🛑 停止中...');
    server.kill();
    process.exit(0);
  });

  // サーバーが落ちたら通知
  server.on('exit', (code) => {
    if (code !== null) console.error(`❌ APIサーバーが停止しました (code: ${code})`);
  });
}

// ── APIサーバー起動（バックグラウンド） ──────────────────────────
function startServer() {
  const proc = spawn('node', ['server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: __dirname,
  });
  proc.stdout.on('data', d => process.stdout.write(d));
  proc.stderr.on('data', d => process.stderr.write(d));
  return proc;
}

// ── Cloudflare Tunnel 起動 → URL 取得 ────────────────────────────
function startTunnel() {
  return new Promise((resolve, reject) => {
    const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (data) => {
      const text = data.toString();
      // trycloudflare.com の URL をキャプチャ
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) resolve(match[0]);
    };

    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    cf.on('error', reject);

    // 30秒でタイムアウト
    setTimeout(() => reject(new Error('トンネル起動タイムアウト（30秒）')), 30_000);
  });
}

// ── reservation.html の SERVER_URL を書き換え ─────────────────────
function updateServerUrl(url) {
  let html = fs.readFileSync(RESERVATION_HTML, 'utf8');
  const updated = html.replace(
    /const SERVER_URL = '[^']*';/,
    `const SERVER_URL = '${url}';`
  );
  if (html === updated) {
    console.warn('⚠️  SERVER_URL の書き換えパターンが見つかりませんでした');
    return;
  }
  fs.writeFileSync(RESERVATION_HTML, updated, 'utf8');
}

// ── Vercel デプロイ ───────────────────────────────────────────────
function deployToVercel() {
  return new Promise((resolve, reject) => {
    const v = spawn('vercel', ['--prod', '--yes'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: __dirname,
    });

    let deployedUrl = '';
    v.stdout.on('data', (d) => {
      const text = d.toString();
      const match = text.match(/https:\/\/[^\s]+\.vercel\.app/);
      if (match) deployedUrl = match[0];
    });
    v.stderr.on('data', d => process.stderr.write(d));

    v.on('close', (code) => {
      if (code === 0) resolve(deployedUrl || '(URLの取得に失敗)');
      else reject(new Error(`exit code ${code}`));
    });
    v.on('error', reject);
  });
}

// ── ユーティリティ ────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('❌ 起動エラー:', err.message);
  process.exit(1);
});
