#!/usr/bin/env python3
"""
Lastmile Delivery Simulator — All-in-one demo data generator
=============================================================
Runs one command → all 5 Postgres tables update live:
  1. driver_locations       (UPSERT current GPS)
  2. driver_locations_history (INSERT trail)
  3. delivery_status        (pending → in_transit → delivered/absent)
  4. traffic_realtime       (H3 congestion from driver density)
  5. delivery_dwell         (INSERT per delivery stop)

Usage:
  python3 tools/gps_simulator.py --reset
  python3 tools/gps_simulator.py --date 2026-03-12 --speed 15 --start random --ramp 3,6,9,12
  python3 tools/gps_simulator.py --no-traffic --no-dwell   # GPS + status only
"""

import argparse
import math
import os
import random
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras

DEPOT_LAT = 35.6495
DEPOT_LNG = 139.7914

AREA_CENTER_LAT = 35.645
AREA_CENTER_LNG = 139.800
AREA_SPREAD = 0.015

MOVE_SPEED_KMH_MIN = 20
MOVE_SPEED_KMH_MAX = 40
DWELL_SECONDS_MIN = 5
DWELL_SECONDS_MAX = 20
ARRIVAL_THRESHOLD_KM = 0.03
NOISE_DEG = 0.00012

DEFAULT_ABSENCE_RATE = 0.12

RAMP_INTERVAL_TICKS = 15

TRAFFIC_UPDATE_EVERY = 5
TRAFFIC_DECAY_TICKS = 12

CONGESTION_SPEED_FACTOR = {0: 1.0, 1: 0.85, 2: 0.6, 3: 0.4, 4: 0.25}

WAYPOINT_COUNT = 2
WAYPOINT_JITTER_DEG = 0.0015

LOCATION_TYPES = [("apartment", 0.50), ("office", 0.30), ("house", 0.20)]

C = "\033["
BOLD = f"{C}1m"
DIM = f"{C}2m"
RST = f"{C}0m"
GRN = f"{C}32m"
YLW = f"{C}33m"
CYN = f"{C}36m"
RED = f"{C}31m"
BLU = f"{C}34m"
MAG = f"{C}35m"
CLR = f"{C}2K"
UP = f"{C}A"


def get_connection():
    env_file = os.path.join(os.path.dirname(__file__), "..", "lastmile-app", ".env.local")
    password = None
    pg_host = None
    pg_user = None
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith("POSTGRES_PASSWORD="):
                    password = line.split("=", 1)[1]
                elif line.startswith("POSTGRES_HOST="):
                    pg_host = line.split("=", 1)[1]
                elif line.startswith("POSTGRES_USER="):
                    pg_user = line.split("=", 1)[1]

    return psycopg2.connect(
        host=pg_host or os.environ.get("POSTGRES_HOST"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "postgres"),
        user=pg_user or os.environ.get("POSTGRES_USER", "snowflake_admin"),
        password=password or os.environ.get("POSTGRES_PASSWORD"),
        sslmode="require",
    )


