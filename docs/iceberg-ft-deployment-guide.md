# Snowflake Iceberg Table → pg_lake Foreign Table デプロイガイド

Snowflake Managed Iceberg Table (v3) で書き出した S3 Parquet を、
Postgres pg_lake Foreign Table から読み取る構成の構築手順と注意事項。

**対象読者**: 別アカウント・別環境へのデプロイ担当者

---

## アーキテクチャ

```
┌──────────────────────────────────────────────────────────┐
│ Snowflake                                                │
│  ┌─────────────────────┐                                │
│  │ Iceberg Table (v3)  │                                │
│  │  CATALOG='SNOWFLAKE' │                                │
│  │  EXTERNAL_VOLUME     │                                │
│  └────────┬────────────┘                                │
│           │ 自動書き出し                                   │
│           ▼                                              │
│  ┌─────────────────────────┐                            │
│  │ S3 (Parquet + metadata)  │                            │
│  │ s3://bucket/prefix/      │                            │
│  │   managed/<table>.<hash>/│                            │
│  │     data/*.parquet       │                            │
│  │     metadata/*.json      │                            │
│  └────────┬────────────────┘                            │
│           │ pg_lake で直接読み取り                          │
│           ▼                                              │
│  ┌─────────────────────────┐                            │
│  │ Snowflake Postgres      │                            │
│  │  Foreign Table (ft_*)    │─── アプリから SELECT         │
│  │  SERVER pg_lake          │                            │
│  └─────────────────────────┘                            │
└──────────────────────────────────────────────────────────┘
```

**データフロー**: Snowflake INSERT → Iceberg Parquet (S3) → pg_lake Foreign Table → アプリ

> Snowflake ↔ Postgres 間の ETL/同期処理は **不要**。Foreign Table が S3 Parquet を直接読む。

---

## 前提条件

| 項目 | 要件 |
|------|------|
| Snowflake Edition | Enterprise 以上 (Iceberg v3) |
| Postgres | Snowflake Postgres インスタンス (pg_lake 拡張あり) |
| S3 バケット | Snowflake と同一リージョン |
| IAM | Storage Integration + External Volume 用の Trust Policy 設定済み |
| pg_lake 拡張 | `CREATE EXTENSION pg_lake CASCADE` 実行済み |

---

## 手順

### Step 1: Snowflake 側のインフラ構築

#### 1-1. External Volume の作成

```sql
CREATE OR REPLACE EXTERNAL VOLUME pg_lake_volume
  STORAGE_LOCATIONS = (
    (
      NAME = 'pg-lake-<env>'
      STORAGE_BASE_URL = 's3://<BUCKET>/<PREFIX>/'
      STORAGE_PROVIDER = 'S3'
      STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::<AWS_ACCOUNT>:role/<ROLE_NAME>'
    )
  );
```

External Volume は Iceberg テーブルが Parquet を書き出す先を定義する。

> **注意**: `DESC EXTERNAL VOLUME pg_lake_volume` で得られる `STORAGE_AWS_IAM_USER_ARN` と
> `STORAGE_AWS_EXTERNAL_ID` を **AWS Trust Policy に追加** すること。
> Storage Integration の IAM ユーザーとは **別の ExternalId** が発行される。

#### 1-2. Stage の作成 (INFER_SCHEMA 用)

```sql
CREATE OR REPLACE STAGE <DB>.RAW.PG_LAKE_STAGE
  URL = 's3://<BUCKET>/<PREFIX>/'
  STORAGE_INTEGRATION = <STORAGE_INTEGRATION_NAME>
  FILE_FORMAT = (TYPE = PARQUET);

CREATE OR REPLACE FILE FORMAT <DB>.RAW.PARQUET_FF TYPE = PARQUET;
```

Stage は Iceberg テーブルの Parquet カラム順を調べるために必要。

#### 1-3. Iceberg テーブルの作成

```sql
CREATE ICEBERG TABLE <DB>.ANALYTICS.<TABLE_NAME> (
  col1 STRING,
  col2 DATE,
  col3 FLOAT,
  ...
)
  CATALOG = 'SNOWFLAKE'
  EXTERNAL_VOLUME = 'pg_lake_volume'
  BASE_LOCATION = 'managed/<table_name>/'
  ICEBERG_VERSION = 3;
```

