# Lastmile Delivery — DB設計書

## 概要

ハイブリッド構成: **Snowflake Postgres** (OLTP/リアルタイム) + **Snowflake本体** (分析/ML)。  
Snowflake本体で計算した結果は Iceberg v3 テーブル → S3 Parquet → pg_lake Foreign Table (`ft_*`) 経由で Postgres から即参照可能 (Zero-ETL)。

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  Snowflake Postgres (OLTP)  │     │  Snowflake 本体 (分析/ML)   │
│                             │     │                             │
│  depots                     │     │  ANALYTICS スキーマ          │
│  drivers                    │ ETL │    DELIVERY_HISTORY         │
│  packages ──────────────────┼────→│    RISK_SCORES              │
│  delivery_status            │     │    ABSENCE_PATTERNS         │
│  driver_locations           │     │    KPI_DAILY                │
│  driver_locations_history   │     │    DEMAND_FORECAST          │
│  routes                     │     │    H3_COST_MATRIX           │
│  traffic_realtime           │     │    BUILDING_ATTRIBUTES      │
│  road_construction          │     │    WEATHER_FORECAST         │
│  delivery_dwell             │     │    ANOMALY_ALERTS           │
│  driver_attendance          │     │                             │
│  delivery_alerts            │     │                             │
│                             │     │                             │
│  ft_risk_scores        ←────┼─ Iceberg v3 / S3 Parquet ────────┤
│  ft_kpi_daily          ←────┤     │  ML スキーマ                │
│  ft_absence_patterns   ←────┤     │    ABSENCE_MODEL_METADATA   │
│  ft_demand_forecast    ←────┤     │    RISK_WEIGHTS             │
│  ft_delivery_history   ←────┤     │                             │
│  ft_building_attributes←────┤     │  RAW スキーマ               │
│                             │     │    GPS_RAW                  │
│                             │     │    STATUS_RAW               │
└─────────────────────────────┘     └─────────────────────────────┘
```

---

## 1. Snowflake Postgres (OLTP)

### 拡張

| Extension | Version | 用途 |
|-----------|---------|------|
| h3 | 4.2.3 | H3 六角形グリッド (R8-R11) |
| pg_cron | — | 定期ジョブ |
| pg_lake | 3.2 | Iceberg Foreign Table 基盤 |
| pg_lake_engine | 3.2 | Parquet クエリエンジン |
| pg_lake_iceberg | 3.2 | Iceberg v3 メタデータ読み取り |
| pg_lake_table | 3.2 | Foreign Table 管理 |
| pg_lake_copy | 3.2 | COPY TO/FROM |

> PostGIS / h3_postgis / pgrouting は設計上想定されているが、pgaudit バグ回避のため未使用。

---

### 1.1 depots — 配送拠点

| Column | Type | Nullable | Key | 説明 |
|--------|------|----------|-----|------|
| depot_id | VARCHAR(20) | NO | PK | 拠点ID (`DEPOT-TOYOSU`) |
| name | VARCHAR(100) | NO | | 拠点名 |
| address | TEXT | YES | | 住所 |
| lat | DOUBLE PRECISION | NO | | 緯度 |
| lng | DOUBLE PRECISION | NO | | 経度 |

レコード数: 1 (デモは豊洲1拠点)

---

### 1.2 drivers — ドライバーマスタ

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| driver_id | VARCHAR(20) | NO | PK | | ドライバーID (`DRV-001`〜`DRV-012`) |
| depot_id | VARCHAR(20) | NO | FK → depots | | 所属拠点 |
| name | VARCHAR(50) | NO | | | ドライバー名 |
| vehicle_type | VARCHAR(20) | YES | | `'van'` | 車両種別 |
| vehicle_capacity | NUMERIC(8,2) | YES | | `350.0` | 最大積載量 (kg) |
| vehicle_volume | NUMERIC(8,2) | YES | | `8.0` | 最大容積 (m³) |
| skill_level | INT | YES | | `3` | スキル (1-5) |
| area_assignment | VARCHAR(10) | YES | | | 担当エリアコード |
| is_active | BOOLEAN | YES | | `true` | 稼働フラグ |
| created_at | TIMESTAMPTZ | YES | | `NOW()` | |

レコード数: 12

---

### 1.3 packages — 荷物マスタ (日次ロード)

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| package_id | VARCHAR(30) | NO | PK | | 荷物ID (`PKG-0312-0001`) |
| depot_id | VARCHAR(20) | NO | FK → depots | | 拠点 |
| date | DATE | NO | IDX | | 配送日 |
| address | TEXT | NO | | | 配送先住所 |
| lat | DOUBLE PRECISION | NO | | | 緯度 |
| lng | DOUBLE PRECISION | NO | | | 経度 |
| h3_index | H3INDEX | YES | IDX | | H3 R11 セル |
| time_window | VARCHAR(20) | YES | | | 時間指定 (`09:00-12:00` 等) |
| weight | NUMERIC(8,2) | YES | | `2.0` | 重量 (kg) |
| volume | NUMERIC(8,3) | YES | | `0.02` | 体積 (m³) |
| is_redelivery | BOOLEAN | YES | | `false` | 再配達フラグ |
| recipient_type | VARCHAR(20) | YES | | `'residential'` | 受取人タイプ |
| route_id | VARCHAR(30) | YES | IDX | | ルートID |
| stop_order | INT | YES | | | ルート内の配達順序 |
| loading_order | INT | YES | | | 積み込み順序 |
| created_at | TIMESTAMPTZ | YES | | `NOW()` | |

レコード数: ~490/日

---

### 1.4 delivery_status — 配達状況リアルタイム

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| package_id | VARCHAR(30) | NO | PK (複合) | | FK → packages |
| date | DATE | NO | PK (複合), IDX | | 配送日 |
| driver_id | VARCHAR(20) | YES | FK → drivers, IDX | | 担当ドライバー |
| status | VARCHAR(20) | YES | IDX | `'pending'` | ステータス (下記参照) |
| completed_at | TIMESTAMPTZ | YES | | | 完了/不在判定時刻 |
| is_absent | BOOLEAN | YES | | `false` | 不在フラグ |
| attempt_count | INT | YES | | `0` | 配達試行回数 |
| notes | TEXT | YES | | | メモ |
| updated_at | TIMESTAMPTZ | YES | | `NOW()` | |
| trip_number | INT | YES | | `1` | トリップ番号 |
| stop_order | INT | YES | | | ルート内順序 |

**ステータス遷移:**
```
pending → assigned → loaded → in_transit → delivered
                                         → absent
                                         → failed
         (未配達分は daily-close で → returned)