def haversine(lat1, lng1, lat2, lng2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def bearing(lat1, lng1, lat2, lng2):
    dlng = math.radians(lng2 - lng1)
    y = math.sin(dlng) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(dlng)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def pick_location_type():
    r = random.random()
    cumulative = 0
    for lt, prob in LOCATION_TYPES:
        cumulative += prob
        if r < cumulative:
            return lt
    return "house"


def load_routes(conn, date, driver_filter):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT ds.driver_id, p.lat, p.lng, p.stop_order, p.package_id, ds.status
        FROM delivery_status ds
        JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
        WHERE ds.date = %s
        ORDER BY ds.driver_id, p.stop_order
    """, (date,))
    rows = cur.fetchall()
    cur.close()

    routes = {}
    for r in rows:
        did = r["driver_id"]
        if driver_filter and did not in driver_filter:
            continue
        if did not in routes:
            routes[did] = []
        routes[did].append({
            "lat": float(r["lat"]),
            "lng": float(r["lng"]),
            "stop_order": r["stop_order"],
            "package_id": r["package_id"],
            "status": r["status"],
        })
    return routes


def generate_waypoints(lat1, lng1, lat2, lng2, count=WAYPOINT_COUNT):
    pts = []
    for i in range(1, count + 1):
        t = i / (count + 1)
        mid_lat = lat1 + (lat2 - lat1) * t
        mid_lng = lng1 + (lng2 - lng1) * t
        dlat = lat2 - lat1
        dlng = lng2 - lng1
        perp_lat = -dlng
        perp_lng = dlat
        length = math.sqrt(perp_lat ** 2 + perp_lng ** 2)
        if length > 0:
            perp_lat /= length
            perp_lng /= length
        offset = random.uniform(-WAYPOINT_JITTER_DEG, WAYPOINT_JITTER_DEG)
        pts.append((mid_lat + perp_lat * offset, mid_lng + perp_lng * offset))
    return pts


class DriverSim:
    def __init__(self, driver_id, stops, start_mode="depot", absence_rate=DEFAULT_ABSENCE_RATE):
        self.driver_id = driver_id
        self.stops = stops
        self.stop_idx = 0
        self.delivered_count = 0
        self.absent_count = 0
        self.speed = 0.0
        self.heading = 0.0
        self.state = "waiting"
        self.dwell_remaining = 0.0
        self.dwell_start = None
        self.finished = False
        self.active = False
        self.absence_rate = absence_rate
        self.pending_events = []
        self.h3_cell = None
        self.congestion_factor = 1.0
        self.waypoints = []
        self.wp_idx = 0

        if start_mode == "random":
            self.lat = AREA_CENTER_LAT + random.uniform(-AREA_SPREAD, AREA_SPREAD)
            self.lng = AREA_CENTER_LNG + random.uniform(-AREA_SPREAD, AREA_SPREAD)
        else:
            self.lat = DEPOT_LAT
            self.lng = DEPOT_LNG

    def _build_waypoints(self):
        tgt_lat, tgt_lng = self.target()
        self.waypoints = generate_waypoints(self.lat, self.lng, tgt_lat, tgt_lng)
        self.wp_idx = 0

    def _current_target(self):
        if self.wp_idx < len(self.waypoints):
            return self.waypoints[self.wp_idx]
        return self.target()

    def activate(self):
        if not self.active and not self.finished:
            self.active = True
            self.state = "moving"
            self._build_waypoints()
            if self.stop_idx < len(self.stops):
                self.pending_events.append({
                    "type": "status",
                    "package_id": self.stops[self.stop_idx]["package_id"],
                    "event": "in_transit",
                })

    def target(self):
        if self.stop_idx < len(self.stops):
            s = self.stops[self.stop_idx]
            return s["lat"], s["lng"]
        return DEPOT_LAT, DEPOT_LNG

    def tick(self, dt_seconds, speed_mult, congestion_map=None):
        if self.finished or not self.active:
            return

        if congestion_map and self.h3_cell and self.h3_cell in congestion_map:
            level = congestion_map[self.h3_cell]
            self.congestion_factor = CONGESTION_SPEED_FACTOR.get(level, 1.0)
        else:
            self.congestion_factor = 1.0

        if self.state == "dwelling":
            self.dwell_remaining -= dt_seconds * speed_mult
            self.speed = 0.0
            if self.dwell_remaining <= 0:
                stop = self.stops[self.stop_idx]
                is_absent = random.random() < self.absence_rate
                result = "absent" if is_absent else "delivered"
                if is_absent:
                    self.absent_count += 1
                else:
                    self.delivered_count += 1

                self.pending_events.append({
                    "type": "status",
                    "package_id": stop["package_id"],
                    "event": result,
                })
                self.pending_events.append({
                    "type": "dwell",
                    "package_id": stop["package_id"],
                    "lat": stop["lat"],
                    "lng": stop["lng"],
                    "arrived_at": self.dwell_start,
                    "dwell_seconds": int(self.dwell_total),
                    "result": result,
                })

                self.stop_idx += 1
                if self.stop_idx >= len(self.stops):
                    self.state = "returning"
                    self._build_waypoints()
                else:
                    self.state = "moving"
                    self._build_waypoints()
                    self.pending_events.append({
                        "type": "status",
                        "package_id": self.stops[self.stop_idx]["package_id"],
                        "event": "in_transit",
                    })
            return

        tgt_lat, tgt_lng = self._current_target()
        dist = haversine(self.lat, self.lng, tgt_lat, tgt_lng)

        wp_threshold = ARRIVAL_THRESHOLD_KM * 1.5
        if self.wp_idx < len(self.waypoints) and dist < wp_threshold:
            self.wp_idx += 1
            return

        if dist < ARRIVAL_THRESHOLD_KM:
            if self.state == "returning":
                self.speed = 0.0
                self.finished = True
                return
            self.state = "dwelling"
            self.dwell_remaining = random.uniform(DWELL_SECONDS_MIN, DWELL_SECONDS_MAX)
            self.dwell_total = self.dwell_remaining
            self.dwell_start = datetime.now(timezone.utc)
            self.speed = 0.0
            return

        speed_kmh = random.uniform(MOVE_SPEED_KMH_MIN, MOVE_SPEED_KMH_MAX) * self.congestion_factor
        move_km = (speed_kmh / 3600.0) * dt_seconds * speed_mult

        if move_km >= dist:
            self.lat = tgt_lat
            self.lng = tgt_lng
        else:
            frac = move_km / dist
            self.lat += (tgt_lat - self.lat) * frac + random.uniform(-NOISE_DEG, NOISE_DEG)
            self.lng += (tgt_lng - self.lng) * frac + random.uniform(-NOISE_DEG, NOISE_DEG)

        self.heading = bearing(self.lat, self.lng, tgt_lat, tgt_lng)
        self.speed = speed_kmh


class TrafficSim:
    def __init__(self):
        self.cell_last_update = {}
        self.congested_cells = 0
        self.congestion_map = {}

    def update(self, conn, drivers, tick):
        if tick % TRAFFIC_UPDATE_EVERY != 0:
            return

        h3_counts = Counter()
        for d in drivers:
            if d.active and not d.finished and d.h3_cell:
                h3_counts[d.h3_cell] += 1

        now = datetime.now(timezone.utc)
        hour_dt = now.replace(minute=0, second=0, microsecond=0)

        cur = conn.cursor()
        cells_to_write = {}

        for h3, count in h3_counts.items():
            level = min(count, 4)
            speed_ratio = max(0.3, 0.95 - 0.15 * level + random.uniform(-0.05, 0.05))
            cells_to_write[h3] = (level, speed_ratio)
            self.cell_last_update[h3] = tick

            if level >= 2:
                try:
                    cur.execute("SELECT h3_grid_disk(%s::h3index, 1)", (h3,))
                    neighbors = [row[0] for row in cur.fetchall()]
                    for nb in neighbors:
                        nb_str = str(nb)
                        if nb_str != h3 and nb_str not in cells_to_write:
                            nb_level = max(0, level - 1)
                            nb_ratio = max(0.4, 0.95 - 0.15 * nb_level + random.uniform(-0.05, 0.05))
                            cells_to_write[nb_str] = (nb_level, nb_ratio)
                except Exception:
                    pass

        expired = []
        for h3, last_tick in self.cell_last_update.items():
            if h3 not in h3_counts and (tick - last_tick) > TRAFFIC_DECAY_TICKS:
                cells_to_write[h3] = (0, random.uniform(0.85, 0.95))
                expired.append(h3)
        for h3 in expired:
            del self.cell_last_update[h3]

        for h3, (level, ratio) in cells_to_write.items():
            cur.execute("""
                INSERT INTO traffic_realtime (h3_index, datetime, congestion_level, speed_ratio)
                VALUES (%s::h3index, %s, %s, %s)
                ON CONFLICT (h3_index, datetime) DO UPDATE SET
                    congestion_level = EXCLUDED.congestion_level,
                    speed_ratio = EXCLUDED.speed_ratio
            """, (h3, hour_dt, level, ratio))

        conn.commit()
        cur.close()

        self.congestion_map = {h3: level for h3, (level, _) in cells_to_write.items() if level >= 1}
        self.congested_cells = sum(1 for l, _ in cells_to_write.values() if l >= 2)


def update_db(conn, drivers, date, enable_status, enable_dwell):
    active_drivers = [d for d in drivers if d.active]
    if not active_drivers:
        return

    cur = conn.cursor()
    now = datetime.now(timezone.utc)

    for d in active_drivers:
        cur.execute("""
            INSERT INTO driver_locations (driver_id, lat, lng, h3_index, speed, heading, timestamp)
            VALUES (%s, %s, %s, h3_latlng_to_cell(POINT(%s, %s), 9), %s, %s, %s)
            ON CONFLICT (driver_id) DO UPDATE SET
                lat = EXCLUDED.lat, lng = EXCLUDED.lng, h3_index = EXCLUDED.h3_index,
                speed = EXCLUDED.speed, heading = EXCLUDED.heading, timestamp = EXCLUDED.timestamp
            RETURNING h3_index::text
        """, (d.driver_id, d.lat, d.lng, d.lng, d.lat, d.speed, d.heading, now))
        row = cur.fetchone()
        if row:
            d.h3_cell = row[0]

        cur.execute("""
            INSERT INTO driver_locations_history (driver_id, lat, lng, h3_index, speed, heading, recorded_at)
            VALUES (%s, %s, %s, h3_latlng_to_cell(POINT(%s, %s), 9), %s, %s, %s)
        """, (d.driver_id, d.lat, d.lng, d.lng, d.lat, d.speed, d.heading, now))

    for d in active_drivers:
        for evt in d.pending_events:
            if evt["type"] == "status" and enable_status:
                pkg_id = evt["package_id"]
                event = evt["event"]
                if event == "in_transit":
                    cur.execute(
                        """UPDATE delivery_status SET status = 'in_transit', updated_at = %s
                           WHERE package_id = %s AND date = %s AND status IN ('pending', 'assigned')""",
                        (now, pkg_id, date))
                elif event == "delivered":
                    cur.execute(
                        """UPDATE delivery_status SET status = 'delivered', completed_at = %s,
                           is_absent = false, attempt_count = attempt_count + 1, updated_at = %s
                           WHERE package_id = %s AND date = %s""",
                        (now, now, pkg_id, date))
                elif event == "absent":
                    cur.execute(
                        """UPDATE delivery_status SET status = 'absent', completed_at = %s,
                           is_absent = true, attempt_count = attempt_count + 1, updated_at = %s
                           WHERE package_id = %s AND date = %s""",
                        (now, now, pkg_id, date))

            elif evt["type"] == "dwell" and enable_dwell:
                arrived = evt["arrived_at"]
                dwell_sec = evt["dwell_seconds"]
                departed = arrived + timedelta(seconds=dwell_sec)
                loc_type = pick_location_type()
                if loc_type == "apartment":
                    floor_num = random.randint(1, 15)
                elif loc_type == "office":
                    floor_num = random.randint(1, 25)
                else:
                    floor_num = 1
                has_elev = random.random() < 0.9 if floor_num >= 5 else random.random() < 0.3

                cur.execute("""
                    INSERT INTO delivery_dwell
                        (package_id, driver_id, date, arrived_at, departed_at, dwell_seconds,
                         location_type, lat, lng, floor_number, has_elevator)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (evt["package_id"], d.driver_id, date, arrived, departed, dwell_sec,
                      loc_type, evt["lat"], evt["lng"], floor_num, has_elev))

        d.pending_events.clear()

    conn.commit()
    cur.close()


