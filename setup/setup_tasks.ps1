# ============================================================
# MONTH COLOR — Windows タスクスケジューラ セットアップ
# ============================================================
# 使い方（管理者権限の PowerShell で実行）:
#   cd 003_開発\hpb-calendar\setup
#   powershell -ExecutionPolicy Bypass -File setup_tasks.ps1
#
# 登録されるタスク:
#   1. MonthColor-Worker  : ログイン時に worker.js --watch を起動
#      （空き枠同期も1時間ごとに自動実行）
# ============================================================

$ErrorActionPreference = "Stop"

# ── プロジェクトパスを自動解決 ─────────────────────────────────
$setupDir   = $PSScriptRoot
$projectDir = Split-Path $setupDir -Parent
$batFile    = Join-Path $setupDir "run_worker_watch.bat"

Write-Host ""
Write-Host "=== MONTH COLOR タスクスケジューラ セットアップ ===" -ForegroundColor Cyan
Write-Host "プロジェクトパス: $projectDir"
Write-Host ""

# ── .env の存在確認 ────────────────────────────────────────────
$envFile = Join-Path $projectDir ".env"
if (-not (Test-Path $envFile)) {
  Write-Warning ".env が見つかりません: $envFile"
  Write-Warning "SALONBOARD_LOGIN_ID / SALONBOARD_PASSWORD / BLOB_READ_WRITE_TOKEN を設定してから再実行してください"
  exit 1
}
Write-Host "✅ .env 確認OK" -ForegroundColor Green

# ── node.exe のパスを確認 ──────────────────────────────────────
$nodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $nodePath) {
  Write-Error "node.exe が見つかりません。Node.js をインストールしてください。"
  exit 1
}
Write-Host "✅ node.exe: $nodePath" -ForegroundColor Green

# ── bat ファイルを動的生成（パスをハードコード） ──────────────────
$batContent = @"
@echo off
cd /d "$projectDir"
set PLAYWRIGHT_HEADLESS=true
echo [%DATE% %TIME%] MonthColor Worker 起動 >> logs\worker.log 2>&1
node worker.js --watch >> logs\worker.log 2>&1
"@
Set-Content -Path $batFile -Value $batContent -Encoding UTF8
Write-Host "✅ バッチファイル生成: $batFile" -ForegroundColor Green

# ── ログフォルダ作成 ──────────────────────────────────────────
$logDir = Join-Path $projectDir "logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}
Write-Host "✅ ログフォルダ: $logDir" -ForegroundColor Green

# ── 既存タスクを削除してから再登録 ────────────────────────────
$taskName = "MonthColor-Worker"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "♻️  既存タスク '$taskName' を削除して再登録します"
}

# ── タスク定義 ─────────────────────────────────────────────────
# トリガー: ログオン時 + システム起動時（どちらか先に発火した方）
$triggerLogon  = New-ScheduledTaskTrigger -AtLogOn
$triggerBoot   = New-ScheduledTaskTrigger -AtStartup

# アクション: bat ファイルを実行（最小化ウィンドウ）
$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c `"$batFile`"" `
  -WorkingDirectory $projectDir

# 設定: 失敗時5分後にリトライ（最大3回）、実行中でも再起動しない
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -MultipleInstances IgnoreNew

# 現在のユーザーで実行（パスワード不要 / ログイン中のみ）
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Highest

Register-ScheduledTask `
  -TaskName $taskName `
  -Trigger @($triggerLogon, $triggerBoot) `
  -Action $action `
  -Settings $settings `
  -Principal $principal `
  -Description "MONTH COLOR 予約ワーカー (queue処理 + 空き枠同期)" | Out-Null

Write-Host ""
Write-Host "✅ タスク '$taskName' を登録しました" -ForegroundColor Green
Write-Host ""
Write-Host "── 登録内容 ─────────────────────────────────────────"
Write-Host "  タスク名   : $taskName"
Write-Host "  実行タイミング: ログオン時 / システム起動時"
Write-Host "  実行内容   : node worker.js --watch"
Write-Host "              └ 60秒ごとに予約キュー処理"
Write-Host "              └ 1時間ごとに空き枠同期（sync_slots.js）"
Write-Host "  ログ出力   : $logDir\worker.log"
Write-Host "────────────────────────────────────────────────────"
Write-Host ""
Write-Host "今すぐ起動する場合:" -ForegroundColor Yellow
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
Write-Host ""
Write-Host "手動で停止する場合:" -ForegroundColor Yellow
Write-Host "  Stop-ScheduledTask -TaskName '$taskName'"
Write-Host ""