```

PK: `(package_id, date)` — 同一荷物の再配達 (日跨ぎ) に対応。

---

### 1.5 driver_locations — ドライバー現在位置 (GPS UPSERT)

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| driver_id | VARCHAR(20) | NO | PK | | FK → drivers |
| lat | DOUBLE PRECISION | NO | | | 現在緯度 |
| lng | DOUBLE PRECISION | NO | | | 現在経度 |
| h3_index | H3INDEX | YES | IDX | | H3 R9 セル |
| speed | DOUBLE PRECISION | YES | | `0` | 速度 (km/h) |
| heading | DOUBLE PRECISION | YES | | `0` | 方位 (度) |
| timestamp | TIMESTAMPTZ | YES | | `NOW()` | 最終更新 |

**トリガー:** `trg_log_driver_location` — INSERT/UPDATE 時に自動で `driver_locations_history` へ INSERT。

> **H3 注意:** `h3_latlng_to_cell(POINT(lat, lng), 9)` — lat が先。

---

### 1.6 driver_locations_history — ドライバー軌跡

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| id | SERIAL | NO | PK | auto | |
| driver_id | VARCHAR(20) | NO | FK → drivers, IDX | | |
| lat | DOUBLE PRECISION | NO | | | |
| lng | DOUBLE PRECISION | NO | | | |
| h3_index | H3INDEX | YES | IDX | | H3 R9 セル |
| speed | DOUBLE PRECISION | YES | | `0` | |
| heading | DOUBLE PRECISION | YES | | `0` | |
| recorded_at | TIMESTAMPTZ | YES | | `NOW()` | 記録時刻 |

インデックス: `(driver_id, recorded_at DESC)` — 直近の軌跡クエリ最適化。

---

### 1.7 routes — ルート

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| route_id | VARCHAR(30) | NO | PK | | `R-DRV-001-2026-03-12-T1` |
| driver_id | VARCHAR(20) | NO | FK → drivers, IDX | | |
| depot_id | VARCHAR(20) | NO | FK → depots | | |
| date | DATE | NO | IDX | | |
| total_distance | DOUBLE PRECISION | YES | | | 総距離 (km) |
| total_time_est | INT | YES | | | 推定所要時間 (分) |
| stop_count | INT | YES | | | 配達先数 |
| status | VARCHAR(20) | YES | | `'planned'` | planned / loaded / in_progress / completed / cancelled |
| created_at | TIMESTAMPTZ | YES | | `NOW()` | |

**route_id 命名規約:** `R-{driver_id}-{date}-T{trip_number}` (例: `R-DRV-001-2026-03-12-T1`)

**ステータス遷移:**
```
planned → loaded → in_progress → completed
                                → cancelled (ドライバー離脱時)