def reset_all(conn, date, driver_sims):
    cur = conn.cursor()
    driver_ids = [d.driver_id for d in driver_sims]

    for d in driver_sims:
        cur.execute(
            """UPDATE driver_locations SET lat = %s, lng = %s,
               h3_index = h3_latlng_to_cell(POINT(%s, %s), 9),
               speed = 0, heading = 0, timestamp = NOW()
               WHERE driver_id = %s""",
            (d.lat, d.lng, d.lng, d.lat, d.driver_id))

    for did in driver_ids:
        cur.execute(
            """UPDATE delivery_status SET status = 'pending', completed_at = NULL,
               is_absent = false, attempt_count = 0, updated_at = NOW()
               WHERE date = %s AND driver_id = %s""",
            (date, did))

    cur.execute("DELETE FROM delivery_dwell WHERE date = %s AND driver_id = ANY(%s)",
                (date, driver_ids))

    now_hour = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    cur.execute("DELETE FROM traffic_realtime WHERE datetime >= %s", (now_hour - timedelta(hours=2),))

    cur.execute("DELETE FROM driver_locations_history WHERE driver_id = ANY(%s) AND recorded_at > NOW() - INTERVAL '1 hour'",
                (driver_ids,))

    conn.commit()
    cur.close()


def format_elapsed(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}h{m:02d}m{s:02d}s"
    return f"{m}m{s:02d}s"


