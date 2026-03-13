# Lastmile Delivery Demo — ゼロからのデプロイガイド

FSI_Japan などの参照環境を **持たない** 人でも、ゼロからフルスタックでデモ環境を構築できるガイド。

---

## 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ブラウザ                                                                │
│    ↓ HTTPS                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  SPCS (Snowpark Container Services)                                │ │
│  │  ┌──────────────────────┐    ┌──────────────────────┐            │ │
│  │  │  lastmile-app        │    │  osrm (ルーティング)   │            │ │
│  │  │  (Next.js)           │───→│  (Port 5000)         │            │ │
│  │  │  Port 8080           │    └──────────────────────┘            │ │
│  │  │    │          │      │                                        │ │
│  │  └────┼──────────┼──────┘                                        │ │
│  │       │sfQuery   │pgQuery                                        │ │
│  └───────┼──────────┼──────────────────────────────────────────────┘ │
│          ▼          ▼                                                   │
│  ┌─────────────┐  ┌──────────────────────────────────┐               │
│  │  Snowflake   │  │  Snowflake Postgres               │               │
│  │  (分析テーブル) │  │  (OLTP + ft_* Foreign Tables)     │               │
│  │  ANALYTICS   │  │                                    │               │
│  └──────┬──────┘  └──────────────┬───────────────────┘               │
│         │ Iceberg 書き出し         │ pg_lake で読み取り                    │
│         ▼                        ▼                                     │
│  ┌──────────────────────────────────┐                                 │
│  │  S3 (Parquet + Iceberg metadata)  │                                 │
│  │  s3://<bucket>/<prefix>/          │                                 │
│  └──────────────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

**データフロー**:
1. **Snowflake → S3**: Iceberg Table が Parquet を自動書き出し
2. **S3 → Postgres**: pg_lake Foreign Table が S3 Parquet を直接読み取り（ETL 不要）
3. **アプリ**: sfQuery (Snowflake SDK) と pgQuery (pg ドライバー) のデュアルパス

---

## 前提条件

| 項目 | 要件 |
|------|------|
| Snowflake | Enterprise Edition 以上 (Iceberg v3 対応) |
| AWS | S3 バケット (Snowflake と同一リージョン) + IAM ロール |
| Mapbox | アクセストークン (地図表示用) |
| Docker | ローカルで `docker build` + `docker push` が可能 |
| OSRM | 関東エリアの OSRM Docker イメージ (ルーティング用) |

---

## Phase 1: AWS IAM セットアップ

### 1-1. S3 バケット

Snowflake と同一リージョン (例: us-west-2) に S3 バケットを作成。
パブリックアクセスブロックは全て ON で問題ない。

```
s3://<YOUR-BUCKET>/<YOUR-PREFIX>/
```

### 1-2. IAM ロール作成

```
arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>
```

**最大セッション時間を 12 時間に設定**（デフォルト 1h では pg_lake の認証が切れる）。

### 1-3. Permission Policy

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:GetObjectVersion",
                "s3:DeleteObject",
                "s3:DeleteObjectVersion"
            ],
            "Resource": "arn:aws:s3:::<YOUR-BUCKET>/<YOUR-PREFIX>/*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket",
                "s3:GetBucketLocation"
            ],
            "Resource": "arn:aws:s3:::<YOUR-BUCKET>"
        }
    ]
}
```

### 1-4. Trust Policy

後の Phase で取得する 3 つの Principal/ExternalId を設定する。
この時点ではプレースホルダーで可。

Trust Policy には **3 つのエントリ** が必要:

| # | 対象 | Principal (IAM_USER_ARN) | ExternalId |
|---|------|-------------------------|------------|
| 1 | Storage Integration (pg_lake 用) | `arn:aws:iam::<SF_AWS_ID>:user/snowflake-postgres-integration-management` | Phase 2-2 で取得 |
| 2 | External Volume (Iceberg 用) | `arn:aws:iam::<SF_AWS_ID>:user/mc9m0000-s` | Phase 2-4 で取得 |
| 3 | Storage Integration (Iceberg Stage 用) | `arn:aws:iam::<SF_AWS_ID>:user/mc9m0000-s` | Phase 2-2 と同じ (兼用の場合) |

> Storage Integration の TYPE によって ARN が異なる:
> - `TYPE = POSTGRES_EXTERNAL_STORAGE` → `user/snowflake-postgres-integration-management`
> - `TYPE = EXTERNAL_STAGE` → `user/mc9m0000-s`

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": [
                    "arn:aws:iam::<SF_AWS_ID_1>:user/snowflake-postgres-integration-management",
                    "arn:aws:iam::<SF_AWS_ID_2>:user/mc9m0000-s"
                ]
            },
            "Action": "sts:AssumeRole",
            "Condition": {
                "StringEquals": {
                    "sts:ExternalId": [
                        "<EXTERNAL_ID_1_STORAGE_INT>",
                        "<EXTERNAL_ID_2_EXT_VOLUME>",
                        "<EXTERNAL_ID_3_PG_LAKE>"
                    ]
                }
            }
        }
    ]
}
```

