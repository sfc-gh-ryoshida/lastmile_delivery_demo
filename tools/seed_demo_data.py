import os
import psycopg2
import random
import math
from datetime import date, datetime, timedelta

PG_HOST = os.environ["POSTGRES_HOST"]
PG_USER = os.environ.get("POSTGRES_USER", "snowflake_admin")
PG_PASS = os.environ["POSTGRES_PASSWORD"]
PG_DB = os.environ.get("POSTGRES_DB", "postgres")

DEPOT_LAT, DEPOT_LNG = 35.6495, 139.7914
DRIVERS = [f"DRV-{i:03d}" for i in range(1, 13)]
DATES = [date(2026, 3, d) for d in range(9, 14)]
TODAY = date(2026, 3, 13)

AREAS = {
    "toyosu": (35.6495, 139.7914, 0.008),
    "shinonome": (35.6330, 139.7950, 0.008),
    "ariake": (35.6380, 139.7860, 0.008),
    "kachidoki": (35.6590, 139.7760, 0.008),
    "tsukishima": (35.6630, 139.7820, 0.006),
    "kiba": (35.6720, 139.8050, 0.008),
    "monzennakacho": (35.6730, 139.7980, 0.006),
    "fukagawa": (35.6800, 139.8000, 0.006),
    "shin_kiba": (35.6350, 139.8130, 0.008),
    "tatsumi": (35.6440, 139.8080, 0.006),
    "shiomi": (35.6500, 139.8150, 0.006),
    "edagawa": (35.6650, 139.8200, 0.008),
    "sunamachi": (35.6710, 139.8350, 0.008),
    "ojima": (35.6830, 139.8220, 0.006),
    "minamisunamachi": (35.6600, 139.8400, 0.008),
}

ADDRESSES = [
    "東京都江東区豊洲3-{}-{}", "東京都江東区豊洲4-{}-{}", "東京都江東区豊洲5-{}-{}",
    "東京都江東区東雲1-{}-{}", "東京都江東区東雲2-{}-{}", "東京都江東区有明3-{}-{}",
    "東京都江東区有明2-{}-{}", "東京都江東区勝どき3-{}-{}", "東京都江東区勝どき5-{}-{}",
    "東京都江東区月島2-{}-{}", "東京都江東区月島4-{}-{}", "東京都江東区木場3-{}-{}",
    "東京都江東区木場5-{}-{}", "東京都江東区門前仲町1-{}-{}", "東京都江東区深川2-{}-{}",
    "東京都江東区新木場1-{}-{}", "東京都江東区新木場3-{}-{}", "東京都江東区辰巳1-{}-{}",
    "東京都江東区塩浜2-{}-{}", "東京都江東区枝川1-{}-{}", "東京都江東区砂町3-{}-{}",
    "東京都江東区大島5-{}-{}", "東京都江東区南砂4-{}-{}", "東京都江東区潮見2-{}-{}",
]

TIME_WINDOWS = ["09:00-12:00", "12:00-14:00", "14:00-16:00", "16:00-18:00", "指定なし"]
TIME_WEIGHTS = [0.30, 0.15, 0.20, 0.20, 0.15]
RECIPIENT_TYPES = ["residential", "apartment", "house", "office"]
RECIPIENT_WEIGHTS = [0.15, 0.45, 0.25, 0.15]

random.seed(42)


def rand_point_near(center_lat, center_lng, radius):
    lat = center_lat + random.uniform(-radius, radius)
    lng = center_lng + random.uniform(-radius, radius)
    return round(lat, 10), round(lng, 10)


def gen_packages(d, num_packages):
    pkgs = []
    area_keys = list(AREAS.keys())
    for i in range(1, num_packages + 1):
        area = random.choice(area_keys)
        clat, clng, r = AREAS[area]
        lat, lng = rand_point_near(clat, clng, r)
        addr_tpl = random.choice(ADDRESSES)
        addr = addr_tpl.format(random.randint(1, 20), random.randint(1, 30))
        tw = random.choices(TIME_WINDOWS, TIME_WEIGHTS)[0]
        wt = round(random.uniform(0.5, 5.0), 2)
        vol = round(random.uniform(0.003, 0.06), 3)
        is_redel = random.random() < 0.08
        recip = random.choices(RECIPIENT_TYPES, RECIPIENT_WEIGHTS)[0]
        delivery_method = "face_to_face" if random.random() < 0.85 else "delivery_box"
        pkg_id = f"PKG-{d.strftime('%m%d')}-{i:04d}"
        pkgs.append((pkg_id, "DEPOT-TOYOSU", d, addr, lat, lng, tw, wt, vol,
                      is_redel, recip, delivery_method))
    return pkgs