**制約と注意事項**:

| 制約 | 詳細 |
|------|------|
| `DEFAULT CURRENT_TIMESTAMP()` 不可 | Iceberg テーブルの TIMESTAMP_NTZ カラムに DEFAULT は使えない。INSERT 時に明示的に値を渡す |
| v3 必須 | `ICEBERG_VERSION = 3` を明記。デフォルトは v2 |
| BASE_LOCATION の一意性 | テーブルを DROP → CREATE し直すと `<table_name>.<HASH>` のハッシュ部分が変わる |

#### 1-4. デモデータの投入

```sql
INSERT INTO <DB>.ANALYTICS.<TABLE_NAME>
SELECT ... FROM ...;
```

### Step 2: S3 パスとカラム順の取得

これが **最も重要なステップ**。pg_lake Foreign Table は Parquet カラムを **位置 (position)** で読み取る。

#### 2-1. S3 パス (ハッシュ) の取得

```sql
SELECT PARSE_JSON(
  SYSTEM$GET_ICEBERG_TABLE_INFORMATION('<DB>.ANALYTICS.<TABLE>')
):metadataLocation::STRING;
-- 結果例: s3://bucket/prefix/managed/kpi_daily.BLepJ51y/metadata/00001-xxx.json
--                                     ^^^^^^^^^^^^^^^^^^^
--                                     この部分がテーブル固有パス
```

#### 2-2. Parquet カラム順の取得

```sql
SELECT COLUMN_NAME, TYPE, ORDER_ID
FROM TABLE(
  INFER_SCHEMA(
    LOCATION => '@<DB>.RAW.PG_LAKE_STAGE/managed/<table>.<hash>/data/',
    FILE_FORMAT => '<DB>.RAW.PARQUET_FF'
  )
)
ORDER BY ORDER_ID;
```

**出力例 (RISK_SCORES)**:
```
ORDER_ID | COLUMN_NAME  | TYPE
---------|--------------|------------------
0        | RISK_SCORE   | REAL
1        | WEATHER_RISK | REAL
2        | ABSENCE_RISK | REAL
3        | BUILDING_RISK| REAL
4        | POI_RISK     | REAL
5        | H3_INDEX     | TEXT
6        | CREATED_AT   | NUMBER(38,0)  ← 実際は TIMESTAMP
7        | DATE         | DATE
8        | HOUR         | NUMBER(38,0)
9        | METADATA$RL_ROW_ID              | NUMBER(38,0)
10       | METADATA$RL_LAST_UPDATED_SEQ... | NUMBER(38,0)
```

### Step 3: Postgres Foreign Table の作成

#### 3-1. カラム順を完全に一致させる

```sql
CREATE FOREIGN TABLE ft_risk_scores (
  -- ORDER_ID 0〜8: データカラム（Parquet 順に並べる）
  risk_score       REAL,
  weather_risk     REAL,
  absence_risk     REAL,
  building_risk    REAL,
  poi_risk         REAL,
  h3_index         TEXT,
  created_at       TIMESTAMP,        -- ★ NUMBER(38,0) ではなく TIMESTAMP
  date             DATE,
  hour             NUMERIC,
  -- ORDER_ID 9〜10: メタデータカラム（必須）
  "metadata$rl_row_id" BIGINT,
  "metadata$rl_last_updated_sequence_number" BIGINT
) SERVER pg_lake
OPTIONS (
  path 's3://<BUCKET>/<PREFIX>/managed/risk_scores.<HASH>/data/**/*.parquet'
);
```

#### 3-2. 確認

```sql
SELECT * FROM ft_risk_scores LIMIT 5;
```

エラーが出る場合は **カラム順が間違っている**。後述のトラブルシューティング参照。

---

## 致命的な落とし穴 (Critical Pitfalls)

### 1. pg_lake は Parquet カラムを位置 (position) で読む

```
Foreign Table 定義:  col_a | col_b | col_c
Parquet 物理順序:    col_b | col_c | col_a   ← CREATE TABLE の順序と異なる！
```

**結果**: `col_a` に `col_b` のデータが入る。型が一致すればエラーにならず、
サイレントに間違ったデータが返る。

**対策**: **必ず INFER_SCHEMA で Parquet の物理カラム順を確認**してから Foreign Table を定義する。