---

## Phase 2: Snowflake 基盤セットアップ

### 2-1. データベース・スキーマ・ウェアハウス

```sql
USE ROLE ACCOUNTADMIN;

CREATE DATABASE IF NOT EXISTS LASTMILE_DB;
CREATE SCHEMA IF NOT EXISTS LASTMILE_DB.ANALYTICS;
CREATE SCHEMA IF NOT EXISTS LASTMILE_DB.ML;
CREATE SCHEMA IF NOT EXISTS LASTMILE_DB.RAW;
CREATE SCHEMA IF NOT EXISTS LASTMILE_DB.SPCS;

CREATE WAREHOUSE IF NOT EXISTS APP_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE;
```

### 2-2. Storage Integration (pg_lake 用)

```sql
CREATE OR REPLACE STORAGE INTEGRATION PG_LAKE_INTEGRATION
    TYPE = POSTGRES_EXTERNAL_STORAGE
    ENABLED = TRUE
    STORAGE_PROVIDER = 'S3'
    STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>'
    STORAGE_ALLOWED_LOCATIONS = ('s3://<YOUR-BUCKET>/<YOUR-PREFIX>/');

DESC STORAGE INTEGRATION PG_LAKE_INTEGRATION;
-- → STORAGE_AWS_IAM_USER_ARN, STORAGE_AWS_EXTERNAL_ID を控える
```

> `TYPE = POSTGRES_EXTERNAL_STORAGE` は pg_lake 専用。通常の `EXTERNAL_STAGE` とは異なる。

### 2-3. Stage + File Format (INFER_SCHEMA 用)

```sql
USE DATABASE LASTMILE_DB;
USE SCHEMA RAW;

CREATE OR REPLACE FILE FORMAT PARQUET_FF TYPE = PARQUET;

CREATE OR REPLACE STAGE PG_LAKE_STAGE
  URL = 's3://<YOUR-BUCKET>/<YOUR-PREFIX>/'
  STORAGE_INTEGRATION = PG_LAKE_INTEGRATION
  FILE_FORMAT = (TYPE = PARQUET);
```

> Stage は Iceberg Parquet のカラム順を INFER_SCHEMA で調べるために必要。

### 2-4. External Volume (Iceberg 用)

```sql
CREATE OR REPLACE EXTERNAL VOLUME PG_LAKE_VOLUME
  STORAGE_LOCATIONS = (
    (
      NAME = 'pg-lake-s3'
      STORAGE_BASE_URL = 's3://<YOUR-BUCKET>/<YOUR-PREFIX>/'
      STORAGE_PROVIDER = 'S3'
      STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>'
    )
  );

DESC EXTERNAL VOLUME PG_LAKE_VOLUME;
-- → STORAGE_AWS_IAM_USER_ARN, STORAGE_AWS_EXTERNAL_ID を控える
-- ★ Storage Integration とは別の ExternalId が発行される
```

### 2-5. AWS Trust Policy を更新

Phase 2-2 と 2-4 で得た IAM_USER_ARN と ExternalId を AWS Trust Policy に追加する。

### 2-6. 通常テーブルの作成

`setup/01_snowflake_setup.sql` を実行。ANALYTICS スキーマに 8 テーブル、RAW スキーマに 2 テーブルを作成。

```sql
USE DATABASE LASTMILE_DB;
USE SCHEMA ANALYTICS;

-- delivery_history, risk_scores, absence_patterns, anomaly_alerts,
-- demand_forecast, kpi_daily, weather_forecast, building_attributes
-- (定義は setup/01_snowflake_setup.sql 参照)
```

### 2-7. Iceberg テーブルの作成

通常テーブルとは **別に** Iceberg テーブルを作成する。
アプリの ft_* (Foreign Table) 経由で Postgres から読むデータはこちらに投入する。

