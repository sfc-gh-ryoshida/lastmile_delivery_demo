-- ============================================================
-- Snowflake 本体セットアップ (分析・ML 基盤)
-- 実行先: Snowflake 本体 (ACCOUNTADMIN or 適切なロール)
-- ============================================================

USE ROLE ACCOUNTADMIN;

-- データベース・スキーマ
CREATE DATABASE IF NOT EXISTS LASTMILE_DB;
CREATE SCHEMA IF NOT EXISTS LASTMILE_DB.ANALYTICS;
CREATE SCHEMA IF NOT EXISTS LASTMILE_DB.ML;
CREATE SCHEMA IF NOT EXISTS LASTMILE_DB.RAW;

USE DATABASE LASTMILE_DB;

-- ============================================================
-- Iceberg Tables (Snowflake 本体 ↔ Postgres 共有)
-- ============================================================

USE SCHEMA ANALYTICS;

CREATE OR REPLACE TABLE delivery_history (
    delivery_id       STRING,
    package_id        STRING,
    driver_id         STRING,
    depot_id          STRING,
    date              DATE,
    status            STRING,
    completed_at      TIMESTAMP_NTZ,
    is_absent         BOOLEAN,
    attempt_count     INT,
    lat               DOUBLE,
    lng               DOUBLE,
    h3_index_r9       STRING,
    h3_index_r8       STRING,
    delivery_time_sec INT,
    loaded_at         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY (date);

CREATE OR REPLACE TABLE risk_scores (
    h3_index      STRING,
    date          DATE,
    hour          INT,
    risk_score    DOUBLE,
    risk_factors  VARIANT,
    created_at    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY (date);

CREATE OR REPLACE TABLE absence_patterns (
    h3_index      STRING,
    day_of_week   INT,
    hour          INT,
    absence_rate  DOUBLE,
    sample_count  INT,
    updated_at    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE anomaly_alerts (
    alert_id        STRING,
    driver_id       STRING,
    date            DATE,
    hour            INT,
    anomaly_score   DOUBLE,
    expected_pace   DOUBLE,
    actual_pace     DOUBLE,
    created_at      TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE demand_forecast (
    depot_id              STRING,
    date                  DATE,
    forecast_volume       INT,
    confidence_lower      INT,
    confidence_upper      INT,
    created_at            TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE kpi_daily (
    depot_id           STRING,
    date               DATE,
    total_packages     INT,
    delivered          INT,
    absent             INT,
    completion_rate    DOUBLE,
    absence_rate       DOUBLE,
    ontime_rate        DOUBLE,
    avg_delivery_time  DOUBLE,
    created_at         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE weather_forecast (
    h3_index       STRING,
    datetime       TIMESTAMP_NTZ,
    precipitation  DOUBLE,
    wind_speed     DOUBLE,
    temperature    DOUBLE,
    weather_code   STRING
);

CREATE OR REPLACE TABLE building_attributes (
    h3_index         STRING,
    building_type    STRING,
    has_elevator     BOOLEAN,
    has_delivery_box BOOLEAN,
    avg_floors       INT
);

-- ============================================================
-- RAW テーブル (Snowpipe Streaming 受信先)
-- ============================================================

USE SCHEMA RAW;

CREATE OR REPLACE TABLE gps_raw (
    driver_id   STRING,
    lat         DOUBLE,
    lng         DOUBLE,
    speed       DOUBLE,
    heading     DOUBLE,
    timestamp   TIMESTAMP_NTZ,
    ingested_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE status_raw (
    package_id  STRING,
    driver_id   STRING,
    status      STRING,
    timestamp   TIMESTAMP_NTZ,
    lat         DOUBLE,
    lng         DOUBLE,
    ingested_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
