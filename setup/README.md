# セットアップ手順

## 初回セットアップ

### 1. 依存関係インストール

```bash
cd 003_開発/hpb-calendar
npm install
npx playwright install firefox --with-deps  # ⚠️ Firefox 必須（SalonBoardがChromiumをbot判定）
```

### 2. 環境変数を設定

`.env` ファイルを作成（`.env.example` をコピーして編集）：

```
SALONBOARD_LOGIN_ID=your_login_id
SALONBOARD_PASSWORD=your_password
BLOB_READ_WRITE_TOKEN=vercel_blob_token
ADMIN_PASSWORD=staff_password
RESEND_API_KEY=resend_api_key
MAIL_FROM=noreply@yourdomain.com
STAFF_NOTIFY_EMAIL=staff@yourdomain.com
```

### 3. SalonBoard セッションを初期化

```bash
npm run sync:slots
```
ブラウザが開くのでログイン → 自動でセッション保存される

### 4. タスクスケジューラに登録（管理者権限の PowerShell）

```powershell
cd 003_開発\hpb-calendar\setup
powershell -ExecutionPolicy Bypass -File setup_tasks.ps1
```

登録後すぐに起動する場合：
```powershell
Start-ScheduledTask -TaskName "MonthColor-Worker"
```

---

## Oracle Cloud VM セットアップ（本番稼働用）

GitHub Actions ランナーは SalonBoard に IP ブロックされるため、
**Oracle Cloud の無料 VM でcron実行**するのが本番構成です。

### VM の現在の状態（2026-04-23 時点）

| 項目 | 内容 |
|---|---|
| インスタンス名 | hpb-sync |
| シェイプ | VM.Standard.E2.1.Micro（AMD, 1 OCPU / 1GB RAM） |
| OS | Ubuntu 22.04 |
| リージョン | ap-tokyo-1 |
| ステータス | **作成済み・Public IP 未割り当て** |

### ① OCI Console で Public IP を割り当て

1. [OCI Console](https://cloud.oracle.com/) にログイン
2. **コンピュート → インスタンス → hpb-sync**
3. 「アタッチされたVNIC」タブ → Primary VNICをクリック
4. 「IPv4アドレス」→ 「編集」
5. **「予約済みパブリックIPの使用」** を選択 → 登録済みのIPを割り当て
6. 割り当てられた IP アドレスをメモ（例: `140.xxx.xxx.xxx`）

### ② SSH でログインしてセットアップ

```bash
# SSH でログイン（秘密鍵のパスは環境に合わせて変更）
ssh -i ~/.ssh/hpb-sync.key ubuntu@<PUBLIC_IP>

# セットアップスクリプトをダウンロードして実行
curl -fsSL https://raw.githubusercontent.com/tatsuhirot/obsidian-sync/main/003_%E9%96%8B%E7%99%BA/hpb-calendar/setup/setup-vm.sh \
  -o ~/setup-vm.sh
bash ~/setup-vm.sh
# → ログインID・パスワード・BlobTokenを対話入力
```

### ③ 動作確認

```bash
# 即時テスト
cd ~/hpb-calendar && node sync_slots.js

# ログ確認
tail -f ~/sync-slots.log

# cron 確認（毎時 09-20 JST で登録されているはず）
crontab -l
```

### ④ セキュリティ後処理

```bash
# セットアップスクリプト削除（認証情報のシェル履歴が残るため）
rm ~/setup-vm.sh
history -c
```

---

## 日常運用

| やること | コマンド / 場所 |
|---|---|
| ワーカー手動起動 | `npm run worker:watch` |
| 空き枠手動更新 | `npm run sync:slots` |
| 失敗予約の再処理 | `npm run worker:retry` |
| HPBメール取り込み | `npm run sync` |
| ログ確認 | `logs/worker.log` |

---

## タスクの確認・停止

```powershell
# 状態確認
Get-ScheduledTask -TaskName "MonthColor-Worker" | Get-ScheduledTaskInfo

# 手動停止
Stop-ScheduledTask -TaskName "MonthColor-Worker"

# 削除
Unregister-ScheduledTask -TaskName "MonthColor-Worker" -Confirm:$false
```

---

## ログローテーション

`logs/worker.log` は自動でローテーションされません。
定期的に削除するか、以下を `setup_tasks.ps1` 実行後に追加登録してください：

```powershell
# 毎週日曜深夜にログを削除するタスクを追加
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c del /f "C:\path\to\logs\worker.log"'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "03:00"
Register-ScheduledTask -TaskName "MonthColor-LogClean" -Action $action -Trigger $trigger
```
