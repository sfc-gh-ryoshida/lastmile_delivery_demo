# ラストワンマイル配送所長アプリ — インプリメントガイド

## 概要

本ガイドは企画書 (`logistics_demo_proposal.md`) に基づき、デモ環境を構築する手順を定義する。

**対象エリア:** 東京都江東区（豊洲・有明・東雲・辰巳）
**デモ日付:** 荷物の「明日」は `CURRENT_DATE + 1` を基準に自動計算

---

## ファイル構成

```
pg_lake/
├── logistics_demo_proposal.md          # 企画書
├── implementation_guide.md             # 本ガイド
├── setup/
│   ├── 01_snowflake_setup.sql          # Snowflake 本体: DB/スキーマ/テーブル定義
│   ├── 02_postgres_schema.sql          # Postgres: テーブル定義 + インデックス
│   ├── 03_postgres_demo_data.sql       # Postgres: デモデータ生成
│   └── 04_snowflake_demo_data.sql      # Snowflake 本体: 分析/ML用デモデータ
├── road_network/                       # Phase 2: OSM→pgrouting 変換
│   └── (osm2po で生成)
├── fastapi/                            # Phase 4: FastAPI サーバー
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
├── react/                              # Phase 4: React 所長アプリ (スキルで構築)
├── osrm/                              # OSRM サイドカー (道路距離エンジン)
│   ├── Dockerfile                     # osrm-backend v5.27.1, MLD, 関東BBOX抽出
│   └── build.sh                       # ビルドヘルパー
├── streamlit/                          # Phase 5: Streamlit in Snowflake
└── notebook/                           # Phase 3: ML 開発 Notebook
```

---

## 実装フェーズ

### Phase 0: 前提条件の確認 (0.5日)

| # | 確認事項 | 方法 |
|---|---------|------|
| 0-1 | Snowflake アカウントで SPCS が有効 | `SHOW COMPUTE POOLS` |
| 0-2 | Snowflake Postgres が利用可能 | `SHOW MANAGED INSTANCES` |
| 0-3 | Snowflake Notebook が利用可能 | Snowsight で確認 |
| 0-4 | Mapbox アクセストークン取得 | https://account.mapbox.com/ |
| 0-5 | OSM データダウンロード (江東区) | Geofabrik or Overpass API |

```sql
-- SPCS 確認
SHOW COMPUTE POOLS;

-- Postgres インスタンス一覧
SHOW MANAGED INSTANCES;
```

---

### Phase 1: Snowflake 本体セットアップ (0.5日)

**実行ファイル:** `setup/01_snowflake_setup.sql`

```
実行手順:
1. Snowsight (またはSnow CLI) で ACCOUNTADMIN ロールで実行
2. LASTMILE_DB データベース + 3スキーマ (ANALYTICS, ML, RAW) が作成される
3. Iceberg Tables (8テーブル) + RAW テーブル (2テーブル) が作成される
```

**確認:**
```sql
USE DATABASE LASTMILE_DB;
SHOW TABLES IN SCHEMA ANALYTICS;
-- 期待: 8テーブル (delivery_history, risk_scores, absence_patterns, ...)

SHOW TABLES IN SCHEMA RAW;
-- 期待: 2テーブル (gps_raw, status_raw)
```

---

### Phase 2: Snowflake Postgres セットアップ (1日)

#### 2-1. インスタンス作成

```sql
-- Snowflake 本体から実行
CREATE MANAGED INSTANCE lastmile_postgres
  INSTANCE_TYPE = 'STANDARD'
  -- その他パラメータは最新ドキュメント参照
;
```

> **注意:** インスタンス作成後、接続文字列を確認しておく。

#### 2-2. 拡張有効化 + スキーマ作成

**実行ファイル:** `setup/02_postgres_schema.sql`

```
手順:
1. psql または Snowflake Postgres クライアントで接続
2. 02_postgres_schema.sql を実行
3. 拡張 6つ + テーブル 8つ + インデックス が作成される
```

