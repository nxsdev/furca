# 機能判断: 何を作り、何を作らないか

調査対象: GrowthBook / Statsig / Eppo(Datadog Experiments) / PostHog / LaunchDarkly / Optimizely FX / Amplitude Experiment / Bucketeer / Unleash / Flagsmith（2026-10 時点の公式 docs・ソース）

## 判断原則

v1 は次の4つを満たすことだけを目標にする。満たさない機能は「便利」でも v1 に入れない。

1. 仮説・主要メトリクス・必要サンプル数を**事前登録**できる
2. ユーザーを**決定的に**割り当てられる（同じユーザーは常に同じ variation）
3. 毎日結果を覗いても、UI が主張する誤り率が**本当に守られる**（= 逐次検定がデフォルト）
4. データが壊れている時に**判断をブロックする**（SRM・多重露出）

A/Bテスト基盤の難所は振り分けではなく「結果が信頼できること」。上位ツールが共通して持つのはこの4点で、ビジュアルエディタやバンディットは持っていないツールも多い。

## 競合比較の要約

| 能力 | GrowthBook | Statsig | Eppo | PostHog | LaunchDarkly | Bucketeer | Unleash | **furca v1** |
|---|---|---|---|---|---|---|---|---|
| Flag + ターゲティング + % rollout | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 環境 (dev/prod) | ✅ | ✅ | ✅ | △ project で代用 | ✅ | ✅ | ✅(OSS 2個) | ✅ |
| フェーズ / 再ランダム化 | ✅ | △ salt | ✗ | ✗ | ✅ iteration | △ | ✗ | ✅ 強制 |
| 指標: 比率 / 平均 / ratio | ✅ | ✅ | ✅ | ✅ | ✅ | △ | ✗ | ✅ |
| Capping (winsorize) | ✅ | ✅ | ✅ | ✅ | △ WHNのみ | ✅ p99 | ✗ | ✅ |
| CUPED | 有料 | ✅ default on | ✅ | ✅ | ✅ | ✗ | ✗ | ✅ |
| 逐次検定 | 有料 | ✅ mSPRT | ✅ default | ✅ | ✅ | ✅ SBF | ✗ | ✅ **default on** |
| Bayesian | ✅ default | ✅ | ✅ | ✅ default | ✅ | ✅ | ✗ | ✅ |
| SRM チェック | ✅ p<0.001 | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | ✅ p<0.001 |
| 多重露出の除外 | ✅ | △ | ✅ | ✅ | △ | ✗ | ✗ | ✅ |
| 検出力 / MDE 計算 | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ | ✅ |
| 意思決定 (ship / rollback) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | △ | ✅ |
| 監査ログ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bot 除外 | ✗ | ✅ | ✗ | △ | ✗ | ✗ | – | ✅ |
| Warehouse native | ✅ | ✅ WHN | ✅ | △ | ✅ | ✗ | – | ✅ BigQuery |
| 組み込みイベントストア | Cloud のみ | ✅ | ✗ | ✅ | ✅ | ✅ | – | ✅ D1 |
| Mutual exclusion | ✅ | ✅ | ✅ | ✗ | ✅ | ✗ | ✗ | v1.x |
| Holdout | 有料 | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ | skip |
| Bandit | ✅ | ✅ | ✅ | ✗ | ✅ | ✗ | ✗ | skip |
| Visual editor | ✅ | ✅ | ✗ | ✅ | ✗ | ✗ | ✗ | skip |
| セルフホスト要件 | MongoDB+Python | – | – | ClickHouse他 | – | k8s+Redis+DWH | Postgres | **Cloudflare アカウントのみ** |

## v1 で作るもの (MUST)

