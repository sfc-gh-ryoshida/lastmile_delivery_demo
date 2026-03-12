BEGIN;

-- ============================================================
-- 3/12 Demo Data: Target time = 13:00 JST (04:00 UTC)
-- Status mix: delivered ~55%, in_transit ~12%, absent ~8%,
--             pending ~20%, assigned ~3%, failed ~2%
-- ============================================================

-- 1. Generate ~490 packages for 2026-03-12
-- Reuse lat/lng/address/h3_index from existing packages (last 34 days)
-- with slight randomization in selection

INSERT INTO packages (
  package_id, depot_id, date, address, lat, lng, h3_index,
  time_window, weight, volume, is_redelivery, recipient_type,
  route_id, stop_order, loading_order, created_at
)
SELECT
  'PKG-0312-' || LPAD(ROW_NUMBER() OVER (ORDER BY random())::text, 4, '0'),
  'DEPOT-TOYOSU',
  '2026-03-12'::date,
  src.address,
  src.lat + (random() - 0.5) * 0.001,
  src.lng + (random() - 0.5) * 0.001,
  src.h3_index,
  CASE
    WHEN random() < 0.10 THEN '09:00-12:00'
    WHEN random() < 0.25 THEN '14:00-16:00'
    WHEN random() < 0.38 THEN '18:00-20:00'
    ELSE NULL
  END,
  ROUND((1.0 + random() * 14.0)::numeric, 1),
  ROUND((0.5 + random() * 9.5)::numeric, 1),
  random() < 0.07,
  src.recipient_type,
  NULL, NULL, NULL,
  NOW() - interval '12 hours'
FROM (
  SELECT DISTINCT ON (package_id) address, lat, lng, h3_index, recipient_type
  FROM packages
  WHERE date >= '2026-02-20'
  ORDER BY package_id, random()
  LIMIT 490
) src;

-- 2. Assign route_ids and stop_orders
-- Distribute packages round-robin to 12 drivers
WITH base AS (
  SELECT package_id, ROW_NUMBER() OVER (ORDER BY random()) AS rn
  FROM packages WHERE date = '2026-03-12'
),
assigned AS (
  SELECT package_id,
    'DRV-' || LPAD(((rn - 1) % 12 + 1)::text, 3, '0') AS driver_id
  FROM base
),
numbered AS (
  SELECT a.package_id, a.driver_id,
    ROW_NUMBER() OVER (PARTITION BY a.driver_id ORDER BY random()) AS stop_ord
  FROM assigned a
)
UPDATE packages p
SET route_id = 'RT-' || n.driver_id || '-0312',
    stop_order = n.stop_ord,
    loading_order = n.stop_ord
FROM numbered n
WHERE p.package_id = n.package_id AND p.date = '2026-03-12';

-- 3. Create routes for each driver
INSERT INTO routes (route_id, driver_id, depot_id, date, total_distance, total_time_est, stop_count, status, created_at)
SELECT
  p.route_id,
  SUBSTRING(p.route_id FROM 4 FOR 7),
  'DEPOT-TOYOSU',
  '2026-03-12'::date,
  ROUND((15 + random() * 20)::numeric, 1),
  (180 + (random() * 120))::int,
  COUNT(*),
  'in_progress',
  NOW() - interval '12 hours'
FROM packages p
WHERE p.date = '2026-03-12' AND p.route_id IS NOT NULL
GROUP BY p.route_id;

-- 4. Create delivery_status for all packages
-- At 13:00 JST (04:00 UTC), morning deliveries (09:00-12:00) should be mostly done
-- Afternoon ones (14:00-16:00) starting, evening (18:00-20:00) still pending

