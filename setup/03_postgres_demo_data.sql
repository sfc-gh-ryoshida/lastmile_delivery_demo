-- ============================================================
-- デモデータ生成 (Postgres)
-- 対象エリア: 東京都江東区 (豊洲・有明・東雲・辰巳)
-- データ規模: ドライバー12名、荷物約500件/日、30日分実績
-- ============================================================

-- ============================================================
-- 1. 配送所 (豊洲エリア)
-- ============================================================
INSERT INTO depots (depot_id, name, address, lat, lng)
VALUES (
    'DEPOT-TOYOSU',
    '豊洲配送センター',
    '東京都江東区豊洲6-1-1',
    35.6495,
    139.7914
) ON CONFLICT (depot_id) DO NOTHING;

-- ============================================================
-- 2. ドライバー 12名
-- ============================================================
INSERT INTO drivers (driver_id, depot_id, name, vehicle_type, vehicle_capacity, vehicle_volume, skill_level, area_assignment)
VALUES
    ('DRV-001', 'DEPOT-TOYOSU', '田中 太郎',   'van', 400, 10.0, 5, 'A'),
    ('DRV-002', 'DEPOT-TOYOSU', '佐藤 花子',   'van', 400, 10.0, 4, 'A'),
    ('DRV-003', 'DEPOT-TOYOSU', '鈴木 一郎',   'van', 350, 8.0,  3, 'B'),
    ('DRV-004', 'DEPOT-TOYOSU', '高橋 美咲',   'van', 350, 8.0,  4, 'B'),
    ('DRV-005', 'DEPOT-TOYOSU', '渡辺 健太',   'van', 400, 10.0, 3, 'C'),
    ('DRV-006', 'DEPOT-TOYOSU', '伊藤 さくら', 'van', 350, 8.0,  2, 'C'),
    ('DRV-007', 'DEPOT-TOYOSU', '山本 翔太',   'van', 400, 10.0, 5, 'A'),
    ('DRV-008', 'DEPOT-TOYOSU', '中村 あかり', 'van', 350, 8.0,  3, 'B'),
    ('DRV-009', 'DEPOT-TOYOSU', '小林 大輔',   'van', 400, 10.0, 4, 'C'),
    ('DRV-010', 'DEPOT-TOYOSU', '加藤 由美',   'van', 350, 8.0,  3, 'A'),
    ('DRV-011', 'DEPOT-TOYOSU', '吉田 拓海',   'van', 350, 8.0,  2, 'B'),
    ('DRV-012', 'DEPOT-TOYOSU', '松本 真理',   'van', 400, 10.0, 4, 'C')
ON CONFLICT (driver_id) DO NOTHING;

-- ============================================================
-- 3. 明日の荷物データ (約487件)
-- ============================================================
INSERT INTO packages (
    package_id, depot_id, date, address, lat, lng, h3_index,
    time_window, weight, volume, is_redelivery, recipient_type
)
SELECT
    'PKG-' || TO_CHAR(CURRENT_DATE + 1, 'YYYYMMDD') || '-' || LPAD(n::text, 4, '0'),
    'DEPOT-TOYOSU',
    CURRENT_DATE + 1,
    CASE area
        WHEN 'A' THEN '東京都江東区豊洲' || (FLOOR(RANDOM()*6)+1)::text || '-' || (FLOOR(RANDOM()*20)+1)::text || '-' || (FLOOR(RANDOM()*10)+1)::text
        WHEN 'B' THEN '東京都江東区有明' || (FLOOR(RANDOM()*4)+1)::text || '-' || (FLOOR(RANDOM()*15)+1)::text || '-' || (FLOOR(RANDOM()*10)+1)::text
        WHEN 'C' THEN '東京都江東区辰巳' || (FLOOR(RANDOM()*3)+1)::text || '-' || (FLOOR(RANDOM()*20)+1)::text || '-' || (FLOOR(RANDOM()*10)+1)::text
    END,
    lat_val,
    lng_val,
    h3_lat_lng_to_cell(POINT(lat_val, lng_val), 9),
    CASE
        WHEN RANDOM() < 0.08 THEN '09:00-12:00'
        WHEN RANDOM() < 0.15 THEN '14:00-16:00'
        WHEN RANDOM() < 0.10 THEN '18:00-20:00'
        ELSE NULL
    END,
    ROUND((RANDOM() * 15 + 0.5)::numeric, 2),
    ROUND((RANDOM() * 0.08 + 0.005)::numeric, 3),
    RANDOM() < 0.03,
    CASE
        WHEN RANDOM() < 0.55 THEN 'apartment'
        WHEN RANDOM() < 0.80 THEN 'house'
        WHEN RANDOM() < 0.95 THEN 'office'
        ELSE 'convenience_store'
    END