def state_label(d):
    if not d.active:
        return f"{DIM}待機{RST}"
    if d.finished:
        return f"{GRN}完了{RST}"
    return {"moving": f"{CYN}走行{RST}", "dwelling": f"{YLW}配達{RST}", "returning": f"{BLU}帰還{RST}"}.get(d.state, d.state)


def print_dashboard(drivers, tick, elapsed, cfg, traffic_sim, prev_lines):
    for _ in range(prev_lines):
        sys.stdout.write(f"{UP}{CLR}")

    lines = []
    active = [d for d in drivers if d.active and not d.finished]
    waiting = [d for d in drivers if not d.active]
    finished = [d for d in drivers if d.finished]
    total_del = sum(d.delivered_count for d in drivers)
    total_abs = sum(d.absent_count for d in drivers)
    total_vis = total_del + total_abs
    total_stops = sum(len(d.stops) for d in drivers)
    pct = total_vis * 100 // max(total_stops, 1)

    features = []
    if cfg["status"]:
        features.append("status")
    if cfg["traffic"]:
        features.append("traffic")
    if cfg["dwell"]:
        features.append("dwell")
    feat_str = "+".join(features) if features else "GPS only"

    lines.append(f"{BOLD}{'='*76}{RST}")
    lines.append(
        f"{BOLD} Delivery Simulator{RST}  "
        f"Date: {CYN}{cfg['date']}{RST}  "
        f"Speed: {GRN}{cfg['speed']}x{RST}  "
        f"Tick: {tick}  "
        f"Elapsed: {format_elapsed(elapsed)}"
    )
    lines.append(
        f" Drivers: {GRN}{len(active)} active{RST} / "
        f"{DIM}{len(waiting)} wait{RST} / "
        f"{CYN}{len(finished)} done{RST}    "
        f"{GRN}{total_del} delivered{RST}  "
        f"{RED}{total_abs} absent{RST}  "
        f"{DIM}{total_stops - total_vis} remaining{RST}  "
        f"[{pct}%]"
    )

    traffic_str = ""
    if cfg["traffic"]:
        traffic_str = f"  {MAG}Traffic: {traffic_sim.congested_cells} congested cells{RST}"
    slowed = sum(1 for d in drivers if d.active and not d.finished and d.congestion_factor < 1.0)
    slow_str = f"  {RED}Slowed: {slowed} drivers{RST}" if slowed else ""
    lines.append(f"{DIM} [{feat_str}]  absence={cfg['absence']:.0%}{traffic_str}{slow_str}{RST}")
    lines.append(f"{BOLD}{'-'*76}{RST}")

    for d in drivers:
        vis = d.delivered_count + d.absent_count
        dp = vis * 100 // max(len(d.stops), 1)
        bw = 12
        filled = dp * bw // 100
        bar = f"{'█' * filled}{'░' * (bw - filled)}"
        cng = f" {RED}▼{d.congestion_factor:.0%}{RST}" if d.congestion_factor < 1.0 else ""
        spd = (f"{d.speed:4.0f}km/h" if d.speed > 0 else "  stop") + cng
        abs_s = f" {RED}x{d.absent_count}{RST}" if d.absent_count > 0 else ""
        lines.append(
            f" {d.driver_id} {state_label(d):>14s}  "
            f"{bar} {dp:3d}%  "
            f"{GRN}{d.delivered_count}{RST}/{DIM}{len(d.stops)}{RST}{abs_s}  "
            f"{spd}  ({d.lat:.4f},{d.lng:.4f})"
        )

    lines.append(f"{BOLD}{'='*76}{RST}")
    lines.append(f"{DIM} Updates every {cfg['interval']}s  |  Ctrl+C to stop{RST}")

    sys.stdout.write("\n".join(lines))
    sys.stdout.flush()
    return len(lines)