INSERT INTO delivery_status (
  package_id, driver_id, date, status, completed_at, is_absent, attempt_count, notes, updated_at
)
SELECT
  p.package_id,
  SUBSTRING(p.route_id FROM 4 FOR 7),
  '2026-03-12'::date,
  CASE
    -- Morning window (09:00-12:00): 85% delivered, 10% absent, 5% failed
    WHEN p.time_window = '09:00-12:00' THEN
      CASE
        WHEN random() < 0.85 THEN 'delivered'
        WHEN random() < 0.93 THEN 'absent'
        ELSE 'failed'
      END
    -- Afternoon window (14:00-16:00): 30% delivered (early ones), 20% in_transit, 10% absent, 35% assigned, 5% failed
    WHEN p.time_window = '14:00-16:00' THEN
      CASE
        WHEN random() < 0.30 THEN 'delivered'
        WHEN random() < 0.50 THEN 'in_transit'
        WHEN random() < 0.60 THEN 'absent'
        WHEN random() < 0.95 THEN 'assigned'
        ELSE 'failed'
      END
    -- Evening window (18:00-20:00): all pending still
    WHEN p.time_window = '18:00-20:00' THEN 'pending'
    -- No window (flex): depends on stop_order
    ELSE
      CASE
        -- Early stops (1-15): mostly done
        WHEN p.stop_order <= 15 THEN
          CASE
            WHEN random() < 0.80 THEN 'delivered'
            WHEN random() < 0.90 THEN 'absent'
            ELSE 'failed'
          END
        -- Mid stops (16-25): mix
        WHEN p.stop_order <= 25 THEN
          CASE
            WHEN random() < 0.45 THEN 'delivered'
            WHEN random() < 0.70 THEN 'in_transit'
            WHEN random() < 0.80 THEN 'absent'
            ELSE 'assigned'
          END
        -- Late stops (26+): not started
        ELSE
          CASE
            WHEN random() < 0.05 THEN 'assigned'
            ELSE 'pending'
          END
      END
  END,
  NULL, -- completed_at (set below)
  false, -- is_absent (set below)
  1,
  NULL,
  NOW()
FROM packages p
WHERE p.date = '2026-03-12';

-- 5. Set completed_at for delivered/absent/failed
-- Morning deliveries: 08:30-12:00 JST → 23:30 prev day - 03:00 UTC
-- Afternoon deliveries: 12:30-13:00 JST → 03:30-04:00 UTC
UPDATE delivery_status
SET completed_at = CASE
  WHEN status IN ('delivered', 'absent', 'failed') THEN
    '2026-03-11'::timestamp + interval '23 hours' + 
    (random() * 5.0) * interval '1 hour'  -- 23:00 UTC (08:00 JST) to 04:00 UTC (13:00 JST)
  ELSE NULL
END
WHERE date = '2026-03-12' AND status IN ('delivered', 'absent', 'failed');

-- 6. Set is_absent flag
UPDATE delivery_status
SET is_absent = true
WHERE date = '2026-03-12' AND status = 'absent';

-- 7. Set attempt_count
UPDATE delivery_status
SET attempt_count = CASE
  WHEN status = 'delivered' THEN (CASE WHEN random() < 0.85 THEN 1 ELSE 2 END)
  WHEN status = 'absent' THEN (CASE WHEN random() < 0.70 THEN 1 ELSE 2 END)
  WHEN status = 'failed' THEN 1
  ELSE 0
END
WHERE date = '2026-03-12';

-- 8. Generate delivery_dwell for delivered/absent/failed packages
INSERT INTO delivery_dwell (
  package_id, driver_id, date, arrived_at, departed_at, dwell_seconds,
  location_type, lat, lng, floor_number, has_elevator, notes
)
SELECT
  ds.package_id,
  ds.driver_id,
  '2026-03-12'::date,
  ds.completed_at - (interval '1 second' * dwell_s),
  ds.completed_at,
  dwell_s,
  p.recipient_type,
  p.lat,
  p.lng,
  CASE WHEN p.recipient_type = 'apartment' THEN (1 + (random() * 14)::int) 
       WHEN p.recipient_type = 'office' THEN (1 + (random() * 8)::int)
       ELSE 1 END,
  CASE WHEN p.recipient_type IN ('apartment', 'office') AND random() < 0.6 THEN true ELSE false END,
  NULL
FROM delivery_status ds
JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN p.recipient_type = 'apartment' THEN (90 + (random() * 180)::int)
    WHEN p.recipient_type = 'office' THEN (120 + (random() * 240)::int)
    WHEN p.recipient_type = 'house' THEN (30 + (random() * 60)::int)
    ELSE (20 + (random() * 30)::int)
  END AS dwell_s
) dw
WHERE ds.date = '2026-03-12' AND ds.status IN ('delivered', 'absent', 'failed') AND ds.completed_at IS NOT NULL;

-- 9. Update driver_locations to 13:00 JST positions
-- Drivers who are in_transit: somewhere on route
-- Drivers with only pending/assigned left: near last delivery or depot
DELETE FROM driver_locations WHERE driver_id IN (SELECT driver_id FROM drivers WHERE is_active);