```

**書込み元 API:**
| 操作 | API | 説明 |
|------|-----|------|
| INSERT | routes/generate (confirm=true) | ルート確定時に全ルート作成 |
| INSERT | routes/assign | 手動割当時にルートレコード作成 (ON CONFLICT DO NOTHING) |
| INSERT | next-trip (confirm=true) | 次便生成時に新トリップのルート作成 |
| UPDATE status→loaded | load-confirm | 積み込み確認 |
| UPDATE distance/count | readjust (confirm=true) | ルート再調整確定時 |
| UPDATE status→cancelled | driver-withdraw (confirm=true) | ドライバー離脱時 |
| UPDATE status→completed | daily-close | 日次締め時に全ルート完了 |

---

### 1.8 traffic_realtime — リアルタイム渋滞

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| h3_index | H3INDEX | NO | PK (複合) | | H3 R9 セル |
| datetime | TIMESTAMPTZ | NO | PK (複合) | | 時間帯 (1時間粒度) |
| congestion_level | INT | YES | | | 0-4 (0=なし, 4=大渋滞) |
| speed_ratio | DOUBLE PRECISION | YES | | | 渋滞時速度比率 (1.0=正常) |

シミュレータが 5tick ごとにドライバー密度から動的に生成。

---

### 1.9 road_construction — 道路工事・規制

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| construction_id | SERIAL | NO | PK | auto | |
| h3_index | H3INDEX | YES | IDX | | 工事エリアのH3セル |
| center_lat | DOUBLE PRECISION | YES | | | 中心緯度 |
| center_lng | DOUBLE PRECISION | YES | | | 中心経度 |
| radius_m | DOUBLE PRECISION | YES | | `100` | 影響半径 (m) |
| start_date | DATE | NO | IDX | | 工事開始日 |
| end_date | DATE | YES | IDX | | 工事終了日 |
| restriction_type | VARCHAR(30) | YES | | | 規制種別 |
| description | TEXT | YES | | | 説明 |
| created_at | TIMESTAMPTZ | YES | | `NOW()` | |

---

### 1.10 delivery_dwell — 滞在記録

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| id | SERIAL | NO | PK | auto | |
| package_id | VARCHAR(30) | NO | | | 荷物ID |
| driver_id | VARCHAR(20) | NO | | | ドライバーID |
| date | DATE | NO | | | 配送日 |
| arrived_at | TIMESTAMPTZ | YES | | | 到着時刻 |
| departed_at | TIMESTAMPTZ | YES | | | 出発時刻 |
| dwell_seconds | INT | YES | | | 滞在秒数 |
| location_type | VARCHAR(20) | YES | | | apartment / office / house |
| lat | DOUBLE PRECISION | YES | | | |
| lng | DOUBLE PRECISION | YES | | | |
| floor_number | INT | YES | | | 階数 |
| has_elevator | BOOLEAN | YES | | | エレベーター有無 |
| notes | TEXT | YES | | | |

GPS シミュレータが配達完了/不在判定時に INSERT。

---

### 1.11 driver_attendance — ドライバー出退勤

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| id | SERIAL | NO | PK | auto | |
| driver_id | VARCHAR(20) | NO | FK → drivers, UQ | | ドライバーID |
| date | DATE | NO | UQ, IDX | | 対象日 |
| status | VARCHAR(20) | YES | | `'present'` | present / absent / late / withdrawn |
| check_in_time | TIMESTAMPTZ | YES | | | 出勤時刻 |
| check_out_time | TIMESTAMPTZ | YES | | | 退勤時刻 |
| reason | TEXT | YES | | | 欠勤・離脱理由 |
| created_at | TIMESTAMPTZ | YES | | `NOW()` | |

UNIQUE 制約: `(driver_id, date)` — 1ドライバー1日1レコード。

**書込み元 API:**
| 操作 | API | 説明 |
|------|-----|------|
| UPSERT | driver-attendance POST | 出勤/欠勤登録 (check_in_time 設定) |
| UPSERT (withdrawn) | driver-withdraw (confirm=true) | 離脱記録 (check_out_time + reason) |
| UPSERT (check_out) | daily-close | 日次締めで退勤時刻を記録 |

---

### 1.12 delivery_alerts — 配達アラート

| Column | Type | Nullable | Key | Default | 説明 |
|--------|------|----------|-----|---------|------|
| id | SERIAL | NO | PK | auto | |
| alert_id | VARCHAR(50) | NO | UQ | | アラートID (`ALT-2026-03-12-1`) |
| driver_id | VARCHAR(20) | YES | FK → drivers, IDX | | |
| date | DATE | NO | IDX | | |
| hour | INT | YES | | | 発生時間帯 |
| anomaly_score | DOUBLE PRECISION | YES | | | 異常スコア (0.0-1.0) |
| severity | VARCHAR(20) | YES | | | critical / warning / info |
| alert_type | VARCHAR(50) | YES | | | 配達遅延 / ペース低下 / 不在多発 / 停車検知 / 配達失敗 / 帰庫待ち / 高パフォーマンス / 所要時間超過 |
| description | TEXT | YES | | | アラート説明文 |
| recommended_action | TEXT | YES | | | 推奨アクション |
| acknowledged | BOOLEAN | YES | | `false` | 確認済みフラグ |
| created_at | TIMESTAMPTZ | YES | | `NOW()` | |

**書込み元 API:** `GET /api/monitor/alerts` — ドライバー統計から分類したアラートを UPSERT (alert_id で重複制御)。

---

### 1.13 Foreign Tables (ft_*) — pg_lake 経由 Snowflake 読み取り

Snowflake Iceberg v3 テーブルの S3 Parquet を直接参照。**同期不要** — Snowflake 側で SP が書き込むと即反映。

| Foreign Table | 元テーブル (Snowflake) | 行数 | 用途 |
|---------------|----------------------|------|------|
| ft_risk_scores | ANALYTICS.RISK_SCORES | ~185K | リスクマップ表示、ルート最適化 |
| ft_kpi_daily | ANALYTICS.KPI_DAILY | ~34 | KPI ダッシュボード |
| ft_absence_patterns | ANALYTICS.ABSENCE_PATTERNS | ~15K | 不在予測パターン |
| ft_demand_forecast | ANALYTICS.DEMAND_FORECAST | ~7 | 需要予測 |
| ft_delivery_history | ANALYTICS.DELIVERY_HISTORY | ~16K | 配送実績 |
| ft_building_attributes | ANALYTICS.BUILDING_ATTRIBUTES | ~11K | 建物属性 |

---

## 2. Snowflake 本体

### 2.1 ANALYTICS スキーマ

#### DELIVERY_HISTORY — 配送実績 (30日分)

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| DELIVERY_ID | STRING | YES | |
| PACKAGE_ID | STRING | YES | |
| DRIVER_ID | STRING | YES | |
| DEPOT_ID | STRING | YES | |
| DATE | DATE | YES | CLUSTER KEY |
| STATUS | STRING | YES | delivered / absent / failed |
| COMPLETED_AT | TIMESTAMP_NTZ | YES | |
| IS_ABSENT | BOOLEAN | YES | |
| ATTEMPT_COUNT | NUMBER | YES | |
| DELIVERY_LOCATION | GEOGRAPHY | YES | |
| H3_INDEX_R9 | STRING | YES | |
| DELIVERY_TIME_SEC | NUMBER | YES | 配達所要秒数 |
| METADATA | VARIANT | YES | |
| LOADED_AT | TIMESTAMP_NTZ | YES | |

Flat版 (`DELIVERY_HISTORY_FLAT`): GEOGRAPHY/VARIANT カラムを除外した pg_lake Foreign Table 用。

---

#### RISK_SCORES — リスクスコア (H3 R11 × 日付 × 時間帯)

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| H3_INDEX | STRING | YES | H3 R11 セル (~4,413 cells) |
| DATE | DATE | YES | CLUSTER KEY |
| HOUR | NUMBER | YES | 8-20 |
| RISK_SCORE | FLOAT | YES | 0.0-1.0 (総合リスク) |
| WEATHER_RISK | FLOAT | YES | 天気リスク要因 |
| ABSENCE_RISK | FLOAT | YES | 不在リスク要因 |
| BUILDING_RISK | FLOAT | YES | 建物リスク要因 |
| POI_RISK | FLOAT | YES | POI リスク要因 |
| RISK_FACTORS | VARIANT | YES | 詳細リスクファクター (JSON) |
| CREATED_AT | TIMESTAMP_NTZ | YES | |

`SP_RECALC_RISK_SCORES()` が毎日計算。4因子加重平均: `RISK_WEIGHTS` テーブルの重み使用。

Flat版 (`RISK_SCORES_FLAT`): VARIANT を除外。

---

#### ABSENCE_PATTERNS — 不在パターン (曜日 × 時間帯 × H3)

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| H3_INDEX | STRING | YES | H3 セル |
| DAY_OF_WEEK | NUMBER | YES | 0 (日) - 6 (土) |
| HOUR | NUMBER | YES | 時間帯 |
| ABSENCE_RATE | FLOAT | YES | 不在率 (0.0-1.0) |
| SAMPLE_COUNT | NUMBER | YES | サンプル数 |
| UPDATED_AT | TIMESTAMP_NTZ | YES | |

`SP_PREDICT_ABSENCE()` (XGBoost v2) が毎日更新。

---

#### H3_COST_MATRIX — セル間移動コスト (H3 R10)

| Column | Type | Nullable | Default | 説明 |
|--------|------|----------|---------|------|
| DATE | DATE | NO | | |
| HOUR | NUMBER | NO | | |
| FROM_H3 | STRING | NO | | 出発セル (R10) |
| TO_H3 | STRING | NO | | 到着セル (R10) |
| DISTANCE_KM | FLOAT | NO | | 直線距離 |
| RISK_COST | FLOAT | YES | `0` | リスクベースのペナルティ |
| TRAFFIC_COST | FLOAT | YES | `0` | 渋滞ペナルティ |
| TOTAL_COST | FLOAT | NO | | 合計コスト |
| CREATED_AT | TIMESTAMP_NTZ | YES | `NOW()` | |

ルート生成アルゴリズム (Greedy Nearest Neighbor) で使用。

---

#### KPI_DAILY — 日次KPI

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| DEPOT_ID | STRING | YES | |
| DATE | DATE | YES | |
| TOTAL_PACKAGES | NUMBER | YES | 総荷物数 |
| DELIVERED | NUMBER | YES | 配達済み |
| ABSENT | NUMBER | YES | 不在数 |
| COMPLETION_RATE | FLOAT | YES | 完了率 |
| ABSENCE_RATE | FLOAT | YES | 不在率 |
| ONTIME_RATE | FLOAT | YES | 定時配達率 |
| AVG_DELIVERY_TIME | FLOAT | YES | 平均配達時間 (分) |
| CREATED_AT | TIMESTAMP_NTZ | YES | |

---

#### DEMAND_FORECAST — 需要予測 (翌週分)

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| DEPOT_ID | STRING | YES | |
| DATE | DATE | YES | |
| FORECAST_VOLUME | FLOAT | YES | 予測荷物数 |
| CONFIDENCE_LOWER | FLOAT | YES | 下限 |
| CONFIDENCE_UPPER | FLOAT | YES | 上限 |
| CREATED_AT | TIMESTAMP_NTZ | YES | |

LightGBM Quantile ×3 で生成。

---

#### BUILDING_ATTRIBUTES — 建物属性

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| H3_INDEX | STRING | YES | H3 セル |
| BUILDING_TYPE | STRING | YES | apartment / house / office / commercial |
| HAS_ELEVATOR | BOOLEAN | YES | |
| HAS_DELIVERY_BOX | BOOLEAN | YES | |
| AVG_FLOORS | NUMBER | YES | 平均階数 |
| CENTROID | GEOGRAPHY | YES | |
| BUILDING_DETAILS | VARIANT | YES | |
| UPDATED_AT | TIMESTAMP_NTZ | YES | |

Flat版 (`BUILDING_ATTRIBUTES_FLAT`): GEOGRAPHY/VARIANT を除外。

---

#### WEATHER_FORECAST — 天気予報

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| H3_INDEX | STRING | YES | H3 R7 セル |
| DATETIME | TIMESTAMP_NTZ | YES | |
| PRECIPITATION | FLOAT | YES | 降水量 (mm) |
| WIND_SPEED | FLOAT | YES | 風速 (m/s) |
| TEMPERATURE | FLOAT | YES | 気温 (°C) |
| WEATHER_CODE | STRING | YES | clear / cloudy / rain |

---

#### ANOMALY_ALERTS — 異常検知アラート

| Column | Type | Nullable | 説明 |
|--------|------|----------|------|
| ALERT_ID | STRING | YES | |
| DRIVER_ID | STRING | YES | |
| DATE | DATE | YES | |
| HOUR | NUMBER | YES | |
| ANOMALY_SCORE | FLOAT | YES | 0.0-1.0 |
| EXPECTED_PACE | FLOAT | YES | 期待配達ペース (件/h) |
| ACTUAL_PACE | FLOAT | YES | 実際のペース |
| CREATED_AT | TIMESTAMP_NTZ | YES | |

Cortex ML Anomaly Detection で生成。

---

#### Views

| View | 説明 |
|------|------|
| V_POI_AREA_PROFILE | POI 集約 (H3 R8): food/retail/office/hotel/logistics/parking カウント + area_type |
| V_WEATHER_FORECAST_LIVE | リアルタイム天気 (Snowflake Marketplace 連携) |
| V_WEATHER_HISTORY | 過去天気データ |

---

### 2.2 ML スキーマ

| テーブル/ビュー | Type | 説明 |
|----------------|------|------|
| ABSENCE_MODEL_METADATA | TABLE | XGBoost v2 モデルのメタ (AUC, 特徴量重要度, カテゴリマッピング) |
| RISK_WEIGHTS | TABLE | リスク4因子の重み (LogisticRegression 学習結果) |
| V_DEMAND_FORECAST_TRAIN | VIEW | 需要予測モデルの学習用データ |
| V_KPI_ANOMALY_TRAIN | VIEW | 異常検知モデルの学習用データ |
| V_KPI_ANOMALY_TEST | VIEW | 異常検知モデルのテスト用データ |
| V_KPI_FORECAST_TRAIN | VIEW | KPI予測モデルの学習用データ |

---

### 2.3 RAW スキーマ

| テーブル | 説明 |
|---------|------|
| GPS_RAW | Snowpipe Streaming GPS 受信先 (driver_id, lat, lng, speed, heading, timestamp) |
| STATUS_RAW | Snowpipe Streaming ステータス受信先 (package_id, driver_id, status, timestamp, lat, lng) |

---

## 3. H3 解像度設計

| Resolution | セルサイズ | 用途 | テーブル |
|-----------|----------|------|---------|
| R7 | ~5.16 km² | 天気予報 | WEATHER_FORECAST |
| R8 | ~0.74 km² | POI プロファイル | V_POI_AREA_PROFILE, ABSENCE_PATTERNS (旧) |
| R9 | ~0.11 km² | リアルタイム位置 | traffic_realtime, driver_locations, road_construction |
| R10 | ~0.015 km² | ルーティング | H3_COST_MATRIX |
| R11 | ~0.002 km² | リスク/不在分析 | RISK_SCORES, ABSENCE_PATTERNS, BUILDING_ATTRIBUTES, packages |

---

## 4. タスクチェーン (自動パイプライン)

毎日 23:00 JST に起動:

```
TASK_DAILY_ETL (CRON 0 23 * * * Asia/Tokyo)
│   └─ SP_ETL_POSTGRES_SYNC()
│       Postgres delivery_status → Snowflake DELIVERY_HISTORY + KPI_DAILY
│
├── TASK_RISK_SCORES (predecessor: TASK_DAILY_ETL)
│   └─ SP_RECALC_RISK_SCORES()
│       4因子加重平均でリスクスコア再計算
│       │
│       └── TASK_DEMAND_FORECAST (predecessor: TASK_RISK_SCORES)
│           └─ SP_REFRESH_DEMAND_FORECAST()
│               LightGBM Quantile ×3 で翌週の需要予測
│
└── TASK_ABSENCE_PATTERNS (predecessor: TASK_DAILY_ETL)
    └─ SP_PREDICT_ABSENCE()
        XGBoost v2 で不在パターン更新
