# ラストワンマイル配送管理アプリ — 実装履歴

## Session 6 (2026-03-11)

### UX改善: モニター画面 + 計画画面

| # | 項目 | 概要 |
|---|------|------|
| UX-1 | **モニター: 渋滞レイヤー表示トグル** | H3交通ヘキサゴン (trafficLayer) の表示/非表示ボタン「渋滞」を追加 |
| UX-2 | **モニター: ドライバーリスト展開詳細** | DriverStatusList各行クリックで展開 — 速度、配達済/不在/残り件数、進捗バー、ドライバーID表示 |
| UX-3 | **モニター: 滞留時間パネル展開詳細** | DwellPanel各行クリックで展開 — 最大滞留、合計滞留分、配達件数、3分超率、場所別ミニバーチャート |
| UX-4 | **計画: ルート生成の根拠表示** | API側に`optimization_summary`追加 (H3コスト行列ペア数、リスクスコア反映数、工事ペナルティ数、時間帯別プール、配送先タイプ内訳)。UI「最適化の根拠」セクション |
| UX-5 | **計画: ドライバー行の強化** | シフト時間・帰着予定時刻・便別件数バッジを展開前に表示。ChevronDown開閉アイコン追加 |
| UX-6 | **計画: 便サマリーカード** | 各便の件数/重量/体積/高リスク数を4カラムで表示、配送先タイプ・再配達内訳 |
| UX-7 | **計画: 貨物一覧拡充** | 各荷物に recipient_type アイコン、リスクスコアカラーバッジ (赤/黄/緑) を追加 |

### 主な変更ファイル
- `src/app/monitor/page.tsx` — 渋滞トグル追加
- `src/components/monitor/driver-status-list.tsx` — 展開詳細追加
- `src/components/monitor/dwell-panel.tsx` — 展開詳細追加
- `src/app/api/plan/routes/generate/route.ts` — optimization_summary + recipient_type/risk_score をStopDetailに追加
- `src/components/plan/route-generate-panel.tsx` — 全面改修 (根拠表示、便サマリー、貨物拡充)

---

## Session 4 (2026-03-11)

### GPSシミュレーター → Delivery Simulator (全テーブル連動)

| # | 項目 | 概要 |
|---|------|------|
| GPS-5 | **渋滞フィードバック** | congestion_level≥1 のH3セルにいるドライバーの移動速度を自動減速 (Lv1: 85%, Lv2: 60%, Lv3: 40%, Lv4: 25%)。ダッシュボードに `▼60%` 表示、Slowed集計表示 |
| GPS-5a | **ルート形状改善** | stop間の直線移動を廃止。2ウェイポイント (垂直方向ジッター±0.0015°) を自動生成し、折れ線ルートで走行。リアル度UP |
| GPS-5b | **リプレイモード** | `--replay` で driver_locations_history から過去の走行をターミナルで再生。`--replay-minutes` (デフォルト60) と `--replay-speed` (デフォルト3x) で制御。フレーム単位プログレスバー付き |
| GPS-3 | **All-in-one Delivery Simulator** | `tools/gps_simulator.py` 全面統合 — 1コマンドで5テーブル同時更新 (driver_locations, history, delivery_status, traffic_realtime, delivery_dwell)。`--reset` で全テーブルリセット。個別無効化: `--no-status` / `--no-traffic` / `--no-dwell` |
| GPS-3a | **Phase 3: 渋滞シミュレーション** | ドライバー密集H3セルの `traffic_realtime` をUPSERT。同一H3に2台以上→congestion_level UP、ring-1隣接セルに伝搬、12tick後に自動解消。5tickごとに更新 |
| GPS-3b | **Phase 4: 滞在記録生成** | 配達完了時に `delivery_dwell` へINSERT。location_type (apartment 50%/office 30%/house 20%)、floor、elevator、dwell_seconds生成 |
| GPS-2 | **Phase 2: 配達ステータス連動** | 配達先到着時に `delivery_status` を自動更新 (pending→in_transit→delivered/absent)。不在確率 `--absence-rate` (デフォルト12%) |
| GPS-1 | **GPS Simulator v2** | ダッシュボード表示、高速デフォルト (10x速度)、初期位置オプション、ドライバー段階投入 (`--ramp`)、ANSI色付きUI |
| GPS-0 | **設計ドキュメント** | `gps_simulator_design.md` — 全テーブル連動の設計・使い方・確認用SQL |