def replay_mode(args, driver_filter):
    conn = get_connection()
    print(f"\n{BOLD}Replay Mode{RST}")
    print(f"  {CYN}Reading driver_locations_history (last {args.replay_minutes} min)...{RST}")

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    driver_clause = ""
    params = [args.replay_minutes]
    if driver_filter:
        driver_clause = " AND driver_id = ANY(%s)"
        params.append(list(driver_filter))

    cur.execute(f"""
        SELECT driver_id, lat, lng, speed, heading, recorded_at
        FROM driver_locations_history
        WHERE recorded_at > NOW() - INTERVAL '{args.replay_minutes} minutes'
        {driver_clause}
        ORDER BY recorded_at ASC
    """, params[1:] if driver_filter else [])
    rows = cur.fetchall()
    cur.close()

    if not rows:
        print(f"  {RED}No history found in the last {args.replay_minutes} minutes.{RST}")
        conn.close()
        return

    drivers_data = {}
    for r in rows:
        did = r["driver_id"]
        if did not in drivers_data:
            drivers_data[did] = []
        drivers_data[did].append(r)

    all_times = sorted(set(r["recorded_at"] for r in rows))
    driver_ids = sorted(drivers_data.keys())

    print(f"  {GRN}{len(driver_ids)} drivers, {len(rows)} points, {len(all_times)} frames{RST}")
    print(f"  Time range: {all_times[0].strftime('%H:%M:%S')} → {all_times[-1].strftime('%H:%M:%S')}")
    print(f"  Playback speed: {args.replay_speed}x\n")
    time.sleep(0.5)

    time_index = {}
    for did, pts in drivers_data.items():
        for pt in pts:
            t = pt["recorded_at"]
            if t not in time_index:
                time_index[t] = {}
            time_index[t][did] = pt

    prev_lines = 0
    last_state = {did: drivers_data[did][0] for did in driver_ids}

    try:
        for frame_num, t in enumerate(all_times):
            for _ in range(prev_lines):
                sys.stdout.write(f"{UP}{CLR}")

            for did, pt in time_index.get(t, {}).items():
                last_state[did] = pt

            lines = []
            lines.append(f"{BOLD}{'='*76}{RST}")
            lines.append(
                f"{BOLD} ▶ Replay{RST}  "
                f"Time: {CYN}{t.strftime('%H:%M:%S')}{RST}  "
                f"Frame: {frame_num + 1}/{len(all_times)}  "
                f"Speed: {GRN}{args.replay_speed}x{RST}"
            )
            pct = (frame_num + 1) * 100 // len(all_times)
            bw = 40
            filled = pct * bw // 100
            bar = f"{'█' * filled}{'░' * (bw - filled)}"
            lines.append(f" {bar} {pct:3d}%")
            lines.append(f"{BOLD}{'-'*76}{RST}")

            for did in driver_ids:
                st = last_state.get(did)
                if st:
                    spd = float(st["speed"]) if st["speed"] else 0
                    spd_s = f"{spd:4.0f}km/h" if spd > 0 else "  stop"
                    state_s = f"{CYN}走行{RST}" if spd > 0 else f"{DIM}停止{RST}"
                    lat_f = float(st["lat"])
                    lng_f = float(st["lng"])
                    lines.append(
                        f" {did} {state_s:>14s}  "
                        f"{spd_s}  ({lat_f:.4f},{lng_f:.4f})"
                    )

            lines.append(f"{BOLD}{'='*76}{RST}")
            lines.append(f"{DIM} Ctrl+C to stop replay{RST}")

            sys.stdout.write("\n".join(lines))
            sys.stdout.flush()
            prev_lines = len(lines)

            if frame_num < len(all_times) - 1:
                next_t = all_times[frame_num + 1]
                real_gap = (next_t - t).total_seconds()
                sleep_time = real_gap / args.replay_speed
                sleep_time = max(0.05, min(sleep_time, 2.0))
                time.sleep(sleep_time)

        print(f"\n\n  {GRN}Replay complete!{RST}")
    except KeyboardInterrupt:
        print(f"\n\n  Replay stopped at frame {frame_num + 1}/{len(all_times)}")
    finally:
        conn.close()
        print(f"  Connection closed\n")


