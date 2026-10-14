# アーキテクチャ

## 全体像

furca は Cloudflare Worker 1本 + D1 + KV で完結する。Docker もサーバーも不要で、利用者は自分の Cloudflare
アカウントに Alchemy でデプロイする（BYOC）。

```
アプリ ── @furca/sdk ──► GET  /api/sdk/v1/payload/:sdkKey   KV から設定を取得し、SDK 内でローカル評価
                    └──► POST /api/sdk/v1/events/:sdkKey    露出・イベントを D1 に保存（Bot 除外）

furca Worker
├── apps/web          TanStack Start の管理画面（HeroUI v3）
├── /api/rpc          oRPC v2 の contract-first API。ハンドラは Effect 4 のサービスを使う
├── /api/auth         Better Auth（最初のユーザーがオーナー、以降は招待制）
├── D1                flag / 実験 / 指標 / 露出 / イベント / 結果スナップショット / 監査ログ
├── KV                環境ごとの SDK ペイロード（変更のたびに再生成）
└── Cron（毎時）      実行中の実験の結果を再計算
```

## 技術選定と理由

| 領域 | 採用 | 理由 |
|---|---|---|
| 実行環境 | Cloudflare Workers | 利用者のアカウントだけで完結。SDK 配信がエッジで速い |
| DB | D1 | 追加契約不要。設定・露出・イベントを1か所に。上限（10GB / クエリ30秒）は ponytail コメントに明記 |
| 設定配信 | KV | 書き込みは設定変更時のみ、読み取りは大量。KV の特性にそのまま合う |
| IaC | Alchemy v2 | Effect ベースで型付き。D1 マイグレーションをデプロイ時に適用し、CI からそのまま使える |
| API | oRPC v2 + Effect 4 | 契約（`packages/api/src/contract.ts`）をブラウザと共有。`.effect()` ハンドラで Effect サービスを注入 |
| ORM | Drizzle 1.0 (RQB v2) | zcareer と同じ書き味。マイグレーションは drizzle-kit v1 形式で Alchemy が直接適用 |
| UI | TanStack Start + HeroUI v3 | React Aria ベースでアクセシビリティが担保される。テーマは OKLCH トークンで上書き |
| 統計 | 自前の `@furca/stats`（GrowthBook gbstats の移植） | Python 不要。GrowthBook の数値ベクトルで検証済み |
| BigQuery | `jose` + REST | 公式 `@google-cloud/bigquery` は Workers で動かない（Node 依存・巨大）。保守されている `jose` で JWT を作る |
| Snowflake | `jose` + SQL API v2 | キーペア認証の JWT をリクエストごとに署名。Node ドライバは Workers で動かない |
| ClickHouse | `@clickhouse/client-web` | 公式の fetch ベースクライアント。セッション設定を送らないので readonly ユーザーでも動く |
| Postgres | `postgres`（porsager） | `workerd` 条件で `cloudflare:sockets` を使う。リクエストごとに接続して必ず閉じる（Workers はソケットを共有できない） |

## レイヤー（zcareer に準拠）

```
apps/web ─► packages/api ─► packages/persistence ─► packages/database
                    │                  │
                    └──────────────────┴─► packages/core（ドメインモデル・サービス契約・エラー）
packages/integrations（BigQuery / Snowflake / ClickHouse / Postgres）◄─ persistence の分析サービス
packages/stats / packages/sdk は依存なしの純粋パッケージ（ブラウザでも使う）
```

zcareer との意図的な差分:

| 項目 | zcareer | furca | 理由 |
|---|---|---|---|
| RPC | Effect RPC | oRPC v2（Effect 統合） | 要望。TanStack Query との統合と OSS 利用者の馴染みやすさ |
| DB | PostgreSQL + Hyperdrive | D1 | Cloudflare だけで完結させるため |
| トランザクション | `Database.transaction` | `db.batch` | D1 は対話的トランザクションを持たない |
| 時刻 | `DateTime.Utc` | `Date` | oRPC のシリアライザが Date をネイティブに扱うため、DB〜ワイヤーまで1型で通す |
| wire 型 | `*Request` / `*Response` を別定義 | core の Schema をそのまま出力型に使う | 小さな OSS で詰め替え DTO を増やさない |

## 実験の正しさを守る仕組み

- **割当**: GrowthBook 互換 FNV-1a v2 ハッシュ。同じ seed + ユーザーなら常に同じ variation
- **フェーズ**: 比率変更・ターゲティング変更・カバレッジ縮小は新フェーズ + 新 seed を強制（`trafficChangeNeedsNewPhase`）
- **分析単位**: 露出は (ユーザー, 実験, variation) ごとに最初の時刻だけ保存。2つ以上の variation を見たユーザーは除外して件数を表示
- **集計**: D1 と各ウェアハウス（SQL は `AnalysisSql.ts` の1つのビルダーを方言ごとに切り替え）のどれも「variation × 初回露出日」ごとの十分統計量（n, Σy, Σy², ratio と CUPED の積和）を返す。加算可能なので累積推移も同じデータから計算できる
- **検定**: 既定は逐次検定（覗き見しても誤り率が保たれる）。SRM（p < 0.001）や多重露出 1% 以上は結論の表示をブロックする
- **多重比較**: Holm 補正は「主要指標 × treatment」と「副指標 × treatment」を別ファミリーとして行う。副指標を増やしても意思決定に使う主要指標の検出力は落ちない（Optimizely / Eppo と同じ考え方）。ガードレールは見逃しの方が高コストなので補正しない

## ローカルでのデモデータ

`bun scripts/seed-demo.ts http://localhost:5173` でフラグ・指標・実行中の実験と、実際の SDK で振り分けた模擬トラフィックを投入する（`.env` の `DEV_OWNER_EMAIL` / `DEV_OWNER_PASSWORD` でサインイン）。
