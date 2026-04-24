---
author: claude
type: wiki
created: 2026-04-24
tags: [VM, Oracle Cloud, SSH, setup]
source: ""
---

# Oracle Cloud VM 接続ガイド

## 接続情報

| 項目 | 値 |
|---|---|
| IP アドレス | `161.33.204.85` |
| ユーザー名 | `ubuntu` |
| SSH 鍵 | `C:\Users\tatsu\Obsidian\.credentials\oracle-hpb-ubuntu.key` |
| OS | Ubuntu (Oracle Cloud Always Free) |

---

## SSH 接続

PowerShell で実行：

```powershell
ssh -i "$env:USERPROFILE\Obsidian\.credentials\oracle-hpb-ubuntu.key" ubuntu@161.33.204.85
```

---

## よく使うコマンド（VM内）

### コード更新

```bash
cd ~/hpb-calendar && git pull --ff-only
```

### sync_slots を手動テスト

```bash
cd ~/hpb-calendar && node sync_slots.js
```

### worker サービス操作

```bash
# 状態確認
sudo systemctl status hpb-worker

# ログをリアルタイムで見る
sudo journalctl -u hpb-worker -f

# 再起動
sudo systemctl restart hpb-worker

# 停止 / 起動
sudo systemctl stop hpb-worker
sudo systemctl start hpb-worker
```

### 設定確認

```bash
# .env の中身確認
cat ~/hpb-calendar/.env

# cron 確認
crontab -l

# スワップ確認
free -h
```

---

## スクリーンショットをローカルにダウンロード

**ローカルの PowerShell** で実行：

```powershell
# ログイン前の画面（診断用）
scp -i "$env:USERPROFILE\Obsidian\.credentials\oracle-hpb-ubuntu.key" ubuntu@161.33.204.85:/tmp/salonboard-before-login.png "$env:USERPROFILE\Downloads\salonboard-before-login.png"

# ログイン失敗時の画面
scp -i "$env:USERPROFILE\Obsidian\.credentials\oracle-hpb-ubuntu.key" ubuntu@161.33.204.85:/tmp/salonboard-login-fail.png "$env:USERPROFILE\Downloads\salonboard-login-fail.png"
```

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `Permission denied (publickey)` | 鍵のパスが違う | Downloads に `ssh-key-2026-04-23.key` があるか確認 |
| `Connection refused` | VM が停止中 | Oracle Cloud コンソールでインスタンスを起動 |
| 接続タイムアウト | IP が変わった | コンソールで IP が `161.33.204.85` のまま確認 |
| `WARNING: UNPROTECTED PRIVATE KEY FILE!` | 鍵のパーミッションが広すぎる | 下記コマンドで修正 |

### 鍵のパーミッション修正（PowerShell）

```powershell
icacls "$env:USERPROFILE\Obsidian\.credentials\oracle-hpb-ubuntu.key" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

---

## VM の構成メモ

| 項目 | 内容 |
|---|---|
| プロバイダー | Oracle Cloud Always Free (東京リージョン) |
| スペック | VM.Standard.E2.1.Micro (AMD, 1GB RAM + 2GB スワップ) |
| アプリディレクトリ | `~/hpb-calendar` |
| リポジトリ | `https://github.com/tatsuhirot/monthcolor-reservation.git` |
| systemd サービス | `hpb-worker.service` (worker.js --watch) |
| cron | 毎日 09:00 JST に sync_slots.js を実行 |
