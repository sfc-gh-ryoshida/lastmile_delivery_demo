import psycopg2
from psycopg2.extras import execute_values
import random
import math
import sys
import os
from datetime import timedelta, timezone
from dotenv import load_dotenv

load_dotenv()

JST = timezone(timedelta(hours=9))

conn = psycopg2.connect(
    host=os.environ["POSTGRES_HOST"],
    port=int(os.environ.get("POSTGRES_PORT", 5432)),
    user=os.environ.get("POSTGRES_USER", "snowflake_admin"),
    password=os.environ["POSTGRES_PASSWORD"],
    dbname=os.environ.get("POSTGRES_DB", "postgres")
)

cur = conn.cursor()

DATES = ['2026-03-11', '2026-03-12']

for target_date in DATES:
    print(f"\n=== {target_date} ===")
    print("  Fetching delivered stops...", flush=True)

    cur.execute("""
        SELECT ds.driver_id, p.lat, p.lng, ds.completed_at
        FROM delivery_status ds
        JOIN packages p ON p.package_id = ds.package_id
        WHERE ds.date = %s AND ds.status = 'delivered' AND ds.completed_at IS NOT NULL
        ORDER BY ds.driver_id, ds.completed_at
    """, [target_date])

    rows = cur.fetchall()
    print(f"  {len(rows)} delivered stops found", flush=True)

    drivers = {}
    for driver_id, lat, lng, completed_at in rows:
        if driver_id not in drivers:
            drivers[driver_id] = []
        drivers[driver_id].append((lat, lng, completed_at))

    all_points = []
    driver_list = list(drivers.items())

    for idx, (driver_id, stops) in enumerate(driver_list):
        if len(stops) < 2:
            print(f"  [{idx+1}/{len(driver_list)}] {driver_id}: skipped (< 2 stops)", flush=True)
            continue

        depot_lat, depot_lng = 35.6505, 139.8170
        first_stop = stops[0]
        start_time = first_stop[2] - timedelta(minutes=random.randint(10, 25))

        segments = [(depot_lat, depot_lng, start_time)] + [(s[0], s[1], s[2]) for s in stops]
        driver_points = 0

        for i in range(len(segments) - 1):
            lat1, lng1, t1 = segments[i]
            lat2, lng2, t2 = segments[i + 1]

            dist = math.sqrt((lat2 - lat1)**2 + (lng2 - lng1)**2)
            duration = (t2 - t1).total_seconds()
            if duration <= 0:
                continue

            num_points = max(int(duration / 15), 2)

            for j in range(num_points):
                frac = j / num_points
                lat = lat1 + (lat2 - lat1) * frac + (random.random() - 0.5) * 0.0003
                lng = lng1 + (lng2 - lng1) * frac + (random.random() - 0.5) * 0.0003
                t = t1 + timedelta(seconds=duration * frac)

                speed = (dist * 111000 / duration * 3.6) if duration > 0 else 0
                speed = speed * (0.7 + random.random() * 0.6)
                speed = min(speed, 60)

                heading = math.degrees(math.atan2(lng2 - lng1, lat2 - lat1)) % 360

                all_points.append((driver_id, lat, lng, speed, heading, t))
                driver_points += 1

        print(f"  [{idx+1}/{len(driver_list)}] {driver_id}: {len(stops)} stops -> {driver_points} GPS points", flush=True)

    all_points.sort(key=lambda x: (x[0], x[5]))
    print(f"  Total: {len(all_points)} points. Inserting...", flush=True)

    batch_size = 2000
    total_batches = (len(all_points) + batch_size - 1) // batch_size
    for i in range(0, len(all_points), batch_size):
        batch = all_points[i:i+batch_size]
        values = [(p[0], p[1], p[2], p[3], p[4], p[5]) for p in batch]
        execute_values(
            cur,
            "INSERT INTO driver_locations_history (driver_id, lat, lng, speed, heading, recorded_at) VALUES %s",
            values,
            page_size=2000
        )
        batch_num = i // batch_size + 1
        pct = batch_num * 100 // total_batches
        sys.stdout.write(f"\r  Inserting... {batch_num}/{total_batches} batches ({pct}%)")
        sys.stdout.flush()

    conn.commit()
    print(f"\n  DONE: {target_date} -> {len(all_points)} points for {len(drivers)} drivers", flush=True)

cur.close()
conn.close()
print("\nAll done!")
