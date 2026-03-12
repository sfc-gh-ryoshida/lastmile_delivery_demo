-- ============================================================
-- Snowflake Postgres セットアップ (OLTP + H3)
-- 実行先: Snowflake Postgres インスタンス
-- PostGIS は pgaudit バグのため未使用 (GEOMETRY → lat/lng で代替)
-- ============================================================
-- ============================================================

CREATE EXTENSION IF NOT EXISTS h3;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- OLTP テーブル定義
-- ============================================================

CREATE TABLE IF NOT EXISTS depots (
    depot_id    VARCHAR(20) PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    address     TEXT,
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS drivers (
    driver_id         VARCHAR(20) PRIMARY KEY,
    depot_id          VARCHAR(20) NOT NULL REFERENCES depots(depot_id),
    name              VARCHAR(50) NOT NULL,
    vehicle_type      VARCHAR(20) DEFAULT 'van',
    vehicle_capacity  NUMERIC(8,2) DEFAULT 350.0,
    vehicle_volume    NUMERIC(8,2) DEFAULT 8.0,
    skill_level       INT DEFAULT 3 CHECK (skill_level BETWEEN 1 AND 5),
    area_assignment   VARCHAR(10),
    is_active         BOOLEAN DEFAULT true,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS packages (
    package_id      VARCHAR(30) PRIMARY KEY,
    depot_id        VARCHAR(20) NOT NULL REFERENCES depots(depot_id),
    date            DATE NOT NULL,
    address         TEXT NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    h3_index        H3INDEX,
    time_window     VARCHAR(20),
    weight          NUMERIC(8,2) DEFAULT 2.0,
    volume          NUMERIC(8,3) DEFAULT 0.02,
    is_redelivery   BOOLEAN DEFAULT false,
    recipient_type  VARCHAR(20) DEFAULT 'residential',
    route_id        VARCHAR(30),
    stop_order      INT,
    loading_order   INT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_packages_date ON packages(date);
CREATE INDEX IF NOT EXISTS idx_packages_h3 ON packages(h3_index);
CREATE INDEX IF NOT EXISTS idx_packages_route ON packages(route_id);

CREATE TABLE IF NOT EXISTS driver_locations (
    driver_id   VARCHAR(20) PRIMARY KEY REFERENCES drivers(driver_id),
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    h3_index    H3INDEX,
    speed       DOUBLE PRECISION DEFAULT 0,
    heading     DOUBLE PRECISION DEFAULT 0,
    timestamp   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_locations_h3 ON driver_locations(h3_index);

CREATE TABLE IF NOT EXISTS delivery_status (
    package_id      VARCHAR(30) REFERENCES packages(package_id),
    driver_id       VARCHAR(20) REFERENCES drivers(driver_id),
    date            DATE NOT NULL,
    status          VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending','assigned','in_transit','delivered','absent','failed')),
    completed_at    TIMESTAMPTZ,
    is_absent       BOOLEAN DEFAULT false,
    attempt_count   INT DEFAULT 0,
    notes           TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (package_id, date)
);
CREATE INDEX IF NOT EXISTS idx_delivery_status_driver ON delivery_status(driver_id, date);
CREATE INDEX IF NOT EXISTS idx_delivery_status_date ON delivery_status(date);
CREATE INDEX IF NOT EXISTS idx_delivery_status_status ON delivery_status(status);
CREATE INDEX IF NOT EXISTS idx_delivery_status_date_status ON delivery_status(date, status);

CREATE TABLE IF NOT EXISTS routes (
    route_id        VARCHAR(30) PRIMARY KEY,
    driver_id       VARCHAR(20) NOT NULL REFERENCES drivers(driver_id),
    depot_id        VARCHAR(20) NOT NULL REFERENCES depots(depot_id),
    date            DATE NOT NULL,
    total_distance  DOUBLE PRECISION,
    total_time_est  INT,
    stop_count      INT,
    status          VARCHAR(20) DEFAULT 'planned',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_routes_date ON routes(date);
CREATE INDEX IF NOT EXISTS idx_routes_driver ON routes(driver_id, date);

CREATE TABLE IF NOT EXISTS traffic_realtime (
    h3_index          H3INDEX NOT NULL,
    datetime          TIMESTAMPTZ NOT NULL,
    congestion_level  INT CHECK (congestion_level BETWEEN 0 AND 4),
    speed_ratio       DOUBLE PRECISION,
    PRIMARY KEY (h3_index, datetime)
);

CREATE TABLE IF NOT EXISTS road_construction (
    construction_id   SERIAL PRIMARY KEY,
    h3_index          H3INDEX,
    center_lat        DOUBLE PRECISION,
    center_lng        DOUBLE PRECISION,
    radius_m          DOUBLE PRECISION DEFAULT 100,
    start_date        DATE NOT NULL,
    end_date          DATE,
    restriction_type  VARCHAR(30),
    description       TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_construction_h3 ON road_construction(h3_index);
CREATE INDEX IF NOT EXISTS idx_construction_date ON road_construction(start_date, end_date);

CREATE TABLE IF NOT EXISTS driver_locations_history (
    id          SERIAL PRIMARY KEY,
    driver_id   VARCHAR(20) NOT NULL REFERENCES drivers(driver_id),
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    h3_index    H3INDEX,
    speed       DOUBLE PRECISION DEFAULT 0,
    heading     DOUBLE PRECISION DEFAULT 0,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loc_hist_driver_time ON driver_locations_history(driver_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_loc_hist_h3 ON driver_locations_history(h3_index);

CREATE OR REPLACE FUNCTION fn_log_driver_location()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO driver_locations_history (driver_id, lat, lng, h3_index, speed, heading, recorded_at)
    VALUES (NEW.driver_id, NEW.lat, NEW.lng, NEW.h3_index, NEW.speed, NEW.heading, NEW.timestamp);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_log_driver_location
AFTER INSERT OR UPDATE ON driver_locations
FOR EACH ROW
EXECUTE FUNCTION fn_log_driver_location();

-- ============================================================
-- driver_attendance — ドライバー出退勤
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_attendance (
    id              SERIAL PRIMARY KEY,
    driver_id       VARCHAR(20) NOT NULL REFERENCES drivers(driver_id),
    date            DATE NOT NULL,
    status          VARCHAR(20) DEFAULT 'present'
                    CHECK (status IN ('present','absent','late','withdrawn')),
    check_in_time   TIMESTAMPTZ,
    check_out_time  TIMESTAMPTZ,
    reason          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (driver_id, date)
);
CREATE INDEX IF NOT EXISTS idx_driver_attendance_date ON driver_attendance(date);

-- ============================================================
-- delivery_alerts — 配達アラート
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_alerts (
    id                  SERIAL PRIMARY KEY,
    alert_id            VARCHAR(50) NOT NULL UNIQUE,
    driver_id           VARCHAR(20) REFERENCES drivers(driver_id),
    date                DATE NOT NULL,
    hour                INT,
    anomaly_score       DOUBLE PRECISION,
    severity            VARCHAR(20) CHECK (severity IN ('critical','warning','info')),
    alert_type          VARCHAR(50),
    description         TEXT,
    recommended_action  TEXT,
    acknowledged        BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_date ON delivery_alerts(date);
CREATE INDEX IF NOT EXISTS idx_alerts_driver ON delivery_alerts(driver_id, date);