```sql
USE SCHEMA ANALYTICS;

CREATE ICEBERG TABLE DELIVERY_HISTORY (
    delivery_id STRING, package_id STRING, driver_id STRING,
    depot_id STRING, date DATE, status STRING,
    is_absent BOOLEAN, attempt_count INT,
    completed_at TIMESTAMP_NTZ, loaded_at TIMESTAMP_NTZ,
    delivery_time_sec INT, h3_index_r9 STRING
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='PG_LAKE_VOLUME'
  BASE_LOCATION='managed/delivery_history/' ICEBERG_VERSION=3;

CREATE ICEBERG TABLE KPI_DAILY (
    date DATE, depot_id STRING,
    total_packages INT, delivered INT, absent INT,
    completion_rate FLOAT, absence_rate FLOAT,
    ontime_rate FLOAT, avg_delivery_time FLOAT,
    created_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='PG_LAKE_VOLUME'
  BASE_LOCATION='managed/kpi_daily/' ICEBERG_VERSION=3;

CREATE ICEBERG TABLE RISK_SCORES (
    h3_index STRING, date DATE, hour INT,
    risk_score FLOAT, weather_risk FLOAT, absence_risk FLOAT,
    building_risk FLOAT, poi_risk FLOAT,
    created_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='PG_LAKE_VOLUME'
  BASE_LOCATION='managed/risk_scores/' ICEBERG_VERSION=3;

CREATE ICEBERG TABLE ABSENCE_PATTERNS (
    h3_index STRING, day_of_week INT, hour INT,
    absence_rate FLOAT, sample_count INT,
    updated_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='PG_LAKE_VOLUME'
  BASE_LOCATION='managed/absence_patterns/' ICEBERG_VERSION=3;

CREATE ICEBERG TABLE DEMAND_FORECAST (
    date DATE, depot_id STRING,
    forecast_volume FLOAT, confidence_lower FLOAT, confidence_upper FLOAT,
    created_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='PG_LAKE_VOLUME'
  BASE_LOCATION='managed/demand_forecast/' ICEBERG_VERSION=3;

CREATE ICEBERG TABLE BUILDING_ATTRIBUTES (
    h3_index STRING, building_type STRING, avg_floors INT,
    has_elevator BOOLEAN, has_delivery_box BOOLEAN,
    updated_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='PG_LAKE_VOLUME'
  BASE_LOCATION='managed/building_attributes/' ICEBERG_VERSION=3;
```

**重要な制約**:
- `DEFAULT CURRENT_TIMESTAMP()` は Iceberg テーブルでは使えない。INSERT 時に明示的に値を渡す。
- `ICEBERG_VERSION = 3` を必ず明記。
- `VARIANT` 型はサポートされない。`risk_factors` は Iceberg テーブルでは除外し、代わりに個別カラム (`weather_risk`, `absence_risk` 等) に展開する。

---

## Phase 3: Snowflake Postgres セットアップ

### 3-1. Postgres インスタンスの作成

Snowsight UI または SQL でインスタンスを作成する。

```sql
CREATE POSTGRES INSTANCE "<instance_name>"
  INSTANCE_TYPE = 'SNOWFLAKE_POSTGRES'
  ...;
```

> 詳細は Snowflake Postgres ドキュメント参照。インスタンス作成後に接続情報 (ホスト, パスワード) を控える。

### 3-2. Storage Integration のアタッチ

```sql
ALTER POSTGRES INSTANCE "<instance_name>"
  SET STORAGE_INTEGRATION = PG_LAKE_INTEGRATION;

DESCRIBE POSTGRES INSTANCE "<instance_name>";
-- storage_integration 行に Integration 名が表示されることを確認
```

### 3-3. エクステンションのインストール

Postgres に接続して実行:

```sql
CREATE EXTENSION IF NOT EXISTS h3;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_lake CASCADE;
```

### 3-4. pg_lake デフォルトロケーションの設定

```sql
ALTER DATABASE postgres
  SET pg_lake_iceberg.default_location_prefix = 's3://<YOUR-BUCKET>/<YOUR-PREFIX>';
```

> 末尾スラッシュなし。

### 3-5. スキーマの作成

`setup/02_postgres_schema.sql` を実行。12 テーブル + トリガー + インデックスを作成。

```
depots, drivers, packages, delivery_status, routes,
driver_locations, driver_locations_history, traffic_realtime,
road_construction, driver_attendance, delivery_alerts
+ fn_log_driver_location トリガー
```

### 3-6. デモデータの投入

**方法 A**: SQL スクリプト

```bash
psql -h <PG_HOST> -U snowflake_admin -d postgres -f setup/03_postgres_demo_data.sql
```

**方法 B**: Python スクリプト (tools/seed_demo_data.py)

```bash
# tools/seed_demo_data.py の接続情報を編集してから実行
python tools/seed_demo_data.py
```

> Python スクリプトの方がデータの品質が高い（より多くのエリアをカバー、リアルな配送パターン）。
> **注意**: スクリプト内の `PG_HOST`, `PG_USER`, `PG_PASS`, `DATES`, `TODAY` を環境に合わせて編集すること。