```

Iceberg v3 テーブル更新 → S3 Parquet 自動書き出し → `ft_*` Foreign Table 即反映。

---

## 5. Stored Procedures 一覧

### ANALYTICS スキーマ (主要)

| SP | 説明 |
|----|------|
| SP_ETL_POSTGRES_SYNC | Postgres → Snowflake ETL (delivery_status → DELIVERY_HISTORY + KPI_DAILY) |
| SP_RECALC_RISK_SCORES | リスクスコア再計算 (4因子加重平均) |
| SP_RECALC_ABSENCE_PATTERNS | 不在パターン再集計 |
| SP_REFRESH_DEMAND_FORECAST | 需要予測更新 |
| SP_GENERATE_H3_COST_MATRIX(date, hour) | H3 R10 セル間コスト行列生成 |
| SP_SETUP_FOREIGN_TABLES | pg_lake Foreign Table 作成/再作成 |
| SP_REGENERATE_DEMO_DATA | デモデータ全再生成 |

### ML スキーマ (主要)

| SP | 説明 |
|----|------|
| SP_TRAIN_ABSENCE_MODEL | XGBoost 不在モデル学習 |
| SP_TRAIN_RISK_MODEL | リスク重み (LogisticRegression) 学習 |
| SP_TRAIN_DEMAND_MODEL | 需要予測モデル学習 |
| SP_PREDICT_ABSENCE | 不在予測実行 (学習済みモデル使用) |
| SP_DETECT_ANOMALIES | Cortex ML 異常検知 |

---

## 6. ER図 (Postgres)

```
depots ─────────────────┐
  │ PK: depot_id        │
  │                     │
  ├─< drivers           │
  │     PK: driver_id   │
  │     FK: depot_id    │
  │     │               │
  │     ├─< packages    │
  │     │     PK: package_id
  │     │     FK: depot_id
  │     │     FK: route_id → routes
  │     │     │
  │     │     └─< delivery_status
  │     │           PK: (package_id, date)
  │     │           FK: driver_id
  │     │
  │     ├── driver_locations
  │     │     PK: driver_id (1:1)
  │     │     │
  │     │     └─< driver_locations_history
  │     │           PK: id
  │     │           FK: driver_id
  │     │           (トリガーで自動INSERT)
  │     │
  │     ├─< driver_attendance
  │     │     PK: id
  │     │     UQ: (driver_id, date)
  │     │     FK: driver_id
  │     │
  │     ├─< delivery_alerts
  │     │     PK: id
  │     │     UQ: alert_id
  │     │     FK: driver_id
  │     │
  │     └─< delivery_dwell
  │           FK: driver_id
  │
  └─< routes
        PK: route_id  (R-{driver_id}-{date}-T{trip})
        FK: driver_id, depot_id

