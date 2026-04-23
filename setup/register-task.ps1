# SalonBoard 空き枠 自動同期 — Windows タスクスケジューラ登録スクリプト
# 使い方: PowerShell を「管理者として実行」してから
#   cd C:\Users\tatsu\Obsidian\003_開発\hpb-calendar\setup
#   .\register-task.ps1

$taskName    = "HPB-SyncSlots"
$scriptDir   = "C:\Users\tatsu\Obsidian\003_開発\hpb-calendar"
$nodeExe     = (Get-Command node).Source

# 既存タスクがあれば削除
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "既存タスクを削除しました"
}

# npm run sync:slots を実行するアクション
$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument "sync_slots.js" `
    -WorkingDirectory $scriptDir

# 毎時 0分 に実行（09:00〜20:00）
$triggers = @()
foreach ($h in 9..20) {
    $time = "{0:D2}:00" -f $h
    $triggers += New-ScheduledTaskTrigger -Daily -At $time
}

# 設定: ネットワーク接続時のみ / バッテリー駆動でも実行
$settings = New-ScheduledTaskSettingsSet `
    -RunOnlyIfNetworkAvailable `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -RunLevel Highest `
    -Description "SalonBoard 空き枠を毎時スクレイピングして Vercel Blob に保存" `
    | Out-Null

Write-Host ""
Write-Host "✅ タスク '$taskName' を登録しました"
Write-Host "   実行時刻: 毎日 09:00〜20:00（毎時0分）"
Write-Host "   確認: タスクスケジューラ > $taskName"
Write-Host ""
Write-Host "今すぐテスト実行:"
Write-Host "   Start-ScheduledTask -TaskName '$taskName'"