def main():
    parser = argparse.ArgumentParser(
        description="Lastmile Delivery Simulator — all tables, one command",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --reset                                    # full reset + run
  %(prog)s --date 2026-03-12 --speed 15 --ramp 3,6,9,12
  %(prog)s --start random --absence-rate 0.20
  %(prog)s --no-traffic --no-dwell                    # GPS + status only
  %(prog)s --replay                                    # replay past run from history
  %(prog)s --replay --replay-minutes 30 --replay-speed 5
        """,
    )
    parser.add_argument("--date", default="2026-03-12")
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--speed", type=float, default=10.0)
    parser.add_argument("--drivers", default=None)
    parser.add_argument("--start", choices=["depot", "random"], default="depot")
    parser.add_argument("--ramp", default=None)
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--absence-rate", type=float, default=DEFAULT_ABSENCE_RATE)
    parser.add_argument("--no-status", action="store_true")
    parser.add_argument("--no-traffic", action="store_true")
    parser.add_argument("--no-dwell", action="store_true")
    parser.add_argument("--replay", action="store_true", help="Replay from driver_locations_history")
    parser.add_argument("--replay-minutes", type=int, default=60, help="How many minutes back to replay")
    parser.add_argument("--replay-speed", type=float, default=3.0, help="Replay playback speed multiplier")
    args = parser.parse_args()

    driver_filter = set(args.drivers.split(",")) if args.drivers else None

    if args.replay:
        replay_mode(args, driver_filter)
        return

    ramp_stages = [int(x) for x in args.ramp.split(",")] if args.ramp else None

    cfg = {
        "date": args.date,
        "speed": args.speed,
        "interval": args.interval,
        "absence": args.absence_rate,
        "status": not args.no_status,
        "traffic": not args.no_traffic,
        "dwell": not args.no_dwell,
    }

    features = []
    if cfg["status"]:
        features.append("delivery_status")
    if cfg["traffic"]:
        features.append("traffic_realtime")
    if cfg["dwell"]:
        features.append("delivery_dwell")
    feat_display = ", ".join(features) if features else "GPS only"

    print(f"\n{BOLD}Lastmile Delivery Simulator{RST}")
    print(f"  Date:     {CYN}{args.date}{RST}")
    print(f"  Speed:    {GRN}{args.speed}x{RST}    Interval: {args.interval}s")
    print(f"  Start:    {args.start}")
    print(f"  Tables:   driver_locations, history, {feat_display}")
    if cfg["status"]:
        print(f"  Absence:  {RED}{args.absence_rate:.0%}{RST}")
    if ramp_stages:
        print(f"  Ramp:     {' -> '.join(str(s) for s in ramp_stages)} drivers")
    print()

    conn = get_connection()
    print(f"  {GRN}Connected to Postgres{RST}")

    routes = load_routes(conn, args.date, driver_filter)
    if not routes:
        print(f"  {RED}No routes found for {args.date}.{RST}")
        conn.close()
        return

    print(f"  Loaded {len(routes)} drivers, {sum(len(s) for s in routes.values())} stops")

    driver_sims = []
    for did, stops in sorted(routes.items()):
        driver_sims.append(DriverSim(did, stops, start_mode=args.start, absence_rate=args.absence_rate))

    initial_count = ramp_stages[0] if ramp_stages else len(driver_sims)
    for i, d in enumerate(driver_sims):
        if i < initial_count:
            d.activate()

    if args.reset:
        print(f"  Resetting all tables...")
        reset_all(conn, args.date, driver_sims)
        print(f"  {GRN}Reset complete (locations, status, dwell, traffic, history){RST}")

    traffic_sim = TrafficSim()

    print(f"\n  {GRN}Starting... (Ctrl+C to stop){RST}\n")
    time.sleep(0.5)

    tick = 0
    start_time = time.time()
    prev_lines = 0
    ramp_idx = 1

    try:
        while True:
            cmap = traffic_sim.congestion_map if cfg["traffic"] else None
            for d in driver_sims:
                d.tick(args.interval, args.speed, congestion_map=cmap)

            update_db(conn, driver_sims, args.date, cfg["status"], cfg["dwell"])

            if cfg["traffic"]:
                traffic_sim.update(conn, driver_sims, tick)

            tick += 1
            elapsed = time.time() - start_time

            if ramp_stages and ramp_idx < len(ramp_stages) and tick % RAMP_INTERVAL_TICKS == 0:
                target_count = ramp_stages[ramp_idx]
                for d in driver_sims:
                    if not d.active:
                        d.activate()
                        if sum(1 for dd in driver_sims if dd.active) >= target_count:
                            break
                ramp_idx += 1

            prev_lines = print_dashboard(driver_sims, tick, elapsed, cfg, traffic_sim, prev_lines)

            if all(d.finished for d in driver_sims if d.active) and all(d.active for d in driver_sims):
                total_d = sum(d.delivered_count for d in driver_sims)
                total_a = sum(d.absent_count for d in driver_sims)
                print(f"\n\n  {GRN}All drivers completed!{RST}  {total_d} delivered, {total_a} absent")
                break

            time.sleep(args.interval)

    except KeyboardInterrupt:
        total_d = sum(d.delivered_count for d in driver_sims)
        total_a = sum(d.absent_count for d in driver_sims)
        print(f"\n\n  Stopped at tick {tick} ({format_elapsed(time.time() - start_time)})")
        print(f"  Progress: {total_d} delivered, {total_a} absent")
    finally:
        conn.close()
        print(f"  Connection closed\n")


if __name__ == "__main__":
    main()