### 3-7. 道路工事・渋滞データの追加

```bash
psql -h <PG_HOST> -U snowflake_admin -d postgres -f setup/05_demo_data_road_enrichment.sql
```

---

## Phase 4: Snowflake デモデータ投入 + Iceberg → ft_*

### 4-1. 通常テーブルへのデモデータ投入

```bash
# Snowflake で実行
# setup/04_snowflake_demo_data.sql
```

このスクリプトは通常テーブル (ANALYTICS.*) にデータを生成する。
以下のテーブルにデータが入る: delivery_history, risk_scores, absence_patterns,
anomaly_alerts, kpi_daily, weather_forecast, building_attributes, demand_forecast。

### 4-2. Iceberg テーブルへのデータ投入

通常テーブルのデータから Iceberg テーブルへ INSERT する。

```sql
USE DATABASE LASTMILE_DB;
USE SCHEMA ANALYTICS;

-- delivery_history (Iceberg)
INSERT INTO DELIVERY_HISTORY (
    delivery_id, package_id, driver_id, depot_id, date, status,
    is_absent, attempt_count, completed_at, loaded_at,
    delivery_time_sec, h3_index_r9
)
SELECT delivery_id, package_id, driver_id, depot_id, date, status,
       is_absent, attempt_count, completed_at, loaded_at,
       delivery_time_sec, h3_index_r9
FROM delivery_history;  -- 通常テーブルから

-- kpi_daily (Iceberg)
INSERT INTO KPI_DAILY (
    date, depot_id, total_packages, delivered, absent,
    completion_rate, absence_rate, ontime_rate, avg_delivery_time, created_at
)
SELECT date, depot_id, total_packages, delivered, absent,
       completion_rate, absence_rate, ontime_rate, avg_delivery_time, created_at
FROM kpi_daily;

-- risk_scores (Iceberg) — VARIANT → 個別カラムに展開
INSERT INTO RISK_SCORES (
    h3_index, date, hour, risk_score,
    weather_risk, absence_risk, building_risk, poi_risk, created_at
)
SELECT h3_index, date, hour, risk_score,
       risk_factors:weather_risk::FLOAT,
       risk_factors:absence_risk::FLOAT,
       COALESCE(risk_factors:construction_risk::FLOAT, 0),
       0,
       created_at
FROM risk_scores;

-- absence_patterns (Iceberg)
INSERT INTO ABSENCE_PATTERNS (
    h3_index, day_of_week, hour, absence_rate, sample_count, updated_at
)
SELECT h3_index, day_of_week, hour, absence_rate, sample_count, updated_at
FROM absence_patterns;

-- demand_forecast (Iceberg)
INSERT INTO DEMAND_FORECAST (
    date, depot_id, forecast_volume, confidence_lower, confidence_upper, created_at
)
SELECT date, depot_id, forecast_volume, confidence_lower, confidence_upper, created_at
FROM demand_forecast;

-- building_attributes (Iceberg)
INSERT INTO BUILDING_ATTRIBUTES (
    h3_index, building_type, avg_floors, has_elevator, has_delivery_box, updated_at
)
SELECT h3_index, building_type, avg_floors, has_elevator, has_delivery_box,
       CURRENT_TIMESTAMP()
FROM building_attributes;
```

> **注意**: 通常テーブルと Iceberg テーブルの名前が衝突する場合は、先に通常テーブルを別スキーマに移動するか、Iceberg テーブルを先に作成して直接 INSERT する。

### 4-3. Iceberg → Foreign Table (ft_*)

**この手順は別ドキュメントに詳細あり**: [iceberg-ft-deployment-guide.md](./iceberg-ft-deployment-guide.md)

概要:

1. **S3 パスの取得**:
```sql
SELECT PARSE_JSON(
  SYSTEM$GET_ICEBERG_TABLE_INFORMATION('LASTMILE_DB.ANALYTICS.KPI_DAILY')
):metadataLocation::STRING;
-- → managed/kpi_daily.<HASH>/ の部分を控える
```

2. **Parquet カラム順の取得**:
```sql
SELECT COLUMN_NAME, TYPE, ORDER_ID
FROM TABLE(
  INFER_SCHEMA(
    LOCATION => '@LASTMILE_DB.RAW.PG_LAKE_STAGE/managed/kpi_daily.<HASH>/data/',
    FILE_FORMAT => 'LASTMILE_DB.RAW.PARQUET_FF'
  )
) ORDER BY ORDER_ID;
```