traffic_realtime
  PK: (h3_index, datetime)

road_construction
  PK: construction_id
```

---

## 7. データフロー概要

```
[GPS Simulator]
     │
     ├── UPSERT → driver_locations ──trigger──→ driver_locations_history
     ├── UPDATE → delivery_status (pending → in_transit → delivered/absent)
     ├── UPSERT → traffic_realtime (5tick毎にドライバー密度から計算)
     └── INSERT → delivery_dwell (配達完了時)

[管理画面: デモデータ生成]
     └── INSERT → packages + delivery_status + routes

[管理画面: ワークフロー]
     ├── driver-attendance → drivers.is_active + driver_attendance
     ├── routes/generate (confirm) → routes + delivery_status + packages (route_id, stop_order)
     ├── routes/assign → delivery_status + packages.route_id + routes
     ├── load-confirm → delivery_status.status + packages.loading_order + routes.status
     ├── readjust (confirm) → delivery_status.stop_order + packages.stop_order + routes (距離/件数)
     ├── next-trip (confirm) → routes + delivery_status + packages.route_id
     ├── driver-withdraw (confirm) → delivery_status + drivers.is_active + routes + driver_attendance
     ├── daily-close → delivery_status.status + routes.status + driver_attendance.check_out_time
     └── alerts → delivery_alerts