### 主な変更ファイル
- `tools/gps_simulator.py` — **全面統合** All-in-one Delivery Simulator
- `gps_simulator_design.md` — **更新** 全テーブル連動版

---

## Session 3 (2026-03-11)

### Phase: ルート選定・準備・再調整機能

| # | 項目 | 概要 |
|---|------|------|
| R-1 | **ルート自動生成 API** | `POST /api/plan/routes/generate` — エリア分散 + 容量制約 (重量/体積) + リスクスコア最適化 + 最近傍法ルート順序。ft_risk_scores / ft_absence_patterns を JOIN してリスク考慮。工事エリア (road_construction) ペナルティ。時間指定・再配達を優先配列 |
| R-2 | **ドライバー手動割当 API** | `POST /api/plan/routes/assign` — 個別荷物のドライバー間移動。delivery_status の INSERT/UPDATE。配達済み・配送中は再割当不可ガード |
| R-3 | **ルート再調整 API** | `POST /api/monitor/routes/readjust` — ドライバー現在地から残配送先を最短距離で再配列。不在・高リスク (>0.7) を後回し。ft_risk_scores リアルタイム参照 |
| R-4 | **ルート生成パネル** | `route-generate-panel.tsx` — Plan画面にルート自動生成ボタン。ドライバー別の荷物数・重量・体積・容量%をプログレスバー付きで表示。展開して配達順序確認可能 |
| R-5 | **ドライバー割当ボード** | `route-assignment-board.tsx` — Plan画面に未割当荷物プール + ドライバー別キャパシティ表示。荷物選択 → ドライバー選択 → 割当実行のフロー |
| R-6 | **ルート再調整パネル** | `route-readjust-panel.tsx` — Monitor画面でドライバー選択時に表示。残ルート再最適化ボタンで再配列結果をプレビュー。不在件数・リスクスコア付き |

### 主な変更・新規ファイル
- `src/app/api/plan/routes/generate/route.ts` — **新規** ルート自動生成API
- `src/app/api/plan/routes/assign/route.ts` — **新規** 手動割当API
- `src/app/api/monitor/routes/readjust/route.ts` — **新規** ルート再調整API
- `src/components/plan/route-generate-panel.tsx` — **新規** ルート生成UIパネル
- `src/components/plan/route-assignment-board.tsx` — **新規** ドライバー割当ボード
- `src/components/monitor/route-readjust-panel.tsx` — **新規** ルート再調整パネル
- `src/app/plan/page.tsx` — RouteGeneratePanel、RouteAssignmentBoard統合
- `src/app/monitor/page.tsx` — RouteReadjustPanel統合

---

## Session 1 (2026-03-10 前半)

| # | 項目 | 概要 |
|---|------|------|
| A-1 | **振り返り画面の表示修正** | KPIカード最新日フォールバック、Postgres fallback、Snowflakeデータ追加 (3/9, 3/10分) |
| A-2 | **配送ルート可視化 (PathLayer)** | Monitor地図にドライバー別配送ルートを色分け表示、表示ON/OFFトグル |
| A-3 | **管理画面/DB** | Postgresテーブル一覧・行数表示・データブラウザ・スキーマ情報表示 |
| A-4 | **積み荷順番整理アプリ** | ドライバー選択→積込順(配達逆順)表示、再配達フラグ、時間指定、重量/体積サマリー |
| A-5 | **ML機能のわかりやすさ向上** | MlBadgeにツールチップ説明追加、Review画面にAI/ML活用状況セクション追加 |

### 主な変更ファイル
- `src/app/monitor/page.tsx` — ルート表示トグル追加
- `src/app/review/page.tsx` — KPI fallback修正、ML活用セクション
- `src/app/loading/page.tsx` — 新規作成
- `src/app/admin/page.tsx` — 新規作成
- `src/components/map/route-layer.tsx` — PathLayer新規作成
- `src/components/shared/ml-badge.tsx` — Tooltip付き拡張
- `src/app/api/monitor/routes/route.ts` — ルートAPI新規作成
- `src/app/api/loading/route.ts` — 積み荷API新規作成
- `src/app/api/admin/tables/route.ts` — テーブル一覧API
- `src/app/api/admin/query/route.ts` — テーブルクエリAPI

---

## Session 2 (2026-03-10 後半)

### Phase 0: pg_lake アーキテクチャ設計