**確認:**
```sql
-- 拡張一覧
\dx
-- 期待: postgis, h3, h3_postgis, pgrouting, pg_cron

-- テーブル一覧
\dt
-- 期待: depots, drivers, packages, driver_locations,
--       delivery_status, routes, traffic_realtime,
--       road_construction, road_network

-- インデックス確認
\di
-- GIST インデックスが driver_locations, packages, routes, road_construction に存在
```

#### 2-3. デモデータ投入

**実行ファイル:** `setup/03_postgres_demo_data.sql`

```
手順:
1. psql で 03_postgres_demo_data.sql を実行
2. 所要時間: 約3-5分 (30日分 × 約470件/日 = 約14,000件の荷物データ)
```

**確認:**
```sql
-- 配送所
SELECT * FROM depots;
-- 期待: 1行 (DEPOT-TOYOSU)

-- ドライバー
SELECT COUNT(*) FROM drivers;
-- 期待: 12

-- 荷物 (明日分)
SELECT COUNT(*) FROM packages WHERE date = CURRENT_DATE + 1;
-- 期待: 約487

-- 荷物 (過去30日)
SELECT date, COUNT(*) FROM packages WHERE date <= CURRENT_DATE GROUP BY date ORDER BY date;
-- 期待: 各日 450-550 件

-- 配達状況 (当日 = デモ途中状態)
SELECT status, COUNT(*) FROM delivery_status
WHERE date = CURRENT_DATE GROUP BY status;
-- 期待: delivered ~280, absent ~32, in_transit ~28, assigned ~147

-- ドライバー位置
SELECT driver_id, speed, timestamp FROM driver_locations ORDER BY driver_id;
-- 期待: 12行 (DRV-003 の speed = 0: 停車中 = 遅延デモ用)

-- 渋滞
SELECT COUNT(*) FROM traffic_realtime;
-- 期待: ~1100 (100セル × 11時間)

-- 工事
SELECT * FROM road_construction;
-- 期待: 2行 (辰巳橋、東雲交差点)

-- ルート (明日分)
SELECT route_id, driver_id, stop_count FROM routes WHERE date = CURRENT_DATE + 1;
-- 期待: 12行

-- H3 動作確認
SELECT h3_latlng_to_cell(point(139.7914, 35.6495), 9);
-- H3 セルが返ること

-- h3_postgis 動作確認
SELECT ST_AsText(h3_cell_to_boundary_geometry(h3_latlng_to_cell(point(139.7914, 35.6495), 9)));
-- POLYGON が返ること

-- h3_grid_disk 動作確認
SELECT h3_grid_disk(h3_latlng_to_cell(point(139.7914, 35.6495), 9), 1);
-- 7セルの配列が返ること
```

---

### Phase 3: Snowflake 本体 デモデータ投入 (0.5日)

**実行ファイル:** `setup/04_snowflake_demo_data.sql`

```
手順:
1. Snowsight で LASTMILE_DB.ANALYTICS スキーマに対して実行
2. 所要時間: 約2-3分
```

**確認:**
```sql
USE DATABASE LASTMILE_DB;
USE SCHEMA ANALYTICS;

-- 配送実績
SELECT COUNT(*) FROM delivery_history;
-- 期待: ~14,000 行 (30日 × ~470件)

-- リスクスコア
SELECT date, COUNT(*) FROM risk_scores GROUP BY date ORDER BY date;
-- 期待: 8日分 × 200セル × 11時間 = ~17,600 行

-- 不在パターン
SELECT COUNT(*) FROM absence_patterns;
-- 期待: ~500-1000 行

-- 異常アラート (デモ用)
SELECT * FROM anomaly_alerts;
-- 期待: 3行 (DRV-003: 鈴木, DRV-006: 伊藤)

-- KPI
SELECT * FROM kpi_daily ORDER BY date DESC LIMIT 5;
-- 期待: 直近5日の KPI

-- 天気予報 (明日分)
SELECT weather_code, COUNT(*) FROM weather_forecast GROUP BY weather_code;
-- 期待: clear, cloudy, rain

-- 需要予測
SELECT * FROM demand_forecast ORDER BY date;
-- 期待: 7行 (翌週分)

-- H3 関数確認
SELECT H3_LATLNG_TO_CELL_STRING(35.6495, 139.7914, 9);
```