[Snowflake タスクチェーン (23:00 JST)]
     Postgres delivery_status ──ETL──→ Snowflake DELIVERY_HISTORY
                                    → KPI_DAILY
                                    → RISK_SCORES (再計算)
                                    → ABSENCE_PATTERNS (再予測)
                                    → DEMAND_FORECAST (再予測)
                                    ↓
                              Iceberg v3 → S3 Parquet → ft_* (即反映)

[アプリ API — 読み取り]
     ├── Plan画面: ft_risk_scores, ft_absence_patterns, packages, routes
     ├── Monitor画面: driver_locations, delivery_status, traffic_realtime, delivery_dwell
     └── Review画面: ft_kpi_daily, ft_demand_forecast, ft_delivery_history

[アプリ API — 書き込み (ワークフロー)]
     ├── driver-attendance POST → drivers.is_active + driver_attendance (UPSERT)
     ├── routes/generate POST (confirm=true) → routes + delivery_status + packages
     ├── routes/assign POST → delivery_status + packages.route_id + routes (UPSERT)
     ├── load-confirm POST → delivery_status.status=loaded + packages.loading_order + routes.status=loaded
     ├── readjust POST (confirm=true) → delivery_status.stop_order + packages.stop_order + routes (距離/件数)
     ├── next-trip POST (confirm=true) → routes (新規) + delivery_status + packages.route_id
     ├── driver-withdraw POST (confirm=true) → delivery_status + drivers.is_active + routes.status=cancelled + driver_attendance
     ├── daily-close POST → delivery_status.status=returned + routes.status=completed + driver_attendance.check_out_time
     └── alerts GET → delivery_alerts (UPSERT)
```