| # | 項目 | 概要 |
|---|------|------|
| 0-design | **pg_lake訴求アーキテクチャ設計** | Iceberg + PostGIS 統合の全体設計をadd_request.mdに追記 (実装は保留、設計のみ) |

### Phase 8: UX 強化

| # | 項目 | 概要 |
|---|------|------|
| 8-1 | **日付ピッカー追加** | Plan/Review/Monitor/Loading全4ページにDatePicker導入、`today`固定を`date`ステートに変更 |
| 8-2 | **荷物・ドライバー検索/フィルタ** | PackageTableにテキスト検索 (住所・ID・担当) + ステータスフィルタBadge (全て/配達済/配送中/不在/割当済/未割当) |
| 8-3 | **ドライバー個別詳細ドリルダウン** | DriverRankingテーブル行クリック → Dialogで配達完了/不在/合計、完了率バー、チーム平均比較、距離、エリア表示 |
| 8-4 | **不在ヒートマップの時間帯フィルタ** | AbsenceHeatmapに曜日フィルタ (日〜土 + 全て) と時間帯フィルタ (全時間/10時/11時/14時/15時/17時) のBadge追加 |
| 8-5 | **KPI CSVエクスポート** | Review画面ヘッダーにDownloadボタン追加、KPIトレンドデータをCSVダウンロード |

### Phase 9: 地図・可視化の高度化

| # | 項目 | 概要 |
|---|------|------|
| 9-3 | **工事エリアのH3ポリゴン表示** | construction-layer.tsx新規作成 (黄色H3HexagonLayer、extruded)、Plan地図に統合 |

### Phase 11: データ・ML 拡張

| # | 項目 | 概要 |
|---|------|------|
| 11-3 | **週次比較ビュー** | KpiChartに前週比 (vs前週) デルタ表示 — 完了率・不在率のTrendUp/TrendDown/Minusアイコン、ReferenceLineで今週平均 |

### Phase 12: 運用・品質

| # | 項目 | 概要 |
|---|------|------|
| 12-1 | **APIパラメータバリデーション強化** | `snowflake.ts` のquery()にbindsパラメータ追加、KPI APIの文字列補間 (`'${d}'`) をバインドパラメータ (`?`) に修正、range入力値クランプ (1-365) |
| 12-2 | **エラーハンドリング改善** | `fetcher.ts` にFetchErrorクラス追加、safeFetchにHTTPエラー/APIエラーのconsole.errorログ追加、safeFetchObj<T>ヘルパー追加 |

### Admin画面強化

| # | 項目 | 概要 |
|---|------|------|
| Admin | **Snowflakeテーブル一覧追加** | Admin画面にPostgres/Snowflakeタブ切替追加、`/api/admin/snowflake-tables` (ANALYTICS/MLスキーマ一覧) と `/api/admin/snowflake-query` (bind付きクエリ) API新規作成 |

### 主な変更・新規ファイル
- `src/components/shared/date-picker.tsx` — **新規** DatePickerコンポーネント
- `src/components/map/construction-layer.tsx` — **新規** 工事エリアH3レイヤー
- `src/components/ui/dialog.tsx` — **新規** shadcn Dialog
- `src/app/api/admin/snowflake-tables/route.ts` — **新規** Snowflakeテーブル一覧API
- `src/app/api/admin/snowflake-query/route.ts` — **新規** SnowflakeクエリAPI
- `src/app/plan/page.tsx` — DatePicker、工事H3レイヤー追加、MlBadge名変更
- `src/app/review/page.tsx` — DatePicker、CSVエクスポートボタン追加
- `src/app/monitor/page.tsx` — DatePicker追加
- `src/app/loading/page.tsx` — DatePicker追加
- `src/app/admin/page.tsx` — Postgres/Snowflakeタブ切替に拡張
- `src/components/plan/package-table.tsx` — 検索・ステータスフィルタ追加
- `src/components/review/driver-ranking.tsx` — クリック詳細Dialog追加
- `src/components/review/absence-heatmap.tsx` — 曜日・時間帯フィルタ追加
- `src/components/review/kpi-chart.tsx` — 週次比較デルタ表示追加
- `src/lib/snowflake.ts` — bindsパラメータサポート追加
- `src/lib/fetcher.ts` — FetchError、エラーログ、safeFetchObj追加
- `src/app/api/review/kpi/route.ts` — パラメタライズドクエリに修正
