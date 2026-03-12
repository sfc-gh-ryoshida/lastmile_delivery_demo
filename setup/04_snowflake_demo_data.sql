-- ============================================================
-- Snowflake 本体 デモデータ生成 (Iceberg テーブル)
-- 実行先: Snowflake 本体
-- Postgres の実績データを元に分析用データを生成
-- ============================================================

USE DATABASE LASTMILE_DB;
USE SCHEMA ANALYTICS;

-- ============================================================
-- 1. delivery_history (30日分の配送実績)
-- ============================================================

INSERT INTO delivery_history (
    delivery_id, package_id, driver_id, depot_id, date,
    status, completed_at, is_absent, attempt_count,
    lat, lng, h3_index_r9, h3_index_r8, delivery_time_sec
)
SELECT
    'DH-' || TO_CHAR(d.value::DATE, 'YYYYMMDD') || '-' || LPAD(n.value::STRING, 4, '0'),
    'PKG-' || TO_CHAR(d.value::DATE, 'YYYYMMDD') || '-' || LPAD(n.value::STRING, 4, '0'),
    'DRV-' || LPAD(((MOD(n.value - 1, 12)) + 1)::STRING, 3, '0'),
    'DEPOT-TOYOSU',
    d.value::DATE,
    CASE
        WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.85 THEN 'delivered'
        WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.97 THEN 'absent'
        ELSE 'failed'
    END,
    CASE
        WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.97
        THEN DATEADD('hour', 8 + FLOOR(UNIFORM(0::FLOAT, 10::FLOAT, RANDOM()))::INT, d.value::TIMESTAMP_NTZ)
        ELSE NULL
    END,
    UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) BETWEEN 0.85 AND 0.97,
    CASE WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.85 THEN 1 ELSE CEIL(UNIFORM(1::FLOAT, 3::FLOAT, RANDOM()))::INT END,
    35.630 + UNIFORM(0::FLOAT, 0.030::FLOAT, RANDOM()),
    139.780 + UNIFORM(0::FLOAT, 0.045::FLOAT, RANDOM()),
    H3_LATLNG_TO_CELL_STRING(
        35.630 + UNIFORM(0::FLOAT, 0.030::FLOAT, RANDOM()),
        139.780 + UNIFORM(0::FLOAT, 0.045::FLOAT, RANDOM()),
        9
    ),
    H3_LATLNG_TO_CELL_STRING(
        35.630 + UNIFORM(0::FLOAT, 0.030::FLOAT, RANDOM()),
        139.780 + UNIFORM(0::FLOAT, 0.045::FLOAT, RANDOM()),
        8
    ),
    FLOOR(UNIFORM(60::FLOAT, 600::FLOAT, RANDOM()))::INT
FROM
    TABLE(FLATTEN(INPUT => ARRAY_GENERATE_RANGE(0, 30))) d,
    TABLE(FLATTEN(INPUT => ARRAY_GENERATE_RANGE(1, 488))) n
WHERE d.value::INT >= 0;

-- 日付を実際の日付にマッピング
UPDATE delivery_history
SET date = DATEADD('day', -30 + DATEDIFF('day',
    (SELECT MIN(date) FROM delivery_history), date), CURRENT_DATE);

-- ============================================================
-- 2. risk_scores (明日分 + 過去7日分)
-- ============================================================

INSERT INTO risk_scores (h3_index, date, hour, risk_score, risk_factors)
WITH h3_cells AS (
    SELECT DISTINCT h3_index_r9 AS h3_index FROM delivery_history
    WHERE h3_index_r9 IS NOT NULL
    LIMIT 200
),
dates AS (
    SELECT DATEADD('day', seq4(), CURRENT_DATE - 6)::DATE AS d
    FROM TABLE(GENERATOR(ROWCOUNT => 8))
),
hours AS (
    SELECT seq4() + 8 AS h FROM TABLE(GENERATOR(ROWCOUNT => 11))
)
SELECT
    c.h3_index,
    d.d,
    h.h,
    ROUND(
        CASE
            WHEN d.d = CURRENT_DATE + 1 AND h.h BETWEEN 14 AND 16
                AND c.h3_index IN (SELECT h3_index FROM h3_cells LIMIT 30)
            THEN UNIFORM(0.7::FLOAT, 1.0::FLOAT, RANDOM())
            WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.15
            THEN UNIFORM(0.6::FLOAT, 0.9::FLOAT, RANDOM())
            ELSE UNIFORM(0.05::FLOAT, 0.55::FLOAT, RANDOM())
        END, 3
    ),
    OBJECT_CONSTRUCT(
        'absence_risk', ROUND(UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()), 2),
        'weather_risk', ROUND(UNIFORM(0::FLOAT, 0.5::FLOAT, RANDOM()), 2),
        'traffic_risk', ROUND(UNIFORM(0::FLOAT, 0.8::FLOAT, RANDOM()), 2),
        'construction_risk', CASE WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.1 THEN ROUND(UNIFORM(0.5::FLOAT, 1::FLOAT, RANDOM()), 2) ELSE 0 END
    )
FROM h3_cells c
CROSS JOIN dates d
CROSS JOIN hours h;

