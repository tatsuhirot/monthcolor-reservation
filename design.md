---
author: claude
type: wiki
created: 2026-04-15
tags: [HPB, 予約管理, カレンダー, 設計]
source: ""
---

# HPBカレンダー連携システム 設計書

## 概要

ホットペッパービューティー（HPB）の予約を自作カレンダーで一元管理し、
カレンダーからHPB（サロンボード）へ予約を書き込む双方向システム。

---

## 全体アーキテクチャ

**双方向同期が必須**（自作カレンダーでも予約を受けるため、ダブルブッキング防止）

```
╔══════════════════╗        ╔══════════════════════╗
║  ホットペッパー  ║        ║    自作カレンダー    ║
║  (サロンボード)  ║        ║  (Web UI / Google)   ║
╚══════════════════╝        ╚══════════════════════╝
        │                              │
  予約通知メール                   予約登録
        │                              │
        ▼                              ▼
  Gmail API解析                 Playwright で
  → DB保存                      サロンボードへ書き込み
  → カレンダー空き枠を閉じる    → DB保存
                                → カレンダー空き枠を閉じる
```

### 同期ルール

| イベント | 処理 |
|---|---|
| HPBで予約が入る | メール解析 → 自作カレンダーの空き枠を閉じる |
| 自作カレンダーで予約が入る | Playwright → サロンボードの空き枠を閉じる |
| どちらかでキャンセル | 相手側にも即時反映 |

---

## 技術スタック

| レイヤー | 技術 | 用途 |
|---|---|---|
| メール解析 | Gmail API（既存MCP活用） | HPB通知メールの受信・パース |
| ブラウザ自動化 | Playwright（Python） | サロンボードへの予約書き込み |
| DB | SQLite | 予約データのローカル保存 |
| カレンダーUI | Google Calendar API | 予約の表示・入力 |
| Web UI（Phase 3） | FullCalendar.js | 独自カレンダー画面 |
| スケジューラ | cron | メール監視・定期同期 |
| 実行環境 | Python + uv | 既存環境を使用 |

---

## HPB通知メール パース仕様

### 取得項目

| 項目 | メール内の形式（例） | 変数名 |
|---|---|---|
| 予約日時 | `4月20日（日）14:00` | `reserved_at` |
| お客様名 | `山田 太郎 様` | `customer_name` |
| 施術メニュー | `カット＋カラー` | `menu` |
| 担当スタッフ | `田中 花子` | `staff_name` |
| 予約番号 | `HPB-12345678` | `hpb_reservation_id` |
| 店舗名 | `○○サロン 上野店` | `salon_name` |

### パース方法

- 送信元アドレスでHPBメールをフィルタ
- 正規表現で各項目を抽出
- パース失敗時はSlack/LINE通知 → 手動確認

---

## サロンボード 書き込み仕様（Playwright）

### 操作フロー

```
1. salonboard.com にログイン（環境変数から認証情報取得）
2. 予約入力画面に遷移
3. 日時・顧客名・メニュー・スタッフを入力
4. 確認画面 → 登録ボタンをクリック
5. 完了確認 → DBのステータスを「sync済み」に更新
```

### 注意事項

- ログイン情報は `.credentials/.env` で管理（gitignore済み）
- HPBのUI変更でスクリプトが壊れるリスクあり → セレクタはcss/xpathで堅牢に書く
- 書き込み失敗時はリトライ3回 → 失敗ログを記録

---

## DBスキーマ（SQLite）

```sql
CREATE TABLE reservations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  hpb_id          TEXT UNIQUE,          -- HPB予約番号
  reserved_at     DATETIME NOT NULL,    -- 予約日時
  customer_name   TEXT NOT NULL,        -- お客様名
  menu            TEXT,                 -- 施術メニュー
  staff_name      TEXT,                 -- 担当スタッフ
  salon_name      TEXT,                 -- 店舗名
  source          TEXT DEFAULT 'hpb',   -- hpb / manual
  sync_status     TEXT DEFAULT 'pending', -- pending / synced / failed
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## フォルダ構成

```
003_開発/hpb-calendar/
├── design.md              ← この設計書
├── main.py                ← エントリーポイント
├── gmail_parser.py        ← HPBメール解析
├── salonboard_writer.py   ← Playwrightによる書き込み
├── calendar_sync.py       ← Google Calendar同期
├── db.py                  ← SQLite操作
├── scheduler.py           ← cron定期実行
├── config.py              ← 設定（env読み込み）
└── tests/
    ├── test_gmail_parser.py
    └── test_db.py
```

---

## 開発フェーズ

### Phase 1 ― メール → カレンダー（読み込み）
- [ ] Gmail APIでHPB通知メールを取得
- [ ] 正規表現パーサー作成
- [ ] SQLite DBへの保存
- [ ] Google Calendarへの登録

### Phase 2 ― 双方向同期（ダブルブッキング防止）
- [ ] Playwrightでサロンボードログイン確認
- [ ] 予約入力フォームのセレクタ調査
- [ ] 自作カレンダー → サロンボード 書き込みスクリプト
- [ ] キャンセル時の双方向反映
- [ ] エラーハンドリング・リトライ実装（失敗時は通知）

### Phase 3 ― Web UI（独自カレンダー画面）
- [ ] FullCalendar.js で月表示カレンダー
- [ ] 予約一覧・詳細画面
- [ ] 手動予約登録フォーム

---

## リスク・制約

| リスク | 対策 |
|---|---|
| HPBのUI変更でPlaywrightが壊れる | セレクタを定期確認 / 変更検知テスト |
| HPB利用規約のスクレイピング禁止 | 自分のアカウント・自分のサロンのみで使用 |
| メールフォーマットの変更 | パーサーのテストケースを充実させる |
| サロンボードのログイン2FA | 2FAなし設定で運用 or SMS取得自動化 |
