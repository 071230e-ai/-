# 村田鉄筋㈱ 見積データベース

## プロジェクト概要
- **アプリ名**: 村田鉄筋㈱ 見積データベース
- **目的**: 過去の見積情報をデータベース化し、元請け別・建物構造別・単価別・受注率などを確認できるようにする
- **主な機能**: 見積データのCRUD、集計ダッシュボード、グラフ表示、絞り込み、CSV/PDF出力、権限管理

## URL
- **本番URL (Cloudflare Pages)**: https://murata-tekkin-estimate.pages.dev
- **ローカル開発**: http://localhost:3000

## 認証・セキュリティ
- 管理者 / 一般ユーザーの2ロール
- 削除は管理者のみ実行可能
- 認証情報・パスワードはREADMEへ記載しない
- セッショントークン署名用の `SESSION_SECRET` はCloudflare PagesのSecretとして管理する
- `SESSION_SECRET` は十分に長いランダム文字列を使用する
- ローカル開発では `.dev.vars` に `SESSION_SECRET=...` を設定する（`.dev.vars` はGit管理対象外）

> 本番デプロイ前に Cloudflare Pages の環境変数/Secrets へ `SESSION_SECRET` を必ず登録してください。

## 主要機能

### 見積データ管理 (`/estimates`)
- 一覧表示、検索、並び替え、絞り込み
- 一覧は初期30件、以降「さらに30件表示」で追加読み込み
- 新規登録 (`/estimates/new`)
- 編集 (`/estimates/:id`)
- 削除（管理者のみ）
- 見積番号はサーバー側で自動採番
- 単価 = 見積金額 ÷ 数量 ÷ 1000 を自動計算
- 「受注」「未定」の場合は失注理由を保存しない

### 集計ダッシュボード (`/dashboard`)
- 総見積件数、受注件数、失注件数、未定件数、受注率
- 総見積金額、受注金額、平均単価、平均数量
- 月別、失注理由別、構造別、単価帯別、元請け別の集計

### CSV / PDF 出力 (`/stats/export`)
- CSVは絞り込み条件に一致する見積を全件出力
- PDFは集計ダッシュボードをA4横向きで出力

## API
| メソッド | パス | 説明 | 認証 |
| --- | --- | --- | --- |
| POST | `/api/login` | ログイン | 不要 |
| GET | `/api/health` | 最小限の稼働確認 | 不要 |
| GET | `/api/me` | 自身のユーザー情報 | 必要 |
| GET | `/api/estimates` | 見積一覧 | 必要 |
| GET | `/api/estimates/:id` | 見積詳細 | 必要 |
| POST | `/api/estimates` | 新規登録 | 必要 |
| PUT | `/api/estimates/:id` | 更新 | 必要 |
| DELETE | `/api/estimates/:id` | 削除 | 管理者 |
| GET | `/api/stats` | 集計データ | 必要 |

### 見積一覧のページング
`GET /api/estimates` では `limit` と `offset` を指定できます。

- `limit`: 1〜100件
- `offset`: 読み飛ばす件数
- `limit` を省略した場合は従来どおり全件取得するため、CSV出力の挙動は変わりません

## 技術スタック
- フロントエンド: HTML/CSS/JavaScript (SPA)、Tailwind CSS、Chart.js、jsPDF、Day.js、Axios
- バックエンド: Hono (TypeScript) on Cloudflare Workers
- データベース: Cloudflare D1 (SQLite互換)
- デプロイ: Cloudflare Pages

## データベース
- `users`: 認証ユーザー
- `estimates`: 見積データ
- `estimate_no` は `0002_estimate_no_unique.sql` 適用後にUNIQUE制約あり

## 開発・デプロイ時の注意
1. `npm install`
2. ローカルD1へマイグレーション適用
3. `.dev.vars` に `SESSION_SECRET` を設定
4. `npm run build`
5. 本番反映前にCloudflare Pages側にも `SESSION_SECRET` を登録
6. 本番D1へマイグレーション適用
7. デプロイ

## ライセンス
社内利用専用