FROM (
    SELECT
        n,
        CASE
            WHEN n <= 170 THEN 'A'
            WHEN n <= 330 THEN 'B'
            ELSE 'C'
        END AS area,
        CASE
            WHEN n <= 170 THEN 35.645 + RANDOM() * 0.015
            WHEN n <= 330 THEN 35.630 + RANDOM() * 0.015
            ELSE 35.635 + RANDOM() * 0.015
        END AS lat_val,
        CASE
            WHEN n <= 170 THEN 139.780 + RANDOM() * 0.020
            WHEN n <= 330 THEN 139.785 + RANDOM() * 0.015
            ELSE 139.800 + RANDOM() * 0.025
        END AS lng_val
    FROM generate_series(1, 487) AS n
) sub
ON CONFLICT (package_id) DO NOTHING;

-- ============================================================
-- 4. 過去30日分の荷物
-- ============================================================
INSERT INTO packages (
    package_id, depot_id, date, address, lat, lng, h3_index,
    time_window, weight, volume, is_redelivery, recipient_type
)
SELECT
    'PKG-' || TO_CHAR(d, 'YYYYMMDD') || '-' || LPAD(n::text, 4, '0'),
    'DEPOT-TOYOSU',
    d,
    '東京都江東区',
    lat_val,
    lng_val,
    h3_lat_lng_to_cell(POINT(lat_val, lng_val), 9),
    CASE
        WHEN RANDOM() < 0.08 THEN '09:00-12:00'
        WHEN RANDOM() < 0.15 THEN '14:00-16:00'
        WHEN RANDOM() < 0.10 THEN '18:00-20:00'
        ELSE NULL
    END,
    ROUND((RANDOM() * 15 + 0.5)::numeric, 2),
    ROUND((RANDOM() * 0.08 + 0.005)::numeric, 3),
    RANDOM() < 0.03,
    CASE
        WHEN RANDOM() < 0.55 THEN 'apartment'
        WHEN RANDOM() < 0.80 THEN 'house'
        WHEN RANDOM() < 0.95 THEN 'office'
        ELSE 'convenience_store'
    END
FROM (
    SELECT
        d,
        n,
        35.630 + RANDOM() * 0.030 AS lat_val,
        139.780 + RANDOM() * 0.045 AS lng_val
    FROM
        generate_series(CURRENT_DATE - 30, CURRENT_DATE, '1 day'::interval) AS d,
        generate_series(1, 450 + FLOOR(RANDOM() * 100)::int) AS n
) sub
ON CONFLICT (package_id) DO NOTHING;

-- ============================================================
-- 5. 過去30日の配達ステータス
-- ============================================================
INSERT INTO delivery_status (package_id, driver_id, date, status, completed_at, is_absent, attempt_count)
SELECT
    p.package_id,
    'DRV-' || LPAD((((ROW_NUMBER() OVER (PARTITION BY p.date ORDER BY p.package_id)) % 12) + 1)::text, 3, '0'),
    p.date,
    CASE
        WHEN rnd < 0.85 THEN 'delivered'
        WHEN rnd < 0.97 THEN 'absent'
        ELSE 'failed'
    END,
    CASE
        WHEN rnd < 0.97 THEN
            p.date + (INTERVAL '8 hours') + (RANDOM() * INTERVAL '10 hours')
        ELSE NULL
    END,
    rnd >= 0.85 AND rnd < 0.97,
    CASE
        WHEN rnd < 0.85 THEN 1
        WHEN rnd < 0.90 THEN 1
        WHEN rnd < 0.97 THEN 2
        ELSE 1
    END
FROM packages p
CROSS JOIN LATERAL (SELECT RANDOM() AS rnd) r
WHERE p.date <= CURRENT_DATE
ON CONFLICT (package_id) DO NOTHING;

