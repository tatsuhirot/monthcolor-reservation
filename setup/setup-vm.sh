#!/bin/bash
# HPB SalonBoard 自動同期 — Oracle Cloud Ubuntu セットアップ
# 使い方: bash setup-vm.sh
# または環境変数で渡す:
#   SALONBOARD_LOGIN_ID=xxx SALONBOARD_PASSWORD=xxx BLOB_TOKEN=xxx bash setup-vm.sh
set -e

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

echo '─── [1/7] スワップ 2GB 追加 (Playwright は 1GB RAM では不足) ───'
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

echo '─── [2/7] Node.js 20 インストール ───'
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo '─── [3/7] リポジトリ取得 ───'
rm -rf /tmp/obs-sync
git clone --depth=1 https://github.com/tatsuhirot/obsidian-sync.git /tmp/obs-sync
mkdir -p ~/hpb-calendar
cp -r /tmp/obs-sync/003_開発/hpb-calendar/. ~/hpb-calendar/
rm -rf /tmp/obs-sync
cd ~/hpb-calendar

echo '─── [4/7] npm パッケージインストール ───'
npm ci

echo '─── [5/7] Playwright Firefox インストール ───'
npx playwright install firefox --with-deps

echo '─── [6/7] 環境変数設定 ───'
cat > ~/hpb-calendar/.env << ENVEOF
SALONBOARD_LOGIN_ID=${SALONBOARD_LOGIN_ID}
SALONBOARD_PASSWORD=${SALONBOARD_PASSWORD}
BLOB_READ_WRITE_TOKEN=${BLOB_TOKEN}
ENVEOF
chmod 600 ~/hpb-calendar/.env

echo '─── [7/7] cron 設定 (毎時 09:00-20:00 JST) ───'
# JST 09-20時 = UTC 00-11時
CRON="0 0-11 * * * cd $HOME/hpb-calendar && node sync_slots.js >> $HOME/sync-slots.log 2>&1"
( crontab -l 2>/dev/null | grep -v sync_slots.js; printf '%s\n' "$CRON" ) | crontab -
crontab -l

echo ''
echo '✅ セットアップ完了！'
echo '今すぐテスト: cd ~/hpb-calendar && node sync_slots.js'
echo 'ログ確認:     tail -f ~/sync-slots.log'
echo ''
echo '⚠️  セキュリティ: このファイルを削除してください'
echo '   rm ~/setup-vm.sh'
