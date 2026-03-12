-- ============================================================
-- デモデータ追加: 道路重要度機能を可視化するための追加データ
-- 対象: road_construction, traffic_realtime
-- エリア: 豊洲・有明・東雲・辰巳 (lat 35.630-35.660, lng 139.780-139.825)
-- スキーマ: no_postgis 版 (geometry カラムなし)
-- ============================================================

-- ============================================================
-- 1. road_construction: 今日有効な工事 6件 + 明日の工事 2件
-- ============================================================

INSERT INTO road_construction (h3_index, center_lat, center_lng, radius_m, start_date, end_date, restriction_type, description)
VALUES
(
    h3_latlng_to_cell(point(35.6450, 139.7920), 9),
    35.6450, 139.7920, 120,
    CURRENT_DATE - 2, CURRENT_DATE + 3,
    'lane_closure',
    '豊洲大橋付近 車線規制（下水管更新工事）'
),
(
    h3_latlng_to_cell(point(35.6400, 139.7950), 9),
    35.6400, 139.7950, 80,
    CURRENT_DATE - 1, CURRENT_DATE + 2,
    'road_closure',
    '東雲キャナル通り 全面通行止め（電線地中化工事）'
),
(
    h3_latlng_to_cell(point(35.6380, 139.8050), 9),
    35.6380, 139.8050, 100,
    CURRENT_DATE, CURRENT_DATE + 7,
    'road_closure',
    '東雲交差点 全面通行止め（ガス管工事）'
),
(
    h3_latlng_to_cell(point(35.6520, 139.7880), 9),
    35.6520, 139.7880, 150,
    CURRENT_DATE - 3, CURRENT_DATE + 1,
    'lane_closure',
    '晴海通り 片側規制（歩道拡幅工事）'
),
(
    h3_latlng_to_cell(point(35.6440, 139.8100), 9),
    35.6440, 139.8100, 200,
    CURRENT_DATE, CURRENT_DATE + 14,
    'lane_closure',
    '辰巳団地前 車線規制（水道管交換工事）'
),
(
    h3_latlng_to_cell(point(35.6350, 139.7920), 9),
    35.6350, 139.7920, 90,
    CURRENT_DATE - 1, CURRENT_DATE + 5,
    'detour',
    '有明テニスの森駅前 迂回路設定（マンション建設搬入）'
),
(
    h3_latlng_to_cell(point(35.6420, 139.8100), 9),
    35.6420, 139.8100, 150,
    CURRENT_DATE + 1, CURRENT_DATE + 5,
    'lane_closure',
    '辰巳橋付近 車線規制（水道管工事）'
),
(
    h3_latlng_to_cell(point(35.6480, 139.7850), 9),
    35.6480, 139.7850, 100,
    CURRENT_DATE + 1, CURRENT_DATE + 3,
    'road_closure',
    '豊洲市場前 全面通行止め（路面改修）'
);

-- ============================================================
-- 2. traffic_realtime: 渋滞レベル 0-4 のリッチデータ
--    重渋滞ホットスポットを複数エリアに配置
-- ============================================================

-- まず各座標点＋タイムスタンプの組み合わせを生成し、重複を避けるため
-- h3_index 解像度7 でグルーピングして MAX で集約
INSERT INTO traffic_realtime (h3_index, datetime, congestion_level, speed_ratio)
SELECT
    h3_cell,
    ts,
    MAX(cong),
    MIN(spd)
FROM (
    SELECT
        h3_latlng_to_cell(point(lat, lng), 7) AS h3_cell,
        ts,
        CASE
            WHEN lat BETWEEN 35.636 AND 35.643 AND lng BETWEEN 139.790 AND 139.800
            THEN 3 + FLOOR(RANDOM() * 2)::int
            WHEN lat BETWEEN 35.643 AND 35.650 AND lng BETWEEN 139.785 AND 139.795
            THEN 2 + FLOOR(RANDOM() * 2)::int
            WHEN lat BETWEEN 35.635 AND 35.645 AND lng BETWEEN 139.800 AND 139.815
            THEN 2 + FLOOR(RANDOM() * 3)::int
            WHEN lat BETWEEN 35.648 AND 35.655 AND lng BETWEEN 139.788 AND 139.795
            THEN 2 + FLOOR(RANDOM() * 2)::int
            ELSE FLOOR(RANDOM() * 2)::int
        END AS cong,
        CASE
            WHEN lat BETWEEN 35.636 AND 35.643 AND lng BETWEEN 139.790 AND 139.800
            THEN 0.15 + RANDOM() * 0.20
            WHEN lat BETWEEN 35.643 AND 35.650 AND lng BETWEEN 139.785 AND 139.795
            THEN 0.35 + RANDOM() * 0.20
            WHEN lat BETWEEN 35.635 AND 35.645 AND lng BETWEEN 139.800 AND 139.815
            THEN 0.25 + RANDOM() * 0.30
            WHEN lat BETWEEN 35.648 AND 35.655 AND lng BETWEEN 139.788 AND 139.795
            THEN 0.30 + RANDOM() * 0.25
            ELSE 0.75 + RANDOM() * 0.25
        END AS spd,
        lat, lng
    FROM (
        SELECT
            35.630 + (r * 0.003) AS lat,
            139.780 + (c * 0.004) AS lng
        FROM generate_series(0, 10) AS r,
             generate_series(0, 11) AS c
    ) coords
    CROSS JOIN (
        SELECT generate_series(
            NOW() - INTERVAL '1 hour',
            NOW() + INTERVAL '1 hour',
            INTERVAL '30 minutes'
        ) AS ts
    ) times
) sub
GROUP BY h3_cell, ts
ON CONFLICT (h3_index, datetime) DO UPDATE
SET congestion_level = EXCLUDED.congestion_level,
    speed_ratio = EXCLUDED.speed_ratio;