-- ============================================================
-- 6. 当日の荷物 + 配達状況 (64%完了の途中状態)
-- ============================================================
INSERT INTO packages (
    package_id, depot_id, date, address, lat, lng, h3_index,
    time_window, weight, volume, is_redelivery, recipient_type
)
SELECT
    'PKG-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' || LPAD(n::text, 4, '0'),
    'DEPOT-TOYOSU',
    CURRENT_DATE,
    '東京都江東区',
    lat_val, lng_val,
    h3_lat_lng_to_cell(POINT(lat_val, lng_val), 9),
    CASE
        WHEN RANDOM() < 0.08 THEN '09:00-12:00'
        WHEN RANDOM() < 0.15 THEN '14:00-16:00'
        WHEN RANDOM() < 0.10 THEN '18:00-20:00'
        ELSE NULL
    END,
    ROUND((RANDOM() * 15 + 0.5)::numeric, 2),
    ROUND((RANDOM() * 0.08 + 0.005)::numeric, 3),
    RANDOM() < 0.03,
    CASE
        WHEN RANDOM() < 0.55 THEN 'apartment'
        WHEN RANDOM() < 0.80 THEN 'house'
        ELSE 'office'
    END
FROM (
    SELECT n,
        35.630 + RANDOM() * 0.030 AS lat_val,
        139.780 + RANDOM() * 0.045 AS lng_val
    FROM generate_series(1, 487) AS n
) sub
ON CONFLICT (package_id) DO NOTHING;

INSERT INTO delivery_status (package_id, driver_id, date, status, completed_at, is_absent, attempt_count)
SELECT
    p.package_id,
    'DRV-' || LPAD((((rn - 1) % 12) + 1)::text, 3, '0'),
    p.date,
    CASE
        WHEN rn <= 280 THEN 'delivered'
        WHEN rn <= 312 THEN 'absent'
        WHEN rn <= 340 THEN 'in_transit'
        ELSE 'assigned'
    END,
    CASE
        WHEN rn <= 312 THEN
            CURRENT_DATE + INTERVAL '8 hours' + (rn * INTERVAL '1 minute' * 1.5)
        ELSE NULL
    END,
    rn > 280 AND rn <= 312,
    CASE WHEN rn <= 312 THEN 1 ELSE 0 END
FROM (
    SELECT p.package_id, p.date,
        ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM packages p
    WHERE p.date = CURRENT_DATE
) p
ON CONFLICT (package_id) DO NOTHING;

-- ============================================================
-- 7. ドライバー現在位置
-- ============================================================
INSERT INTO driver_locations (driver_id, lat, lng, h3_index, speed, heading, timestamp)
VALUES
    ('DRV-001', 35.6548, 139.7932, h3_lat_lng_to_cell(POINT(35.6548, 139.7932), 9), 22.5, 135, NOW() - INTERVAL '30 seconds'),
    ('DRV-002', 35.6512, 139.7865, h3_lat_lng_to_cell(POINT(35.6512, 139.7865), 9), 18.3, 200, NOW() - INTERVAL '15 seconds'),
    ('DRV-003', 35.6385, 139.7920, h3_lat_lng_to_cell(POINT(35.6385, 139.7920), 9), 0.0,   0,  NOW() - INTERVAL '5 minutes'),
    ('DRV-004', 35.6422, 139.7945, h3_lat_lng_to_cell(POINT(35.6422, 139.7945), 9), 30.1, 310, NOW() - INTERVAL '20 seconds'),
    ('DRV-005', 35.6401, 139.8095, h3_lat_lng_to_cell(POINT(35.6401, 139.8095), 9), 15.7,  45, NOW() - INTERVAL '10 seconds'),
    ('DRV-006', 35.6438, 139.8150, h3_lat_lng_to_cell(POINT(35.6438, 139.8150), 9), 25.2,  90, NOW() - INTERVAL '45 seconds'),
    ('DRV-007', 35.6580, 139.7850, h3_lat_lng_to_cell(POINT(35.6580, 139.7850), 9), 12.0, 180, NOW() - INTERVAL '8 seconds'),
    ('DRV-008', 35.6365, 139.7960, h3_lat_lng_to_cell(POINT(35.6365, 139.7960), 9), 28.4, 270, NOW() - INTERVAL '25 seconds'),
    ('DRV-009', 35.6450, 139.8200, h3_lat_lng_to_cell(POINT(35.6450, 139.8200), 9), 20.0, 160, NOW() - INTERVAL '12 seconds'),
    ('DRV-010', 35.6530, 139.7880, h3_lat_lng_to_cell(POINT(35.6530, 139.7880), 9), 0.0,   0,  NOW() - INTERVAL '2 minutes'),
    ('DRV-011', 35.6390, 139.7980, h3_lat_lng_to_cell(POINT(35.6390, 139.7980), 9), 33.0,  20, NOW() - INTERVAL '18 seconds'),
    ('DRV-012', 35.6475, 139.8120, h3_lat_lng_to_cell(POINT(35.6475, 139.8120), 9), 16.5, 225, NOW() - INTERVAL '35 seconds')