def assign_routes(pkgs, d, is_today):
    date_str = d.strftime("%m%d")
    routes = []
    assignments = []

    shuffled = list(pkgs)
    random.shuffle(shuffled)

    per_driver = len(shuffled) // len(DRIVERS)
    remainder = len(shuffled) % len(DRIVERS)

    idx = 0
    for di, drv in enumerate(DRIVERS):
        count = per_driver + (1 if di < remainder else 0)
        driver_pkgs = shuffled[idx:idx + count]
        idx += count

        trip1_count = min(count, random.randint(30, 45))
        trip2_count = count - trip1_count

        route_id = f"RT-{drv}-{date_str}"
        dist = round(random.uniform(12, 35), 1)
        time_est = random.randint(150, 300)
        route_status = "completed" if d < TODAY else "confirmed"
        routes.append((route_id, drv, "DEPOT-TOYOSU", d, dist, time_est, count, route_status))

        for si, pkg in enumerate(driver_pkgs[:trip1_count]):
            stop = si + 1
            loading = trip1_count - si
            assignments.append((pkg[0], drv, d, 1, stop, loading, route_id))

        if trip2_count > 0:
            for si, pkg in enumerate(driver_pkgs[trip1_count:]):
                stop = si + 1
                loading = trip2_count - si
                assignments.append((pkg[0], drv, d, 2, stop, loading, route_id))

    return routes, assignments


def gen_delivery_status(assignments, d, is_today):
    statuses = []
    for pkg_id, drv, dt, trip, stop, loading, route_id in assignments:
        if is_today:
            status = random.choices(
                ["assigned", "loaded", "pending"],
                [0.50, 0.30, 0.20]
            )[0]
            completed_at = None
            is_absent = False
        else:
            r = random.random()
            if r < 0.88:
                status = "delivered"
                hour = random.randint(9, 17)
                minute = random.randint(0, 59)
                completed_at = datetime(d.year, d.month, d.day, hour, minute,
                                        random.randint(0, 59))
                is_absent = False
            elif r < 0.97:
                status = "absent"
                completed_at = None
                is_absent = True
            else:
                status = "failed"
                completed_at = None
                is_absent = False

        statuses.append((pkg_id, drv, d, status, completed_at, is_absent, trip, stop))
    return statuses


def gen_driver_attendance(d, is_today):
    rows = []
    for drv in DRIVERS:
        if random.random() < 0.95:
            status = "present"
            ci = datetime(d.year, d.month, d.day, 7, random.randint(30, 59))
            co = None if is_today else datetime(d.year, d.month, d.day, 17, random.randint(30, 59))
            reason = None
        else:
            status = random.choice(["sick", "vacation"])
            ci = None
            co = None
            reason = "体調不良" if status == "sick" else "有給休暇"
        rows.append((drv, d, status, ci, co, reason))
    return rows


def main():
    conn = psycopg2.connect(host=PG_HOST, user=PG_USER, password=PG_PASS, dbname=PG_DB)
    cur = conn.cursor()

    for d in DATES:
        is_today = (d == TODAY)
        num_packages = random.randint(90, 120)
        date_str = d.strftime("%Y-%m-%d")
        print(f"\n=== {date_str} ({num_packages} packages) ===")

        pkgs = gen_packages(d, num_packages)

        cur.executemany("""
            INSERT INTO packages (package_id, depot_id, date, address, lat, lng, time_window,
                                  weight, volume, is_redelivery, recipient_type, delivery_method)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (package_id) DO NOTHING
        """, pkgs)
        print(f"  Packages inserted: {len(pkgs)}")

        routes, assignments = assign_routes(pkgs, d, is_today)

        cur.executemany("""
            INSERT INTO routes (route_id, driver_id, depot_id, date, total_distance,
                               total_time_est, stop_count, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (route_id) DO NOTHING
        """, routes)
        print(f"  Routes inserted: {len(routes)}")

        for pkg_id, drv, dt, trip, stop, loading, route_id in assignments:
            cur.execute("""
                UPDATE packages SET route_id = %s, stop_order = %s, loading_order = %s
                WHERE package_id = %s
            """, (route_id, stop, loading, pkg_id))

        statuses = gen_delivery_status(assignments, d, is_today)
        cur.executemany("""
            INSERT INTO delivery_status (package_id, driver_id, date, status, completed_at,
                                         is_absent, trip_number, stop_order)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (package_id, date) DO NOTHING
        """, statuses)
        print(f"  Delivery statuses inserted: {len(statuses)}")

        att_rows = gen_driver_attendance(d, is_today)
        cur.executemany("""
            INSERT INTO driver_attendance (driver_id, date, status, check_in_time,
                                           check_out_time, reason)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (driver_id, date) DO NOTHING
        """, att_rows)
        print(f"  Attendance inserted: {len(att_rows)}")

        conn.commit()

    print("\n=== Summary ===")
    for tbl in ["packages", "delivery_status", "routes", "driver_attendance"]:
        cur.execute(f"SELECT COUNT(*) FROM {tbl}")
        print(f"  {tbl}: {cur.fetchone()[0]} rows")

    cur.execute("""
        SELECT date, status, COUNT(*) FROM delivery_status
        GROUP BY date, status ORDER BY date, status
    """)
    print("\n=== Delivery Status by Date ===")
    for row in cur.fetchall():
        print(f"  {row[0]} | {row[1]:12s} | {row[2]}")

    cur.close()
    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
