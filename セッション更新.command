#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "===================================="
echo "  SalonBoard セッション更新ツール"
echo "===================================="
echo ""

# Node.js確認
if ! command -v node &> /dev/null; then
  echo "[エラー] Node.js がインストールされていません。"
  echo "マニュアルの手順1を確認してください。"
  echo ""
  read -p "Enterを押して閉じてください..."
  exit 1
fi

# 依存パッケージ確認
if [ ! -d "node_modules" ]; then
  echo "初回セットアップ中... しばらくお待ちください"
  npm install
  echo ""
fi

# スクリプト実行
node update-session.js

echo ""
read -p "Enterを押して閉じてください..."
