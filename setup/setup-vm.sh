#!/bin/bash
# HPB SalonBoard 自動同期 — Oracle Cloud Ubuntu セットアップ
# 使い方: bash setup-vm.sh
# または環境変数で渡す:
#   SALONBOARD_LOGIN_ID=xxx SALONBOARD_PASSWORD=xxx BLOB_TOKEN=xxx bash setup-vm.sh
set -e

APP_DIR="$HOME/hpb-calendar"

# ── クレデンシャル確認 ──────────────────────────────
if [ -z "$SALONBOARD_LOGIN_ID" ]; then
  read -rp "SalonBoard ログインID: " SALONBOARD_LOGIN_ID
fi
if [ -z "$SALONBOARD_PASSWORD" ]; then
  read -rsp "SalonBoard パスワード: " SALONBOARD_PASSWORD
  echo
fi
if [ -z "$BLOB_TOKEN" ]; then
  read -rsp "Vercel Blob Token (BLOB_READ_WRITE_TOKEN): " BLOB_TOKEN
  echo
fi

echo '─── [1/8] スワップ 2GB 追加 (Playwright は 1GB RAM では不足) ───'
if swapon --show 2>/dev/null | grep -q /swapfile; then
  echo '  → スワップ確認済み（スキップ）'
else
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo '  → スワップ 2GB を有効化'
fi
free -h

echo '─── [2/8] Node.js 20 インストール ───'
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo '─── [3/8] リポジトリ取得 ───'
if [ -d "$APP_DIR/.git" ]; then
  echo "  → 既存リポジトリを pull"
  cd "$APP_DIR"
  git pull --ff-only
else
  git clone --depth=1 https://github.com/tatsuhirot/monthcolor-reservation.git "$APP_DIR"
  cd "$APP_DIR"
fi

echo '─── [4/8] npm パッケージインストール ───'
npm ci --omit=dev

echo '─── [5/8] Playwright Firefox インストール ───'
npx playwright install firefox --with-deps

echo '─── [6/8] 環境変数設定 ───'
cat > "$APP_DIR/.env" << ENVEOF
SALONBOARD_LOGIN_ID=${SALONBOARD_LOGIN_ID}
SALONBOARD_PASSWORD=${SALONBOARD_PASSWORD}
BLOB_READ_WRITE_TOKEN=${BLOB_TOKEN}
ENVEOF
chmod 600 "$APP_DIR/.env"

echo '─── [7/8] worker.js を systemd サービスとして登録 ───'
sudo tee /etc/systemd/system/hpb-worker.service > /dev/null << SERVICEEOF
[Unit]
Description=HPB Calendar Queue Worker
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/worker.js --watch
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
sudo systemctl enable hpb-worker
sudo systemctl start hpb-worker
echo "  → hpb-worker サービス開始"
sudo systemctl status hpb-worker --no-pager

echo '─── [8/8] sync_slots cron 設定 (毎日 21:00 JST = UTC 12:00) ───'
# VPS の Vercel cron (vercel.json) と重複を避けるため
# VPS 側では念押しとして毎日 AM 9時 JST (UTC 00:00) に追加実行
CRON_SLOTS="0 0 * * * cd ${APP_DIR} && node sync_slots.js >> ${HOME}/sync-slots.log 2>&1"
( crontab -l 2>/dev/null | grep -v sync_slots.js; printf '%s\n' "$CRON_SLOTS" ) | crontab -
crontab -l

echo ''
echo '✅ セットアップ完了！'
echo ''
echo '確認コマンド:'
echo '  sudo journalctl -u hpb-worker -f   # worker ログ'
echo '  tail -f ~/sync-slots.log           # slot 同期ログ'
echo '  sudo systemctl status hpb-worker   # サービス状態'
echo ''
echo '手動テスト:'
echo '  cd ~/hpb-calendar && node sync_slots.js   # スロット同期'
echo '  cd ~/hpb-calendar && node worker.js       # キュー処理（1回）'
