@echo off
chcp 65001 >nul
cd /d %~dp0

echo.
echo ====================================
echo   予約ワーカー起動（ローカルPC）
echo ====================================
echo.
echo 予約キューを監視中... 止めるには Ctrl+C
echo.

:: Node.js確認
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [エラー] Node.js がインストールされていません。
  pause
  exit /b 1
)

:: 依存パッケージ確認
if not exist "node_modules" (
  echo 初回セットアップ中...
  call npm install
  echo.
)

node worker.js --watch
pause