3. **Foreign Table 作成** (Postgres 側):
```sql
CREATE FOREIGN TABLE ft_kpi_daily (
  -- ★ INFER_SCHEMA の ORDER_ID 順にカラムを並べる
  <col_0>  <type>,
  <col_1>  <type>,
  ...
  "metadata$rl_row_id" BIGINT,
  "metadata$rl_last_updated_sequence_number" BIGINT
) SERVER pg_lake
OPTIONS (path 's3://<BUCKET>/<PREFIX>/managed/kpi_daily.<HASH>/data/**/*.parquet');
```

4. **6 テーブル全てで繰り返す**: kpi_daily, delivery_history, risk_scores, absence_patterns, demand_forecast, building_attributes

> **重要**: カラム順は位置ベース (position-based)。Parquet の物理順序と Foreign Table 定義が一致しないとデータが壊れる。詳細は [iceberg-ft-deployment-guide.md](./iceberg-ft-deployment-guide.md) を参照。

---

## Phase 5: SPCS デプロイ

### 5-1. 環境ファイルの準備

`envs/<env_name>.env` を作成する:

```env
SNOWFLAKE_ACCOUNT=<YOUR_ACCOUNT>           # 例: SFSEAPAC-MYACCOUNT_AWS_US_WEST
SNOWFLAKE_USER=<YOUR_USER>
SNOWFLAKE_WAREHOUSE=APP_WH
SNOWFLAKE_DATABASE=LASTMILE_DB
SNOWFLAKE_SCHEMA=ANALYTICS
SNOWFLAKE_PAT=<YOUR_PAT>                  # Programmatic Access Token

POSTGRES_HOST=<YOUR_PG_HOST>               # Snowflake Postgres ホスト名
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_USER=snowflake_admin
POSTGRES_PASSWORD=<YOUR_PG_PASSWORD>

NEXT_PUBLIC_MAPBOX_TOKEN=<YOUR_MAPBOX_TOKEN>
NEXT_PUBLIC_MAP_CENTER_LAT=35.6495
NEXT_PUBLIC_MAP_CENTER_LNG=139.7914
NEXT_PUBLIC_MAP_ZOOM=13

OSRM_URL=http://localhost:5001

# SPCS deployment settings
SPCS_REGISTRY=<account-locator>.registry.snowflakecomputing.com
SPCS_IMAGE_REPO=lastmile_db/spcs/lastmile_repo
SPCS_COMPUTE_POOL=LASTMILE_POOL
SPCS_SERVICE=LASTMILE_DB.SPCS.LASTMILE_SVC
SPCS_EAI=LASTMILE_EAI
SPCS_PAT_SECRET=LASTMILE_DB.SPCS.SNOWFLAKE_PAT_SECRET
SPCS_PG_PASSWORD_SECRET=LASTMILE_DB.SPCS.POSTGRES_PASSWORD_SECRET
SPCS_MAPBOX_SECRET=LASTMILE_DB.SPCS.MAPBOX_TOKEN_SECRET
```

### 5-2. Programmatic Access Token (PAT) の作成

Snowsight UI > User Menu > **My Profile** > **Programmatic Access Tokens** から PAT を作成。

> SPCS 内の Node.js snowflake-sdk は SPCS OAuth トークン (`/snowflake/session/token`) を **サポートしない** (エラーコード 395092)。PAT を使うこと。

### 5-3. SPCS オブジェクトの作成

```sql
USE DATABASE LASTMILE_DB;
USE SCHEMA SPCS;

-- Compute Pool
CREATE COMPUTE POOL IF NOT EXISTS LASTMILE_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_S;

-- Image Repository
CREATE IMAGE REPOSITORY IF NOT EXISTS LASTMILE_REPO;

-- Secrets
CREATE SECRET IF NOT EXISTS SNOWFLAKE_PAT_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '<YOUR_PAT>';

CREATE SECRET IF NOT EXISTS POSTGRES_PASSWORD_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '<YOUR_PG_PASSWORD>';

CREATE SECRET IF NOT EXISTS MAPBOX_TOKEN_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '<YOUR_MAPBOX_TOKEN>';

-- Network Rule
CREATE OR REPLACE NETWORK RULE LASTMILE_EGRESS_RULE
  TYPE = HOST_PORT
  MODE = EGRESS
  VALUE_LIST = (
    'api.mapbox.com',
    'api.mapbox.com:443',
    'events.mapbox.com',
    'events.mapbox.com:443',
    '<YOUR_PG_HOST>:5432',
    '<YOUR_PG_HOST>'
  );

-- External Access Integration
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION LASTMILE_EAI
  ALLOWED_NETWORK_RULES = (LASTMILE_DB.SPCS.LASTMILE_EGRESS_RULE)
  ALLOWED_AUTHENTICATION_SECRETS = (
    LASTMILE_DB.SPCS.SNOWFLAKE_PAT_SECRET,
    LASTMILE_DB.SPCS.POSTGRES_PASSWORD_SECRET,
    LASTMILE_DB.SPCS.MAPBOX_TOKEN_SECRET
  )
  ENABLED = TRUE;
```