-- ============================================================
-- 3. absence_patterns (曜日×時間帯×H3 セル)
-- ============================================================

INSERT INTO absence_patterns (h3_index, day_of_week, hour, absence_rate, sample_count)
SELECT DISTINCT
    h3_index_r8,
    DAYOFWEEK(date),
    HOUR(completed_at),
    ROUND(
        SUM(CASE WHEN is_absent THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 3
    ),
    COUNT(*)
FROM delivery_history
WHERE completed_at IS NOT NULL
GROUP BY h3_index_r8, DAYOFWEEK(date), HOUR(completed_at)
HAVING COUNT(*) >= 5;

-- ============================================================
-- 4. anomaly_alerts (デモ当日: 鈴木ドライバーに異常検知)
-- ============================================================

INSERT INTO anomaly_alerts (alert_id, driver_id, date, hour, anomaly_score, expected_pace, actual_pace)
VALUES
    ('ALERT-001', 'DRV-003', CURRENT_DATE, 11, 0.92, 4.2, 8.7),
    ('ALERT-002', 'DRV-003', CURRENT_DATE, 12, 0.88, 4.5, 9.1),
    ('ALERT-003', 'DRV-006', CURRENT_DATE, 14, 0.75, 5.0, 7.8);

-- ============================================================
-- 5. kpi_daily (30日分)
-- ============================================================

INSERT INTO kpi_daily (depot_id, date, total_packages, delivered, absent,
    completion_rate, absence_rate, ontime_rate, avg_delivery_time)
SELECT
    'DEPOT-TOYOSU',
    date,
    COUNT(*),
    SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END),
    SUM(CASE WHEN is_absent THEN 1 ELSE 0 END),
    ROUND(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 3),
    ROUND(SUM(CASE WHEN is_absent THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 3),
    ROUND(UNIFORM(0.93::FLOAT, 0.99::FLOAT, RANDOM()), 3),
    ROUND(AVG(delivery_time_sec) / 60.0, 1)
FROM delivery_history
GROUP BY date;

-- ============================================================
-- 6. weather_forecast (明日分 H3 Res7)
-- ============================================================

INSERT INTO weather_forecast (h3_index, datetime, precipitation, wind_speed, temperature, weather_code)
WITH area_cells AS (
    SELECT DISTINCT H3_LATLNG_TO_CELL_STRING(
        35.630 + (r * 0.005),
        139.780 + (c * 0.008),
        7
    ) AS h3_index
    FROM TABLE(GENERATOR(ROWCOUNT => 7)) r_gen,
         TABLE(GENERATOR(ROWCOUNT => 7)) c_gen
    CROSS JOIN LATERAL (SELECT seq4() AS r) rr
    CROSS JOIN LATERAL (SELECT seq4() AS c) cc
),
hours AS (
    SELECT seq4() AS h FROM TABLE(GENERATOR(ROWCOUNT => 24))
)
SELECT
    c.h3_index,
    DATEADD('hour', h.h, (CURRENT_DATE + 1)::TIMESTAMP_NTZ),
    CASE
        WHEN h.h BETWEEN 13 AND 20 THEN ROUND(UNIFORM(2::FLOAT, 15::FLOAT, RANDOM()), 1)
        ELSE ROUND(UNIFORM(0::FLOAT, 2::FLOAT, RANDOM()), 1)
    END,
    ROUND(UNIFORM(1::FLOAT, 8::FLOAT, RANDOM()), 1),
    ROUND(UNIFORM(8::FLOAT, 16::FLOAT, RANDOM()), 1),
    CASE
        WHEN h.h BETWEEN 13 AND 20 THEN 'rain'
        WHEN h.h BETWEEN 11 AND 13 THEN 'cloudy'
        ELSE 'clear'
    END
FROM area_cells c
CROSS JOIN hours h;

-- ============================================================
-- 7. building_attributes
-- ============================================================

INSERT INTO building_attributes (h3_index, building_type, has_elevator, has_delivery_box, avg_floors)
SELECT DISTINCT
    h3_index_r9,
    CASE
        WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.45 THEN 'apartment'
        WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.70 THEN 'house'
        WHEN UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.90 THEN 'office'
        ELSE 'commercial'
    END,
    UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.6,
    UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.3,
    FLOOR(UNIFORM(1::FLOAT, 15::FLOAT, RANDOM()))::INT
FROM delivery_history
WHERE h3_index_r9 IS NOT NULL;

-- ============================================================
-- 8. demand_forecast (翌週分)
-- ============================================================

INSERT INTO demand_forecast (depot_id, date, forecast_volume, confidence_lower, confidence_upper)
SELECT
    'DEPOT-TOYOSU',
    DATEADD('day', seq4() + 1, CURRENT_DATE)::DATE,
    FLOOR(UNIFORM(420::FLOAT, 550::FLOAT, RANDOM()))::INT,
    FLOOR(UNIFORM(380::FLOAT, 420::FLOAT, RANDOM()))::INT,
    FLOOR(UNIFORM(550::FLOAT, 620::FLOAT, RANDOM()))::INT
FROM TABLE(GENERATOR(ROWCOUNT => 7));