#### H3 解像度マップ

| テーブル | カラム | 解像度 | 備考 |
|----------|--------|--------|------|
| DELIVERY_HISTORY | H3_INDEX_R9 | R9 | 配送ベース (Postgres h3_index と同値) |
| RISK_SCORES | H3_INDEX | R9 | SP_RECALC_RISK_SCORES が DH.R9 をそのまま使用 |
| H3_COST_MATRIX | FROM_H3, TO_H3 | R10 | SP 内で 3 ソースを UNION: ①RISK_SCORES R9→R10 (H3_CELL_TO_CHILDREN_STRING), ②BUILDING_ATTRIBUTES R11→R10 (H3_CELL_TO_PARENT), ③depot セル。887 セル, 加算式 TOTAL_COST |
| ABSENCE_PATTERNS | H3_INDEX | R9 | SP_PREDICT_ABSENCE が DH.R9 をそのまま出力 |
| BUILDING_ATTRIBUTES | H3_INDEX | R11 | 建物レベル。SP内で H3_CELL_TO_PARENT(R11,9)→R9 に集約して JOIN |
| V_POI_AREA_PROFILE | H3_INDEX | R8 | エリアレベル。grid.R8 = H3_CELL_TO_PARENT(R9,8) で JOIN |
| WEATHER_FORECAST | H3_INDEX | R7 | 広域天気 |
| traffic_realtime (PG) | h3_index | R7 | 広域渋滞 |
| road_construction (PG) | h3_index | R9 | 工事エリア |

**設計原則**: R9 をDB保存ベース解像度とし、他の解像度は `H3_CELL_TO_PARENT` (粗く) / `H3_CELL_TO_CHILDREN` (細かく) で都度計算。

**表示解像度**: R11 デフォルト (建物レベル)、R10 切替可能。APIが `resolution` パラメータで受け付ける。
**計算解像度**: R10 (H3_COST_MATRIX と同じ。generate/next-trip の RISK_RES=10)。
**コスト行列**: 887 セル × 886 対向 × 13 時間 × 7 日 ≈ 71.5M 行。TOTAL_COST = distance_km + risk*0.5 + weather*0.15 (加算式)。
**渋滞表示**: R10 デフォルト (R7→R11は211K行で重いため)。

---

### Phase 4: 道路ネットワーク構築 — pgrouting 用 (3日)

この Phase は工数最大のため、詳細手順を記載。

#### 4-1. OSM データ取得

```bash
# Overpass API で江東区エリアを取得
# BBox: 35.620,139.770,35.665,139.830
wget -O koto.osm "https://overpass-api.de/api/map?bbox=139.770,35.620,139.830,35.665"
```

または Geofabrik の関東リージョンから江東区を切り出し:
```bash
osmconvert kanto-latest.osm.pbf -b=139.770,35.620,139.830,35.665 -o=koto.osm.pbf
```

#### 4-2. osm2po で pgrouting 用 SQL 変換

```bash
# osm2po ダウンロード
wget https://osm2po.de/releases/osm2po-5.5.11.zip
unzip osm2po-5.5.11.zip

# 変換実行
java -jar osm2po-core-5.5.11-signed.jar prefix=koto koto.osm

# 出力: koto/koto_2po_4pgr.sql
```

#### 4-3. Postgres にロード

```bash
psql -h <POSTGRES_HOST> -U <USER> -d <DB> -f koto/koto_2po_4pgr.sql
```

#### 4-4. pgrouting トポロジー作成