> **重要**: Network Rule に `<PG_HOST>:5432` を必ず含める。ポート番号なしだと SPCS → Postgres が `ETIMEDOUT` になる。

### 5-4. Docker イメージのビルド & プッシュ

```bash
cd lastmile-app

# 1. Docker ログイン (PAT をパスワードとして使用)
docker login <SPCS_REGISTRY> -u <SNOWFLAKE_USER>
# パスワード: PAT トークンを入力

# 2. lastmile-app ビルド
docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_MAPBOX_TOKEN=<YOUR_MAPBOX_TOKEN> \
  -t lastmile-app:latest .

# 3. タグ付け & プッシュ
docker tag lastmile-app:latest \
  <SPCS_REGISTRY>/<SPCS_IMAGE_REPO>/lastmile-app:latest
docker push \
  <SPCS_REGISTRY>/<SPCS_IMAGE_REPO>/lastmile-app:latest

# 4. OSRM イメージも同様にプッシュ
docker tag osrm-kanto:latest \
  <SPCS_REGISTRY>/<SPCS_IMAGE_REPO>/osrm-kanto:latest
docker push \
  <SPCS_REGISTRY>/<SPCS_IMAGE_REPO>/osrm-kanto:latest
```

> **注意**:
> - `--platform linux/amd64` は必須 (Apple Silicon 環境でも AMD64 でビルド)
> - Docker ログインのユーザー名は Snowflake ユーザー名 (例: `RYU`)、パスワードは PAT

### 5-5. service-spec.yaml の編集

`lastmile-app/service-spec.yaml` を環境に合わせて編集:

```yaml
spec:
  containers:
  - name: lastmile-app
    image: /lastmile_db/spcs/lastmile_repo/lastmile-app:latest
    env:
      HOSTNAME: "0.0.0.0"
      PORT: "8080"
      NODE_ENV: production
      SNOWFLAKE_ACCOUNT: <YOUR_ACCOUNT>         # ← 変更
      SNOWFLAKE_USER: <YOUR_USER>               # ← 変更
      SNOWFLAKE_WAREHOUSE: APP_WH
      SNOWFLAKE_DATABASE: LASTMILE_DB
      SNOWFLAKE_SCHEMA: ANALYTICS
      POSTGRES_HOST: <YOUR_PG_HOST>             # ← 変更
      POSTGRES_PORT: "5432"
      POSTGRES_DB: postgres
      POSTGRES_USER: snowflake_admin
      NEXT_PUBLIC_MAP_CENTER_LAT: "35.6495"
      NEXT_PUBLIC_MAP_CENTER_LNG: "139.7914"
      NEXT_PUBLIC_MAP_ZOOM: "13"
      OSRM_URL: "http://localhost:5000"
    secrets:
    - snowflakeSecret: LASTMILE_DB.SPCS.SNOWFLAKE_PAT_SECRET
      secretKeyRef: secret_string               # ← "password" ではなく "secret_string"
      envVarName: SNOWFLAKE_PAT
    - snowflakeSecret: LASTMILE_DB.SPCS.POSTGRES_PASSWORD_SECRET
      secretKeyRef: secret_string
      envVarName: POSTGRES_PASSWORD
    - snowflakeSecret: LASTMILE_DB.SPCS.MAPBOX_TOKEN_SECRET
      secretKeyRef: secret_string
      envVarName: NEXT_PUBLIC_MAPBOX_TOKEN
    resources:
      requests:
        memory: 1Gi
        cpu: 500m
      limits:
        memory: 2Gi
        cpu: 1000m
    readinessProbe:
      port: 8080
      path: /
  - name: osrm
    image: /lastmile_db/spcs/lastmile_repo/osrm-kanto:latest
    resources:
      requests:
        memory: 2Gi
        cpu: 1000m
      limits:
        memory: 4Gi
        cpu: 2000m
    readinessProbe:
      port: 5000
      path: /nearest/v1/driving/139.79,35.64
  endpoints:
  - name: lastmile-web
    port: 8080
    public: true
```

### 5-6. サービスの作成

```sql
CREATE SERVICE LASTMILE_DB.SPCS.LASTMILE_SVC
  IN COMPUTE POOL LASTMILE_POOL
  FROM SPECIFICATION $$
  <service-spec.yaml の内容をここに貼り付け>
  $$
  EXTERNAL_ACCESS_INTEGRATIONS = (LASTMILE_EAI)
  MIN_INSTANCES = 1
  MAX_INSTANCES = 1;
```

