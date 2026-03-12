# ラストマイル配送デポマネージャー — 残タスク・既知の問題

## 実装状況

### API Route — データソースマッピング

| Route | データソース | 方式 | 状態 |
|-------|-------------|------|:----:|
| `/api/plan/risk-map` | ft_risk_scores | pg_lake Foreign Table | ✅ |
| `/api/plan/weather` | V_WEATHER_FORECAST_LIVE | Snowflake 直接 (Cortex LLM) | ✅ |
| `/api/plan/packages` | packages, drivers | Postgres ネイティブ | ✅ |
| `/api/plan/drivers` | drivers | Postgres ネイティブ | ✅ |
| `/api/plan/routes` | routes | Postgres ネイティブ | ✅ |
| `/api/monitor/progress` | delivery_status | Postgres ネイティブ | ✅ |
| `/api/monitor/driver-locations` | driver_locations | Postgres ネイティブ | ✅ |
| `/api/monitor/traffic` | traffic_realtime | Postgres ネイティブ | ✅ |
| `/api/monitor/construction` | road_construction | Postgres ネイティブ | ✅ |
| `/api/review/kpi` | ft_kpi_daily + delivery_status fallback | pg_lake Foreign Table | ✅ |
| `/api/review/absence-heatmap` | ft_absence_patterns | pg_lake Foreign Table | ✅ |
| `/api/review/demand-forecast` | ft_demand_forecast | pg_lake Foreign Table | ✅ |
| `/api/admin/snowflake-query` | 任意 | Snowflake 直接 | ✅ |
| `/api/admin/snowflake-tables` | INFORMATION_SCHEMA | Snowflake 直接 | ✅ |

---

## 解決済みの問題

### 1. ~~地図コントロールボタンが事故シミュレーションダイアログを誤起動する~~ ✅

`suppressClickRef` パターンで DeckGL の `onClick` がボタン操作時に発火しないよう制御。

### 2. ~~Snowflake EXTERNALBROWSER 認証による API 500 エラー~~ ✅

PAT (Programmatic Access Token) 認証に切り替え。SPCS Secret 経由で注入。

### 3. ~~Docker / SPCS デプロイ~~ ✅

URL: `https://nxa4qd3u-sfseapac-fsi-japan.snowflakecomputing.app`

### 4. ~~sf_* COPY 方式から ft_* Foreign Table 方式への移行~~ ✅

4つの ML 出力テーブルを pg_lake Foreign Table に移行。COPY / 同期が不要に。

### 5. ~~Iceberg v3 統一アーキテクチャ移行~~ ✅

全6テーブル (RISK_SCORES, KPI_DAILY, ABSENCE_PATTERNS, DEMAND_FORECAST, DELIVERY_HISTORY, BUILDING_ATTRIBUTES) を Managed Iceberg v3 に統一。ICE_* 重複テーブル、SP_SYNC_ICE_TABLES、TASK_SYNC_ICEBERG を削除。ft_* Foreign Table のS3パスも更新済み。

### 6. ~~H3 R11 移行~~ ✅

R8/R9 → R11 (4,413セル) に移行。ML モデル再学習済み (ABSENCE_MODEL v2: AUC 0.71→0.90)。WH を Medium → Large に変更。

### 7. ~~ABSENCE_PREDICTOR target_platform~~ ✅

SPCS target_platform で登録済み。Task Chain (SP_PREDICT_ABSENCE) から推論実行しており、WAREHOUSE 再登録は不要。

---

## 残タスク

### 高優先

| タスク | 備考 |
|--------|------|
| SPCS デプロイ (Session 6 変更反映) | UX改善 (渋滞トグル、展開詳細、ルート生成根拠表示等) の本番反映 |

### 低優先

| タスク | 備考 |
|--------|------|
| Streamlit ダッシュボード構築 | Snowflake 本体直結の分析 UI |
| pgrouting 道路ネットワーク構築 | pgaudit bug により PostGIS が不安定 |
| GPS シミュレータ | リアルタイムデモ用 |

---

## デプロイ手順

→ **[docs/deployment.md](deployment.md)** を参照。

---

## 技術スタック

- Next.js 16.1.6 (App Router, Turbopack) + React 19.2.3
- deck.gl 9.2.11 + luma.gl 9.2.6 + Mapbox GL JS 3.19.1 + react-map-gl 8.1.0
- shadcn/ui v4 (@base-ui/react ベース)
- Snowflake: LASTMILE_DB (SFSEAPAC-FSI_JAPAN)
- Postgres: pg_lake 3.2, h3, h3_postgis, postgis
- patch-package: luma.gl maxTextureDimension2D バグ修正を永続化