| # | 機能 | なぜ必要か |
|---|---|---|
| 1 | Feature flag (bool / string / number / JSON)、環境ごとの ON/OFF、順序付きルール (force / rollout / experiment) | 実験は flag に乗る。JSON は複数パラメータの実験に要る |
| 2 | 環境 (production / development) と環境ごとの SDK キー、KV へのペイロード配信 | 本番以外で試せないと事故る |
| 3 | 属性ベースのターゲティング条件 | QA 用の強制割当、社内ユーザー除外 |
| 4 | 決定的ハッシュ (GrowthBook 互換 FNV-1a v2) | 再現可能な割当。GrowthBook からの移行で再バケットされない |
| 5 | 実験のライフサイクル draft → running → stopped と**フェーズ**。比率変更・ターゲティング追加・カバレッジ縮小は**新フェーズ+新seedを強制** | SRM と持ち越しバイアスの最大要因。GrowthBook は「推奨」止まりで事故が多い |
| 6 | 露出ログ (SDK → Worker)、ユーザー×variation で重複排除、Bot 除外 | 露出がなければ分析できない |
| 7 | 指標: proportion / mean / ratio、lower-is-better、コンバージョン窓 + 遅延、capping (絶対値 / percentile) | 実務の指標の大半をカバー。売上は外れ値1人で結論が反転する |
| 8 | 統計: 相対リフト + delta 法、**逐次検定デフォルト ON**、Bayesian 切替、CUPED、Holm 補正 | 小さいチームは毎日覗く。固定ホライズン検定 + 覗き見は信頼性破綻の一番の原因 |
| 9 | ヘルスチェック: SRM (χ², p<0.001)、多重露出 (除外 + 1%以上で警告)、データ不足 | 壊れたデータでは意思決定させない |
| 10 | 事前の検出力計算 (MDE / 必要サンプル / 期間) を実験に保存 | 計画サンプル数を登録し、逐次検定の調整パラメータに使う |
| 11 | 結果: 指標ごとの信頼区間 + 露出日ベースの累積推移 | ノベルティ効果や計測破損を検知する |
| 12 | 意思決定: 停止時に ship / rollback / inconclusive + 理由を記録、勝者を1クリックで配信 | ループを閉じ、何を決めたか残す |
| 13 | 監査ログ (flag / 実験 / 指標の全変更を diff で) | 「4日目に誰が比率を変えた?」に答える |
| 14 | TypeScript SDK: ローカル評価、露出の自動送信、`track()` | 評価のたびにネットワークへ行かない |
| 15 | データソース: 組み込み (D1) と BigQuery (SQL を書けば使える) | SQL 不要で始められ、成長したら DWH に寄せられる |
| 16 | 認証: 最初のユーザーがオーナー、以降は招待制 | GrowthBook は公開サインアップを止められない (#2644) |

## v1.x で作るもの (SHOULD, 優先順)

1. Saved groups (再利用可能なオーディエンス)
2. Namespace / mutual exclusion
3. ディメンション別の内訳 (上位N + other、多重検定の注意つき)
4. Webhook / Slack 通知、OpenFeature provider (SDK の薄いラッパ)
5. Projects + ロール、本番変更の承認フロー
6. ガードレール指標による自動ロールバック (safe rollout)
7. Cron による結果の定期更新、他の DWH (ClickHouse / Postgres / Snowflake)
8. Edge での URL リダイレクトテスト (Workers なのでチラつきなしで作れる)

## 作らないもの (SKIP)

| 機能 | 理由 |
|---|---|
| ビジュアルエディタ | マーケ向け。DOM セレクタ・CSP・SPA の再描画で壊れやすく、GrowthBook でも不具合報告が最多クラス |
| Bandit | 効果推定が偏る、トラフィックが多くないと機能しない。「学ぶ」でなく「最適化する」道具で小チームの既定には不適 |
| Holdout | 長期間・大量トラフィックが前提。namespace の後で再検討 |
| 分位点指標 | 十分統計量が加算可能でなくなり、日次集計設計が崩れる。D1 に percentile 関数もない |
| Sticky bucketing | フェーズ強制で安全性は担保できる。ユーザーごとの保存領域が要る |
| プロダクト分析 (ファネル探索等) | スコープ外。BigQuery / Looker へ |

## GrowthBook の UX 不満から引き出した設計方針

- **実験が自分の flag ルールを所有する。** flag 画面と実験画面の二重編集をなくす (#2715, #1943, #2691)
- **SQL なしで始められる。** 組み込みイベントストアが既定。BigQuery は GA4 / Segment テンプレート付き (#1924)
- **フェーズのタイムライン表示と、新フェーズが必要な変更の事前警告** (#3953, #4918)
- **結論ファーストの結果画面。** 設定は開始時にロックし、感度分析は別ドロワー (#4654, #4265)
- **SRM パネルに実数と原因チェックリスト** (#1305)
- **環境ごとのペイロードサイズ表示** (#2385)
- **招待制が既定、MongoDB 不要、逐次検定・CUPED を無料で**
