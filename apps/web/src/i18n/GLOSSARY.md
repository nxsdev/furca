# Translation glossary (en → ja)

Use these terms everywhere so the Japanese UI reads as one product. Tone: labels, buttons and table
headers are short noun phrases (体言止め: 「保存」「フラグを作成」); sentences and help text use です・ます.
Keep code identifiers, keys, SDK names, SQL, `track()` etc. untranslated. Keep the product name `furca`
lowercase. Don't translate variation / flag / metric names the user typed.

| English | 日本語 | Notes |
|---|---|---|
| feature flag / flag | フィーチャーフラグ / フラグ | フラグ in UI; フィーチャーフラグ in explanations |
| experiment | 実験 | |
| variation | バリエーション | |
| control | コントロール | 「対照群」 only in explanations |
| treatment (generic) | テストバリエーション | prefer the variation's own name |
| metric | 指標 | |
| primary / secondary / guardrail metric | 主要指標 / 副指標 / ガードレール指標 | |
| environment | 環境 | |
| rule / force rule / rollout | ルール / 固定値ルール / 段階的ロールアウト | |
| targeting / condition / attribute | ターゲティング / 条件 / 属性 | |
| coverage | 対象割合 | |
| hash attribute | 振り分け属性 | |
| seed | シード | |
| default value / fallback | デフォルト値 / フォールバック値 | |
| exposure | 露出 | 「ユーザーが実験に割り当てられた記録」 |
| event | イベント | |
| conversion / conversion rate | コンバージョン / コンバージョン率 | |
| mean / ratio | 平均 / 比率 | |
| lift | リフト | 「改善率」 in explanations |
| confidence interval / credible interval | 信頼区間 / 確信区間 | |
| p-value | p値 | |
| chance to win | 勝つ確率 | |
| significant / not significant | 有意 / 有意差なし | |
| winning / losing / no difference / not enough data | 優勢 / 劣勢 / 差なし / データ不足 | |
| sequential testing | 逐次検定 | |
| CUPED / Holm correction | CUPED / Holm 補正 | |
| sample ratio mismatch (SRM) | サンプル比率の不一致（SRM） | |
| multiple exposures | 多重露出 | |
| phase / re-randomize | フェーズ / 再ランダム化 | |
| ship / roll back / inconclusive | 採用してリリース / ロールバック / 結論なし | decision outcomes |
| draft / running / stopped / archived | 下書き / 実行中 / 停止済み / アーカイブ済み | |
| data source / built-in event store | データソース / 組み込みイベントストア | |
| payload / SDK key | ペイロード / SDK キー | |
| audit log | 監査ログ | |
| member / owner / invitation | メンバー / オーナー / 招待 | |
| power / MDE / sample size | 検出力 / 最小検出効果（MDE） / サンプルサイズ | |
| capping / winsorization | キャッピング（外れ値の上限処理） | |
| conversion window / delay | 計測期間 / 計測開始の遅延 | |
| role / admin / editor / viewer | ロール / 管理者 / 編集者 / 閲覧者 | owner stays オーナー |
| review / change request | レビュー / 変更リクエスト | |
| approve / reject / require review | 承認 / 却下 / レビュー必須 | |
