@echo off
chcp 65001 >nul
cd /d %~dp0

echo.
echo ====================================
echo   SalonBoard セッション更新ツール
echo ====================================
echo.

:: Node.js確認
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [エラー] Node.js がインストールされていません。
  echo マニュアルの手順1を確認してください。
  echo.
  pause
  exit /b 1
)

:: 依存パッケージ確認
if not exist "node_modules" (
  echo 初回セットアップ中... しばらくお待ちください
  call npm install
  echo.
)

:: スクリプト実行
node update-session.js

echo.
pause