ON CONFLICT (driver_id) DO UPDATE SET
    lat = EXCLUDED.lat, lng = EXCLUDED.lng, h3_index = EXCLUDED.h3_index,
    speed = EXCLUDED.speed, heading = EXCLUDED.heading,
    timestamp = EXCLUDED.timestamp;

-- ============================================================
-- 8. 渋滞情報 (エリアBに渋滞あり)
-- ============================================================
INSERT INTO traffic_realtime (h3_index, datetime, congestion_level, speed_ratio)
SELECT
    h3_lat_lng_to_cell(POINT(lat, lng), 7),
    generate_series(
        CURRENT_DATE + INTERVAL '8 hours',
        CURRENT_DATE + INTERVAL '18 hours',
        INTERVAL '1 hour'
    ),
    CASE
        WHEN lat BETWEEN 35.635 AND 35.642 AND lng BETWEEN 139.790 AND 139.798
        THEN 3 + FLOOR(RANDOM() * 2)::int
        ELSE FLOOR(RANDOM() * 2)::int
    END,
    CASE
        WHEN lat BETWEEN 35.635 AND 35.642 AND lng BETWEEN 139.790 AND 139.798
        THEN 0.3 + RANDOM() * 0.2
        ELSE 0.8 + RANDOM() * 0.2
    END
FROM (
    SELECT
        35.630 + (r * 0.003) AS lat,
        139.780 + (c * 0.005) AS lng
    FROM generate_series(0, 9) AS r,
         generate_series(0, 9) AS c
) coords
ON CONFLICT (h3_index, datetime) DO NOTHING;

-- ============================================================
-- 9. 道路工事 (エリアCに翌日工事)
-- ============================================================
INSERT INTO road_construction (h3_index, center_lat, center_lng, radius_m, start_date, end_date, restriction_type, description)
VALUES
(
    h3_lat_lng_to_cell(POINT(35.6420, 139.8100), 9),
    35.6420, 139.8100, 150,
    CURRENT_DATE + 1,
    CURRENT_DATE + 5,
    'lane_closure',
    '辰巳橋付近 車線規制（水道管工事）'
),
(
    h3_lat_lng_to_cell(POINT(35.6380, 139.8050), 9),
    35.6380, 139.8050, 100,
    CURRENT_DATE + 1,
    CURRENT_DATE + 3,
    'road_closure',
    '東雲交差点 全面通行止め（ガス管工事）'
);

-- ============================================================
-- 10. 明日のルート
-- ============================================================
INSERT INTO routes (route_id, driver_id, depot_id, date, total_distance, total_time_est, stop_count, status)
SELECT
    'RT-' || TO_CHAR(CURRENT_DATE + 1, 'YYYYMMDD') || '-' || d.driver_id,
    d.driver_id,
    'DEPOT-TOYOSU',
    CURRENT_DATE + 1,
    15000 + RANDOM() * 10000,
    (6 * 3600 + RANDOM() * 7200)::int,
    (35 + FLOOR(RANDOM() * 20))::int,
    'planned'
FROM drivers d
WHERE d.is_active = true
ON CONFLICT (route_id) DO NOTHING;

-- 荷物にルートを紐付け (Haversine距離ベース)
UPDATE packages p
SET
    route_id = sub.route_id,
    stop_order = sub.stop_order,
    loading_order = sub.loading_order
FROM (
    SELECT
        p2.package_id,
        r2.route_id,
        ROW_NUMBER() OVER (PARTITION BY r2.route_id ORDER BY
            SQRT(POWER(p2.lat - 35.6495, 2) + POWER((p2.lng - 139.7914) * COS(RADIANS(35.6495)), 2))
        ) AS stop_order,
        (SELECT COUNT(*) FROM packages p3 WHERE p3.date = p2.date AND p3.route_id IS NULL)
            - ROW_NUMBER() OVER (PARTITION BY r2.route_id ORDER BY
                SQRT(POWER(p2.lat - 35.6495, 2) + POWER((p2.lng - 139.7914) * COS(RADIANS(35.6495)), 2))
              ) + 1 AS loading_order
    FROM packages p2
    JOIN delivery_status ds ON ds.package_id = p2.package_id
    JOIN routes r2 ON r2.driver_id = ds.driver_id AND r2.date = p2.date
    WHERE p2.date = CURRENT_DATE + 1
) sub
WHERE p.package_id = sub.package_id;