INSERT INTO driver_locations (driver_id, lat, lng, h3_index, speed, heading, timestamp)
SELECT
  d.driver_id,
  CASE
    WHEN in_transit_count > 0 THEN 35.6350 + (random() * 0.025)
    WHEN delivered_count > 0 THEN last_lat
    ELSE 35.6495  -- depot
  END,
  CASE
    WHEN in_transit_count > 0 THEN 139.7850 + (random() * 0.035)
    WHEN delivered_count > 0 THEN last_lng
    ELSE 139.7914  -- depot
  END,
  NULL,  -- h3_index will be set separately
  CASE
    WHEN in_transit_count > 0 THEN 15 + random() * 25
    ELSE 0
  END,
  random() * 360,
  '2026-03-12 04:00:00+00'::timestamptz  -- 13:00 JST
FROM drivers d
LEFT JOIN LATERAL (
  SELECT 
    COUNT(*) FILTER (WHERE ds.status = 'in_transit') AS in_transit_count,
    COUNT(*) FILTER (WHERE ds.status = 'delivered') AS delivered_count,
    (SELECT p2.lat FROM delivery_status ds2 JOIN packages p2 ON p2.package_id=ds2.package_id AND p2.date=ds2.date
     WHERE ds2.driver_id=d.driver_id AND ds2.date='2026-03-12' AND ds2.status='delivered'
     ORDER BY ds2.completed_at DESC LIMIT 1) AS last_lat,
    (SELECT p2.lng FROM delivery_status ds2 JOIN packages p2 ON p2.package_id=ds2.package_id AND p2.date=ds2.date
     WHERE ds2.driver_id=d.driver_id AND ds2.date='2026-03-12' AND ds2.status='delivered'
     ORDER BY ds2.completed_at DESC LIMIT 1) AS last_lng
  FROM delivery_status ds
  WHERE ds.driver_id = d.driver_id AND ds.date = '2026-03-12'
) stats ON true
WHERE d.is_active = true;

-- Update h3_index for driver locations
UPDATE driver_locations dl
SET h3_index = h3_latlng_to_cell(point(dl.lat, dl.lng), 9)
WHERE dl.h3_index IS NULL;

-- 10. Generate driver_locations_history for 3/12
-- From 08:00 JST (23:00 UTC 3/11) to 13:00 JST (04:00 UTC 3/12)
-- Interpolate between depot → delivered stops → current position
DELETE FROM driver_locations_history 
WHERE recorded_at >= '2026-03-11 23:00:00+00' AND recorded_at <= '2026-03-12 04:30:00+00';

INSERT INTO driver_locations_history (driver_id, lat, lng, h3_index, speed, heading, recorded_at)
SELECT
  ds.driver_id,
  p.lat + (random()-0.5)*0.0005,
  p.lng + (random()-0.5)*0.0005,
  p.h3_index,
  10 + random() * 30,
  random() * 360,
  ds.completed_at - interval '30 seconds'
FROM delivery_status ds
JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
WHERE ds.date = '2026-03-12' AND ds.completed_at IS NOT NULL
ORDER BY ds.driver_id, ds.completed_at;

-- Also add depot departure points for each driver (08:00 JST = 23:00 UTC)
INSERT INTO driver_locations_history (driver_id, lat, lng, h3_index, speed, heading, recorded_at)
SELECT d.driver_id, 35.6495, 139.7914,
  h3_latlng_to_cell(point(35.6495, 139.7914), 9),
  0, 0,
  '2026-03-11 23:00:00+00'::timestamptz + (random() * 30) * interval '1 minute'
FROM drivers d WHERE d.is_active;

-- 11. Update traffic_realtime for 3/12 13:00
DELETE FROM traffic_realtime WHERE datetime::date = '2026-03-12';

INSERT INTO traffic_realtime (h3_index, datetime, congestion_level, speed_ratio)
SELECT
  t.h3_index,
  '2026-03-12 04:00:00+00'::timestamptz + (gs.h * interval '1 hour'),
  CASE 
    WHEN gs.h BETWEEN -1 AND 1 AND random() < 0.15 THEN 4
    WHEN random() < 0.25 THEN (2 + (random()*2)::int)
    ELSE (random()*2)::int
  END,
  CASE 
    WHEN gs.h BETWEEN -1 AND 1 AND random() < 0.15 THEN 0.3 + random() * 0.2
    WHEN random() < 0.25 THEN 0.5 + random() * 0.2
    ELSE 0.7 + random() * 0.3
  END
FROM (SELECT DISTINCT h3_index FROM traffic_realtime LIMIT 128) t
CROSS JOIN generate_series(-5, 7) gs(h);

COMMIT;