```sql
-- road_network にデータコピー (osm2po のテーブル名は koto_2po_4pgr)
INSERT INTO road_network (source, target, cost, reverse_cost, the_geom, road_class, name)
SELECT source, target, cost, reverse_cost, geom_way, clazz::varchar, osm_name
FROM koto_2po_4pgr;

-- トポロジー検証
SELECT pgr_analyzeGraph('road_network', 0.001, 'the_geom', 'id');
```

#### 4-5. 動作確認

```sql
-- 最短経路テスト (豊洲配送所から有明方面)
SELECT * FROM pgr_dijkstra(
    'SELECT id, source, target, cost, reverse_cost FROM road_network',
    (SELECT source FROM road_network
     ORDER BY ST_Distance(the_geom, ST_SetSRID(ST_MakePoint(139.7914, 35.6495), 4326))
     LIMIT 1),
    (SELECT source FROM road_network
     ORDER BY ST_Distance(the_geom, ST_SetSRID(ST_MakePoint(139.7950, 35.6350), 4326))
     LIMIT 1)
) LIMIT 10;

-- TSP テスト (5配送先の巡回)
SELECT * FROM pgr_TSP(
    $$SELECT * FROM pgr_dijkstraCostMatrix(
        'SELECT id, source, target, cost, reverse_cost FROM road_network',
        ARRAY[1, 100, 200, 300, 400]
    )$$
);
```

> **Plan B:** VRPTW (500荷物×12車両) が数分かかる場合:
> 1. エリア分割: A/B/C 各エリアで独立に TSP → 並列実行
> 2. OR-Tools: Python で google.ortools.constraint_solver を使用

---

### Phase 5: pg_lake 設定 (0.5日)

Snowflake 本体の Iceberg Tables を Postgres から参照できるようにする。

```sql
-- Postgres 側で pg_lake 拡張を有効化 (Phase 2 で済み)

-- Iceberg テーブルの外部参照設定
-- ※ pg_lake の設定構文は最新ドキュメントを参照
-- 参照対象テーブル:
--   risk_scores        (ML 出力: リスクスコア)
--   absence_patterns   (ML 出力: 不在パターン)
--   anomaly_alerts     (Cortex ML 出力: 異常検知)
--   weather_forecast   (Marketplace: 天気予報)
--   building_attributes (マスタ: 建物属性)
```

**確認:**
```sql
-- Postgres から Iceberg テーブルを SELECT できることを確認
SELECT COUNT(*) FROM risk_scores_iceberg WHERE date = CURRENT_DATE + 1;
SELECT COUNT(*) FROM absence_patterns_iceberg;
SELECT COUNT(*) FROM weather_forecast_iceberg WHERE datetime::date = CURRENT_DATE + 1;
```

---

### Phase 6: ML パイプライン構築 — Notebook (2日)

**実行環境:** Snowflake Notebook (LASTMILE_DB.ML スキーマ)

#### 6-1. 不在予測モデル (XGBoost)

```
Notebook セル構成:
1. データロード: delivery_history + weather + building_attributes を JOIN
2. 特徴量:
   - H3 R9 セル → カテゴリエンコード (モデル内部では H3_R8 カラム名で参照)
   - 曜日 (0-6), 時間帯 (8-20)
   - 降水確率, 風速, 気温
   - 建物タイプ, EV有無, 宅配BOX有無
   - 過去30日の同セル不在率 (ラグ特徴量)
3. XGBoost 分類器 (absent/delivered)
4. Model Registry に登録
5. SQL UDF として公開
```

**コアコード (セル例):**
```python
from snowflake.ml.modeling.xgboost import XGBClassifier
from snowflake.ml.registry import Registry

model = XGBClassifier(
    input_cols=feature_cols,
    label_cols=["IS_ABSENT"],
    output_cols=["ABSENCE_PREDICTION"]
)
model.fit(train_df)

reg = Registry(session=session, database_name="LASTMILE_DB", schema_name="ML")
mv = reg.log_model(
    model,
    model_name="absence_predictor",
    version_name="v1",
    sample_input_data=train_df.select(feature_cols).limit(10)
)
```

