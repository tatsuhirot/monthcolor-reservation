#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "===================================="
echo "  予約ワーカー起動（ローカルPC）"
echo "===================================="
echo ""
echo "予約キューを監視中... 止めるには Ctrl+C"
echo ""

if ! command -v node &> /dev/null; then
  echo "[エラー] Node.js がインストールされていません。"
  read -p "Enterを押して閉じてください..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "初回セットアップ中..."
  npm install
  echo ""
fi

node worker.js --watch