### 2. Parquet カラム順は DROP/CREATE のたびに変わる

同じ CREATE TABLE 文でも、テーブルを DROP → CREATE するたびに
Snowflake が Parquet に書き出すカラム順序が **ランダムに変わる**。

```
1回目の CREATE: DATE, DEPOT_ID, TOTAL_PACKAGES, ...
2回目の CREATE: TOTAL_PACKAGES, DATE, ABSENT, ...  ← 順序が変わる！
```

**対策**: テーブルを再作成するたびに、Step 2 (INFER_SCHEMA) → Step 3 (ft_* 再作成) を
**毎回やり直す**。

### 3. DELETE は論理削除 — ゴーストデータが残る

Iceberg テーブルで DELETE を実行すると、**古い Parquet ファイルは S3 に残る**。
pg_lake は `data/**/*.parquet` glob で **全ファイルを読む** ため、
削除済み行も含めて返してしまう。

```
-- NG: DELETE + INSERT → 旧データと新データの両方が返る
DELETE FROM analytics.kpi_daily;
INSERT INTO analytics.kpi_daily SELECT ...;
-- ft_kpi_daily は旧データ + 新データ = 倍のレコードを返す

-- OK: DROP + CREATE → クリーンな状態で新データのみ
DROP ICEBERG TABLE analytics.kpi_daily;
CREATE ICEBERG TABLE analytics.kpi_daily (...) ...;
INSERT INTO analytics.kpi_daily SELECT ...;
-- ft_kpi_daily は新データのみ返す（ただし ft_* の再作成が必要）
```

**対策**: データを入れ替える場合は **DROP → CREATE → INSERT**。DELETE は使わない。

### 4. TIMESTAMP_NTZ の型マッピング

INFER_SCHEMA は TIMESTAMP_NTZ を `NUMBER(38,0)` と報告するが、
pg_lake は実際の Parquet タイムスタンプとして正しく読む。

```
INFER_SCHEMA の表示: CREATED_AT  NUMBER(38,0)
Foreign Table 定義:  created_at  TIMESTAMP     ← これが正解
                     created_at  BIGINT        ← NG: タイムスタンプ文字列のパースエラー
```

### 5. メタデータカラムは必須

Iceberg v3 テーブルの Parquet には以下の 2 カラムが自動追加される：

- `metadata$rl_row_id`
- `metadata$rl_last_updated_sequence_number`

Foreign Table 定義に **含めないと位置がずれる**。

```sql
"metadata$rl_row_id" BIGINT,
"metadata$rl_last_updated_sequence_number" BIGINT
```

### 6. BASE_LOCATION の再利用不可

DROP 後に同じ BASE_LOCATION で CREATE すると、古い Parquet が残っているため
ゴーストデータが読まれる。

```sql
-- 1回目
CREATE ICEBERG TABLE t (...) BASE_LOCATION='managed/kpi_daily/' ...;
DROP ICEBERG TABLE t;

-- 2回目: 同じ BASE_LOCATION を使うと古いデータが残る
CREATE ICEBERG TABLE t (...) BASE_LOCATION='managed/kpi_daily/' ...;
-- → pg_lake が古い Parquet も読む可能性あり

-- 安全策: サフィックスを変える
CREATE ICEBERG TABLE t (...) BASE_LOCATION='managed/kpi_daily2/' ...;
```

---

## pg_lake サーバーの使い分け

| サーバー | 方向 | 用途 | OPTIONS |
|----------|------|------|---------|
| `pg_lake` | **S3 → Postgres (読み取り)** | Foreign Table で S3 Parquet を読む | `path` |
| `pg_lake_iceberg` | **Postgres → S3 (書き込み)** | Postgres から Iceberg テーブルを作成 | `location` (空である必要あり) |

```sql
-- S3 Parquet を読む（今回の用途）
CREATE FOREIGN TABLE ft_xxx (...) SERVER pg_lake
  OPTIONS (path 's3://bucket/prefix/data/**/*.parquet');

-- Postgres から Iceberg を作る（逆方向）
CREATE TABLE xxx (...) USING pg_lake_iceberg;
```

> `pg_lake_iceberg` に `path` オプションは使えない。逆に `pg_lake` に `location` は使えない。

---

## 完全手順チェックリスト（別環境デプロイ時）