#### 6-2. リスクスコアリングモデル (LightGBM)

```
同様の構成で:
- 入力: absence_patterns + weather_forecast + road_construction + traffic
- 出力: risk_score (0.0 - 1.0 回帰)
- LightGBMRegressor → Model Registry → SQL UDF
```

#### 6-3. Cortex ML (SQL ベース)

```sql
-- 異常検知モデル作成
CREATE OR REPLACE SNOWFLAKE.ML.ANOMALY_DETECTION delivery_pace_anomaly(
    INPUT_DATA => SYSTEM$REFERENCE('TABLE', 'LASTMILE_DB.ANALYTICS.DELIVERY_HISTORY'),
    TIMESTAMP_COLNAME => 'COMPLETED_AT',
    TARGET_COLNAME => 'DELIVERY_TIME_SEC',
    LABEL_COLNAME => ''
);

-- 需要予測モデル作成
CREATE OR REPLACE SNOWFLAKE.ML.FORECAST demand_forecast_model(
    INPUT_DATA => SYSTEM$REFERENCE('TABLE', 'LASTMILE_DB.ANALYTICS.KPI_DAILY'),
    TIMESTAMP_COLNAME => 'DATE',
    TARGET_COLNAME => 'TOTAL_PACKAGES'
);
```

#### 6-4. バッチ推論 Task

```sql
-- 日次 04:00 にリスクスコア更新
CREATE OR REPLACE TASK LASTMILE_DB.ML.DAILY_RISK_SCORING
  WAREHOUSE = 'RYOSHIDA_WH'
  SCHEDULE = 'USING CRON 0 4 * * * Asia/Tokyo'
AS
  INSERT INTO LASTMILE_DB.ANALYTICS.risk_scores (h3_index, date, hour, risk_score, risk_factors)
  SELECT ...;  -- UDF を使った推論クエリ

-- 毎時の異常検知 Task
CREATE OR REPLACE TASK LASTMILE_DB.ML.HOURLY_ANOMALY_CHECK
  WAREHOUSE = 'RYOSHIDA_WH'
  SCHEDULE = 'USING CRON 0 * * * * Asia/Tokyo'
AS
  INSERT INTO LASTMILE_DB.ANALYTICS.anomaly_alerts ...;
```

---

### Phase 7: アプリケーション構築 (7日)

> **注意:** React / FastAPI / Streamlit の構築はスキルを利用して別途実施。
> 本セクションは構成の概要と API 仕様のみ記載。

#### 7-1. FastAPI (2日)

```
エンドポイント一覧:

GET  /api/packages?date=YYYY-MM-DD&depot_id=xxx    荷物一覧
GET  /api/drivers?depot_id=xxx                       ドライバー一覧
GET  /api/routes?date=YYYY-MM-DD                     ルート一覧
GET  /api/risk-map?date=YYYY-MM-DD                   H3 リスクマップ (pg_lake)
GET  /api/traffic?datetime=xxx                       渋滞情報
GET  /api/construction?date=YYYY-MM-DD               工事情報
GET  /api/kpi?date=YYYY-MM-DD&depot_id=xxx           KPI
GET  /api/absence-heatmap?date=YYYY-MM-DD            不在ヒートマップ (pg_lake)

POST /api/routes/generate                            ルート自動生成 (pgrouting)
POST /api/routes/{route_id}/reroute                  リルート
POST /api/packages/assign                            荷物割り振り
POST /api/simulation/incident                        事故影響シミュレーション

PUT  /api/delivery-status/{package_id}               配達状況更新
PUT  /api/driver-locations/{driver_id}               GPS UPSERT

WS   /ws/locations                                   GPS リアルタイム (WebSocket)
WS   /ws/alerts                                      アラート通知 (WebSocket)
```