> spec.yaml ファイルを Stage にアップロードして `FROM @stage/spec.yaml` で参照する方法もある。

### 5-7. エンドポイント URL の確認

```sql
SHOW ENDPOINTS IN SERVICE LASTMILE_DB.SPCS.LASTMILE_SVC;
-- → ingress_url を控える
```

---

## Phase 6: 動作確認

### 6-1. SPCS サービス状態

```sql
SELECT * FROM TABLE(SYSTEM$GET_SERVICE_STATUS('LASTMILE_DB.SPCS.LASTMILE_SVC'));
-- 両コンテナが READY であること

-- ログ確認
CALL SYSTEM$GET_SERVICE_LOGS('LASTMILE_DB.SPCS.LASTMILE_SVC', '0', 'lastmile-app', 50);
```

### 6-2. Foreign Table の読み取り確認

Postgres に接続:

```sql
SELECT * FROM ft_kpi_daily LIMIT 5;
SELECT * FROM ft_risk_scores LIMIT 5;
SELECT * FROM ft_delivery_history LIMIT 5;
SELECT * FROM ft_absence_patterns LIMIT 5;
SELECT * FROM ft_demand_forecast LIMIT 5;
SELECT * FROM ft_building_attributes LIMIT 5;
```

### 6-3. アプリ画面の確認

ブラウザで SPCS エンドポイント URL にアクセスし、以下のページでデータが表示されることを確認:

| ページ | データソース | 確認ポイント |
|--------|-------------|-------------|
| レビュー > KPI | ft_kpi_daily | DEPOT-TOYOSU のデータが表示 |
| レビュー > 不在ヒートマップ | ft_absence_patterns | ヒートマップが描画 |
| レビュー > 需要予測 | ft_demand_forecast | グラフが表示 |
| プラン > リスクマップ | RISK_SCORES (Snowflake) | H3 セルにリスクスコア |
| プラン > ルート生成 | RISK_SCORES + ABSENCE_PATTERNS (Snowflake) | ルート最適化が動作 |

---

## トラブルシューティング

### SPCS → Postgres 接続エラー (ETIMEDOUT)

```
Error: connect ETIMEDOUT <PG_HOST>:5432
```

**原因**: Network Rule にポート番号が含まれていない。

**対処**:
```sql
ALTER NETWORK RULE LASTMILE_DB.SPCS.LASTMILE_EGRESS_RULE SET
  VALUE_LIST = (
    'api.mapbox.com',
    'events.mapbox.com',
    '<PG_HOST>:5432',
    '<PG_HOST>'
  );

ALTER SERVICE LASTMILE_DB.SPCS.LASTMILE_SVC SUSPEND;
ALTER SERVICE LASTMILE_DB.SPCS.LASTMILE_SVC RESUME;
```

### SPCS OAuth エラー (395092)

```
Client is unauthorized to use Snowpark Container Services OAuth token
```

**原因**: Node.js snowflake-sdk が SPCS OAuth をサポートしていない。

**対処**: PAT (Programmatic Access Token) を使用する。service-spec.yaml で `secretKeyRef: secret_string` を確認。

### Iceberg テーブルの DELETE 後にデータが倍返し

**原因**: DELETE は論理削除。古い Parquet ファイルが S3 に残り、pg_lake が全て読む。

**対処**: `DROP ICEBERG TABLE → CREATE ICEBERG TABLE → INSERT` で作り直す。ft_* も再作成が必要。

### Foreign Table のデータが壊れている (型エラー or 値ずれ)

**原因**: Parquet カラム順と Foreign Table 定義の順が一致していない。

**対処**: INFER_SCHEMA で Parquet の物理カラム順を再確認し、Foreign Table を再作成。詳細は [iceberg-ft-deployment-guide.md](./iceberg-ft-deployment-guide.md) 参照。

### V_WEATHER_FORECAST_LIVE が見つからない

```
SQL compilation error: Object 'LASTMILE_DB.ANALYTICS.V_WEATHER_FORECAST_LIVE' does not exist
```

**対処**: 天気予報ライブビューを作成する（未実装の場合はダミーデータで代替）:
```sql
CREATE OR REPLACE VIEW LASTMILE_DB.ANALYTICS.V_WEATHER_FORECAST_LIVE AS
SELECT * FROM LASTMILE_DB.ANALYTICS.WEATHER_FORECAST;
```

### pg_lake の S3 アクセスが 403 Forbidden