```
□ 1. AWS IAM — External Volume 用の Trust Policy に新アカウントの ARN/ExternalId を追加
□ 2. Snowflake — External Volume 作成
□ 3. Snowflake — Stage 作成 (INFER_SCHEMA 用)
□ 4. Snowflake — Iceberg Table 作成 (v3, DEFAULT 句なし)
□ 5. Snowflake — デモデータ INSERT
□ 6. SYSTEM$GET_ICEBERG_TABLE_INFORMATION → S3 ハッシュ取得
□ 7. INFER_SCHEMA → Parquet カラム順取得
□ 8. Postgres — Foreign Table 作成 (カラム順 = Parquet 物理順)
□ 9. Postgres — SELECT で読み取り確認
□ 10. SPCS — Network Rule に Postgres ホスト:5432 を追加
□ 11. SPCS — サービス再起動
□ 12. アプリ — API エンドポイントからデータ表示確認
```

---

## SPCS から Postgres への接続

SPCS コンテナから Snowflake Postgres に接続するには、
**Network Rule にポート番号を明示** する必要がある。

```sql
ALTER NETWORK RULE <DB>.SPCS.<RULE_NAME> SET
  VALUE_LIST = (
    'api.mapbox.com',
    -- ... 他のホスト ...
    '<PG_HOST>:5432',    -- ★ :5432 を明示
    '<PG_HOST>'          -- ポートなしも残す
  );
```

> `:5432` がないと SPCS → Postgres 接続が `ETIMEDOUT` になる。

---

## テーブル定義リファレンス

### Iceberg テーブル (Snowflake)

```sql
-- KPI_DAILY
CREATE ICEBERG TABLE ANALYTICS.KPI_DAILY (
  date DATE, depot_id STRING,
  total_packages INT, delivered INT, absent INT,
  completion_rate FLOAT, absence_rate FLOAT,
  ontime_rate FLOAT, avg_delivery_time FLOAT,
  created_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='pg_lake_volume'
  BASE_LOCATION='managed/kpi_daily/' ICEBERG_VERSION=3;

-- RISK_SCORES
CREATE ICEBERG TABLE ANALYTICS.RISK_SCORES (
  h3_index STRING, date DATE, hour INT,
  risk_score FLOAT, weather_risk FLOAT, absence_risk FLOAT,
  building_risk FLOAT, poi_risk FLOAT,
  created_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='pg_lake_volume'
  BASE_LOCATION='managed/risk_scores/' ICEBERG_VERSION=3;

-- ABSENCE_PATTERNS
CREATE ICEBERG TABLE ANALYTICS.ABSENCE_PATTERNS (
  h3_index STRING, day_of_week INT, hour INT,
  absence_rate FLOAT, sample_count INT,
  updated_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='pg_lake_volume'
  BASE_LOCATION='managed/absence_patterns/' ICEBERG_VERSION=3;

-- DEMAND_FORECAST
CREATE ICEBERG TABLE ANALYTICS.DEMAND_FORECAST (
  date DATE, depot_id STRING,
  forecast_volume FLOAT, confidence_lower FLOAT, confidence_upper FLOAT,
  created_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='pg_lake_volume'
  BASE_LOCATION='managed/demand_forecast/' ICEBERG_VERSION=3;

-- DELIVERY_HISTORY
CREATE ICEBERG TABLE ANALYTICS.DELIVERY_HISTORY (
  delivery_id STRING, package_id STRING, driver_id STRING,
  depot_id STRING, date DATE, status STRING,
  is_absent BOOLEAN, attempt_count INT,
  completed_at TIMESTAMP_NTZ, loaded_at TIMESTAMP_NTZ,
  delivery_time_sec INT, h3_index_r9 STRING
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='pg_lake_volume'
  BASE_LOCATION='managed/delivery_history/' ICEBERG_VERSION=3;

-- BUILDING_ATTRIBUTES
CREATE ICEBERG TABLE ANALYTICS.BUILDING_ATTRIBUTES (
  h3_index STRING, building_type STRING, avg_floors INT,
  has_elevator BOOLEAN, has_delivery_box BOOLEAN,
  updated_at TIMESTAMP_NTZ
) CATALOG='SNOWFLAKE' EXTERNAL_VOLUME='pg_lake_volume'
  BASE_LOCATION='managed/building_attributes/' ICEBERG_VERSION=3;
```