**Postgres 接続:**
```python
# FastAPI 内での Postgres 接続
import asyncpg

pool = await asyncpg.create_pool(
    host="<POSTGRES_INTERNAL_HOST>",
    port=5432,
    database="<DB>",
    user="<USER>",
    password="<PASSWORD>",
    min_size=5,
    max_size=20
)
```

#### 7-2. React 所長アプリ (5日)

```
技術スタック:
- React 18 + TypeScript
- Vite
- deck.gl (H3HexagonLayer, GeoJsonLayer, IconLayer, PathLayer, EditableGeoJsonLayer)
- Mapbox GL JS (ベースマップ)
- Ant Design (UI コンポーネント)
- SWR (データフェッチ)
- WebSocket (リアルタイム)

ページ構成:
- /plan          Tab 1: 明日の計画
- /monitor       Tab 2: 今日の現場
- /review        Tab 3: 振り返り
```

#### 7-3. SPCS デプロイ (1日)

```yaml
# spcs_spec.yaml
spec:
  containers:
    - name: fastapi
      image: /lastmile_db/ml/image_repo/fastapi:latest
      env:
        POSTGRES_HOST: "<INTERNAL_HOST>"
        POSTGRES_DB: "<DB>"
      resources:
        requests:
          cpu: 1
          memory: 2Gi
    - name: react
      image: /lastmile_db/ml/image_repo/react-app:latest
      resources:
        requests:
          cpu: 0.5
          memory: 1Gi
    - name: osrm
      image: /lastmile_db/spcs/lastmile_repo/osrm-kanto:latest
      resources:
        requests:
          cpu: 1
          memory: 2Gi
  endpoints:
    - name: app
      port: 3000
      public: true
    - name: api
      port: 8000
      public: false
```

---

### Phase 8: Streamlit in Snowflake (2日)

```
ページ構成:
1. ML モデル精度モニタリング
2. KPI トレンド (日次/週次/月次)
3. 不在パターン可視化 (H3 R9 ヒートマップ, 表示時に解像度変換可)
4. リスクスコア分布
5. A/B テスト結果

データ接続: Snowflake 本体のみ (session.sql() で直接クエリ)
```

---

### Phase 9: デモデータ調整 + リハーサル (1日)

#### 9-1. デモシナリオ用データチューニング

| シナリオ | データ調整 |
|---------|-----------|
| エリアC が赤い (リスク高) | risk_scores で エリアC の H3 セルを 0.7-1.0 に設定済み |
| 鈴木が遅延中 | DRV-003 の speed=0, 配達件数が低い状態で設定済み |
| エリアB に渋滞 | traffic_realtime の congestion_level=3-4 で設定済み |
| 異常アラート | anomaly_alerts に DRV-003 のレコード設定済み |
| 午後から雨 | weather_forecast で 13:00以降 precipitation > 2.0 で設定済み |
| エリアC に工事 | road_construction に2件設定済み |

#### 9-2. GPS シミュレータ

```python
# デモ用 GPS シミュレータ (リアルタイム位置更新)
# ルート geometry に沿って座標を移動させる
# FastAPI の PUT /api/driver-locations/{driver_id} を定期呼び出し

import asyncio
import httpx

async def simulate_driver(driver_id, route_coords, api_url):
    async with httpx.AsyncClient() as client:
        for i, (lng, lat) in enumerate(route_coords):
            await client.put(
                f"{api_url}/api/driver-locations/{driver_id}",
                json={"lat": lat, "lng": lng, "speed": 25.0 + random.uniform(-10, 10)}
            )
            await asyncio.sleep(2)
```

#### 9-3. チェックリスト