**対処**: Storage Integration を再アタッチする:
```sql
ALTER POSTGRES INSTANCE "<instance>" UNSET STORAGE_INTEGRATION;
ALTER POSTGRES INSTANCE "<instance>" SET STORAGE_INTEGRATION = PG_LAKE_INTEGRATION;
```

---

## ファイル一覧

| ファイル | 用途 |
|---------|------|
| `setup/01_snowflake_setup.sql` | Snowflake DB/スキーマ/通常テーブル作成 |
| `setup/02_postgres_schema.sql` | Postgres スキーマ (12 テーブル + H3 + pg_cron) |
| `setup/03_postgres_demo_data.sql` | Postgres デモデータ (SQL) |
| `setup/04_snowflake_demo_data.sql` | Snowflake 分析デモデータ |
| `setup/05_demo_data_road_enrichment.sql` | 道路工事・渋滞追加データ |
| `tools/seed_demo_data.py` | Postgres デモデータ (Python, より高品質) |
| `tools/gps_simulator.py` | GPS シミュレーター |
| `lastmile-app/Dockerfile` | Next.js アプリの Docker ビルド |
| `lastmile-app/service-spec.yaml` | SPCS サービス定義 |
| `envs/<env>.env` | 環境別設定ファイル |
| `docs/iceberg-ft-deployment-guide.md` | Iceberg → ft_* 詳細ガイド |
| `docs/pg_lake_guide.md` | pg_lake 拡張ガイド |

---

## デプロイチェックリスト

```
Phase 1: AWS
  □ S3 バケット作成 (Snowflake 同一リージョン)
  □ IAM ロール作成 (最大セッション 12h)
  □ Permission Policy アタッチ

Phase 2: Snowflake 基盤
  □ LASTMILE_DB + スキーマ (ANALYTICS, ML, RAW, SPCS) 作成
  □ APP_WH ウェアハウス作成
  □ Storage Integration (TYPE=POSTGRES_EXTERNAL_STORAGE) 作成
  □ Stage + File Format 作成
  □ External Volume 作成
  □ AWS Trust Policy に 3 エントリ追加 (Storage Int, Ext Volume, pg_lake)
  □ 通常テーブル作成 (01_snowflake_setup.sql)
  □ Iceberg テーブル 6 個作成 (v3, DEFAULT 句なし)

Phase 3: Snowflake Postgres
  □ Postgres インスタンス作成
  □ Storage Integration アタッチ
  □ エクステンション (H3, pg_cron, pg_lake) インストール
  □ pg_lake デフォルトロケーション設定
  □ スキーマ作成 (02_postgres_schema.sql)
  □ デモデータ投入 (03 + 05 or seed_demo_data.py)

Phase 4: データ投入 + Iceberg
  □ Snowflake 分析デモデータ投入 (04_snowflake_demo_data.sql)
  □ 通常テーブル → Iceberg テーブルへ INSERT
  □ SYSTEM$GET_ICEBERG_TABLE_INFORMATION で S3 ハッシュ取得 (× 6)
  □ INFER_SCHEMA で Parquet カラム順取得 (× 6)
  □ Foreign Table (ft_*) 作成 (× 6)
  □ ft_* SELECT で読み取り確認

Phase 5: SPCS
  □ PAT (Programmatic Access Token) 作成
  □ Compute Pool 作成
  □ Image Repository 作成
  □ Secrets 3 個作成 (PAT, PG_PASSWORD, MAPBOX)
  □ Network Rule 作成 (PG_HOST:5432 含む)
  □ External Access Integration 作成
  □ Docker ビルド (linux/amd64)
  □ Docker プッシュ (lastmile-app + osrm-kanto)
  □ service-spec.yaml 編集 (アカウント, ユーザー, PG ホスト)
  □ CREATE SERVICE 実行
  □ エンドポイント URL 確認

Phase 6: 動作確認
  □ SPCS サービスが READY
  □ ft_* から SELECT でデータ取得
  □ アプリ画面で各ページのデータ表示確認
```

---

## 所要時間の目安

| フェーズ | 初回 | 2 回目以降 |
|---------|------|-----------|
| Phase 1 (AWS) | 30 分 | 10 分 |
| Phase 2 (Snowflake) | 30 分 | 15 分 |
| Phase 3 (Postgres) | 30 分 | 15 分 |
| Phase 4 (データ + Iceberg) | 60 分 | 30 分 |
| Phase 5 (SPCS) | 60 分 | 20 分 |
| Phase 6 (確認) | 30 分 | 10 分 |
| **合計** | **約 4 時間** | **約 1.5 時間** |

> Phase 4 の Iceberg → ft_* が最も時間がかかる。INFER_SCHEMA の結果をもとに Foreign Table を正確に定義する作業は手動で行う必要がある。