### Foreign Table 作成テンプレート (Postgres)

> ⚠️ カラム順は **毎回 INFER_SCHEMA で確認** すること。以下は一例であり、
> テーブルを再作成するとカラム順が変わる。

```sql
-- テンプレート
CREATE FOREIGN TABLE ft_<name> (
  <parquet_col_0>  <pg_type>,  -- INFER_SCHEMA ORDER_ID = 0
  <parquet_col_1>  <pg_type>,  -- INFER_SCHEMA ORDER_ID = 1
  ...
  <parquet_col_N>  <pg_type>,  -- INFER_SCHEMA ORDER_ID = N
  "metadata$rl_row_id" BIGINT,
  "metadata$rl_last_updated_sequence_number" BIGINT
) SERVER pg_lake
OPTIONS (path 's3://<BUCKET>/<PREFIX>/managed/<table>.<HASH>/data/**/*.parquet');
```

**型マッピング**:

| INFER_SCHEMA TYPE | Postgres 型 | 備考 |
|-------------------|-------------|------|
| TEXT | TEXT | |
| DATE | DATE | |
| REAL | REAL | |
| NUMBER(38,0) — INT カラム | NUMERIC | |
| NUMBER(38,0) — TIMESTAMP_NTZ | **TIMESTAMP** | INFER_SCHEMA は NUMBER と報告するが実際は TIMESTAMP |
| BOOLEAN | BOOLEAN | |
| NUMBER(38,0) — metadata$ | BIGINT | |

---

## トラブルシューティング

### エラー: `date/time field value out of range`

**原因**: カラム順がずれて、NUMERIC 値が DATE カラムに入っている。

**対処**: INFER_SCHEMA を再実行し、Foreign Table のカラム順を修正。

### エラー: `invalid input syntax for type integer: "2026-03-13 03:47:00"`

**原因**: TIMESTAMP 値が INTEGER カラムに入っている（カラム順ずれ）。

**対処**: 同上。

### エラー: `invalid input syntax for type bigint: "2026-03-13 04:03:54.397"`

**原因**: TIMESTAMP_NTZ カラムの型を BIGINT にしている。

**対処**: TIMESTAMP に変更。

### データが倍返しされる (行数が想定の 2 倍)

**原因**: DELETE → INSERT したため、古い Parquet ファイルが残っている。

**対処**: DROP TABLE → CREATE TABLE → INSERT で作り直す。ft_* も新しいパスで再作成。

### SPCS から Postgres に接続できない (ETIMEDOUT)

**原因**: Network Rule にポート番号が含まれていない。

**対処**: `<PG_HOST>:5432` を VALUE_LIST に追加。

### `invalid option "path"` (pg_lake_iceberg)

**原因**: `pg_lake_iceberg` サーバーに `path` オプションは使えない。

**対処**: 読み取り用には `pg_lake` サーバーを使う。

### `location is not empty`

**原因**: `pg_lake_iceberg` は書き込み専用で、空の S3 ロケーションが必要。

**対処**: Snowflake Iceberg の読み取りには `pg_lake` サーバー + `path` オプションを使う。

---

## デプロイ実績

### 適用先 環境 (2026-03-13)

| 項目 | 値 |
|------|-----|
| Account | |
| S3 | s3://|
| External Volume | PG_LAKE_VOLUME |
| Stage | LASTMILE_DB.RAW.PG_LAKE_STAGE |
| Iceberg Tables | 6 テーブル (ANALYTICS スキーマ, v3) |
| Foreign Tables | 6 テーブル (ft_*) |
| 所要時間 | 約 2 時間 (トラブルシュート含む) |

**遭遇した問題と解決**:

1. Iceberg DEFAULT CURRENT_TIMESTAMP() → DEFAULT 句を除去
2. pg_lake_iceberg で path 不可 → pg_lake サーバーに変更
3. カラム順ずれ (3 回発生) → INFER_SCHEMA で都度確認
4. DELETE によるゴースト行 → DROP/CREATE に方針変更
5. SPCS ETIMEDOUT → Network Rule に :5432 追加
6. BASE_LOCATION 再利用 → サフィックス変更 (kpi_daily → kpi_daily2)