- [ ] Snowflake 本体: LASTMILE_DB 全テーブルにデータあり
- [ ] Postgres: 全テーブルにデータあり、インデックス作成済み
- [ ] pg_lake: Postgres → Iceberg 参照が SELECT 可能
- [ ] pgrouting: pgr_dijkstra, pgr_TSP が動作する
- [ ] H3: Snowflake H3 関数 + Postgres h3/h3_postgis が動作する
- [ ] SPCS: React + FastAPI コンテナが起動し、アプリにアクセス可能
- [ ] WebSocket: GPS リアルタイム更新が動作する
- [ ] Streamlit: ダッシュボードが表示される
- [ ] ML: Model Registry にモデルが登録されている
- [ ] Cortex ML: ANOMALY_DETECTION, FORECAST が動作する
- [ ] GPS シミュレータ: ドライバーが地図上を移動する
- [ ] デモシナリオ: Act 1-3 を通しで 20分以内に完了できる
- [ ] 事故シミュレーション: クリック → 影響度算出 → リルートが動作する

---

## 依存関係マップ

```
Phase 0: 前提確認
    │
    ├──→ Phase 1: Snowflake 本体セットアップ
    │       │
    │       ├──→ Phase 3: Snowflake デモデータ
    │       │       │
    │       │       └──→ Phase 6: ML パイプライン
    │       │
    │       └──→ Phase 5: pg_lake 設定 ←──┐
    │                                      │
    └──→ Phase 2: Postgres セットアップ ────┘
            │
            ├──→ Phase 4: 道路ネットワーク (pgrouting)
            │
            └──→ Phase 7: アプリ構築 (React + FastAPI + SPCS)
                    │
                    └──→ Phase 8: Streamlit
                            │
                            └──→ Phase 9: リハーサル
```

**クリティカルパス:** Phase 0 → Phase 2 → Phase 4 (道路NW: 3日) → Phase 7 → Phase 9

---

## 工数サマリ

| Phase | 内容 | 工数 | 累計 |
|-------|------|------|------|
| 0 | 前提確認 | 0.5日 | 0.5日 |
| 1 | Snowflake 本体セットアップ | 0.5日 | 1日 |
| 2 | Postgres セットアップ + デモデータ | 1日 | 2日 |
| 3 | Snowflake デモデータ | 0.5日 | 2.5日 |
| 4 | 道路ネットワーク (pgrouting) | 3日 | 5.5日 |
| 5 | pg_lake 設定 | 0.5日 | 6日 |
| 6 | ML パイプライン (Notebook) | 2日 | 8日 |
| 7 | アプリ構築 (React + FastAPI + SPCS) | 7日 | 15日 |
| 8 | Streamlit ダッシュボード | 2日 | 17日 |
| 9 | リハーサル | 1日 | **18日** |

---

## トラブルシューティング

### h3_postgis が見つからない
```sql
-- 拡張の有効化を確認
SELECT * FROM pg_available_extensions WHERE name LIKE 'h3%';
-- h3, h3_postgis が available であること
CREATE EXTENSION h3_postgis CASCADE;
```

### pg_lake で Iceberg テーブルが参照できない
- Iceberg テーブルに `DATE` パーティションが設定されているか確認
- pg_lake の接続設定（カタログ情報）が正しいか確認
- Snowflake 本体側で `ALTER TABLE ... SET DATA_RETENTION_TIME_IN_DAYS` を確認

### pgrouting の TSP が遅い
```sql
-- ノード数を確認
SELECT COUNT(DISTINCT source) + COUNT(DISTINCT target) FROM road_network;
-- 10,000 ノード以上の場合、エリア分割を検討

-- エリア A のみでテスト
SELECT * FROM pgr_TSP(
    $$SELECT * FROM pgr_dijkstraCostMatrix(
        'SELECT id, source, target, cost, reverse_cost FROM road_network
         WHERE ST_Intersects(the_geom, ST_MakeEnvelope(139.780, 35.645, 139.800, 35.660, 4326))',
        ARRAY[...]
    )$$
);
```

### SPCS コンテナが Postgres に接続できない
```sql
-- 内部ネットワーク設定を確認
SHOW SERVICES;
DESCRIBE SERVICE lastmile_app;
-- endpoint が INTERNAL になっていることを確認
-- Postgres の pg_hba.conf で SPCS の IP レンジを許可
```
