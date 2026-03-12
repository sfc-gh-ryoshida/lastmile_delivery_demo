import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

type Action = "generate" | "close" | "reset" | "status";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = body.action as Action;
    const date = body.date as string;

    if (!date?.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
    }

    switch (action) {
      case "generate":
        return NextResponse.json(await generateDemoData(date));
      case "close":
        return NextResponse.json(await closeDayData(date));
      case "reset":
        return NextResponse.json(await resetDayData(date));
      case "status":
        return NextResponse.json(await getDayStatus(date));
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Demo data error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

async function getDayStatus(date: string) {
  const [pkgs] = await pgQuery<{ total: string; assigned: string; delivered: string; absent: string; failed: string; pending: string; in_transit: string; loaded: string; returned: string }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ds.status = 'assigned') AS assigned,
       COUNT(*) FILTER (WHERE ds.status = 'delivered') AS delivered,
       COUNT(*) FILTER (WHERE ds.status = 'absent') AS absent,
       COUNT(*) FILTER (WHERE ds.status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE ds.status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE ds.status = 'in_transit') AS in_transit,
       COUNT(*) FILTER (WHERE ds.status = 'loaded') AS loaded,
       COUNT(*) FILTER (WHERE ds.status = 'returned') AS returned
     FROM packages p
     LEFT JOIN delivery_status ds ON ds.package_id = p.package_id AND ds.date = p.date
     WHERE p.date = $1`,
    [date]
  );
  const [driverCount] = await pgQuery<{ count: string }>(
    `SELECT COUNT(DISTINCT driver_id)::text AS count FROM delivery_status WHERE date = $1`,
    [date]
  );
  return {
    date,
    packages: parseInt(pkgs?.total || "0"),
    drivers: parseInt(driverCount?.count || "0"),
    breakdown: {
      pending: parseInt(pkgs?.pending || "0"),
      assigned: parseInt(pkgs?.assigned || "0"),
      loaded: parseInt(pkgs?.loaded || "0"),
      in_transit: parseInt(pkgs?.in_transit || "0"),
      delivered: parseInt(pkgs?.delivered || "0"),
      absent: parseInt(pkgs?.absent || "0"),
      failed: parseInt(pkgs?.failed || "0"),
      returned: parseInt(pkgs?.returned || "0"),
    },
  };
}

async function generateDemoData(date: string) {
  const existing = await pgQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM packages WHERE date = $1`, [date]
  );
  if (parseInt(existing[0]?.c || "0") > 0) {
    return { error: `${date} already has ${existing[0].c} packages. Use reset first.`, ok: false };
  }

  const dateShort = date.replace(/-/g, "").slice(4);

  await pgQuery(`
    INSERT INTO packages (
      package_id, depot_id, date, address, lat, lng, h3_index,
      time_window, weight, volume, is_redelivery, recipient_type,
      route_id, stop_order, loading_order, created_at
    )
    SELECT
      'PKG-' || $2 || '-' || LPAD(ROW_NUMBER() OVER (ORDER BY random())::text, 4, '0'),
      'DEPOT-TOYOSU', $1::date,
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
      NULL, NULL, NULL, NOW()
    FROM (
      SELECT DISTINCT ON (address) address, lat, lng, h3_index, recipient_type
      FROM packages
      WHERE date < $1::date
      ORDER BY address, random()
      LIMIT 490
    ) src
  `, [date, dateShort]);

  const drivers = await pgQuery<{ driver_id: string }>(
    `SELECT driver_id FROM drivers WHERE is_active ORDER BY driver_id`
  );
  const driverCount = drivers.length || 12;

  await pgQuery(`
    WITH base AS (
      SELECT package_id, ROW_NUMBER() OVER (ORDER BY random()) AS rn
      FROM packages WHERE date = $1::date
    ),
    assigned AS (
      SELECT package_id,
        (SELECT driver_id FROM drivers WHERE is_active ORDER BY driver_id OFFSET ((rn - 1) % $2) LIMIT 1) AS driver_id
      FROM base
    ),
    numbered AS (
      SELECT a.package_id, a.driver_id,
        ROW_NUMBER() OVER (PARTITION BY a.driver_id ORDER BY random()) AS stop_ord
      FROM assigned a
    )
    UPDATE packages p
    SET route_id = 'RT-' || n.driver_id || '-' || $3,
        stop_order = n.stop_ord,
        loading_order = n.stop_ord
    FROM numbered n
    WHERE p.package_id = n.package_id AND p.date = $1::date
  `, [date, driverCount, dateShort]);

  await pgQuery(`
    INSERT INTO routes (route_id, driver_id, depot_id, date, total_distance, total_time_est, stop_count, status, created_at)
    SELECT
      p.route_id,
      d.driver_id,
      'DEPOT-TOYOSU', $1::date,
      ROUND((15 + random() * 20)::numeric, 1),
      (180 + (random() * 120))::int,
      COUNT(*), 'planned', NOW()
    FROM packages p
    JOIN drivers d ON p.route_id LIKE '%' || d.driver_id || '%'
    WHERE p.date = $1::date AND p.route_id IS NOT NULL
    GROUP BY p.route_id, d.driver_id
    ON CONFLICT (route_id) DO NOTHING
  `, [date]);

  await pgQuery(`
    INSERT INTO delivery_status (
      package_id, driver_id, date, status, completed_at, is_absent, attempt_count, notes, updated_at, trip_number, stop_order
    )
    SELECT
      p.package_id,
      d.driver_id,
      $1::date, 'pending', NULL, false, 0, NULL, NOW(), 1, p.stop_order
    FROM packages p
    JOIN routes r ON r.route_id = p.route_id AND r.date = p.date
    JOIN drivers d ON d.driver_id = r.driver_id
    WHERE p.date = $1::date
    ON CONFLICT DO NOTHING
  `, [date]);

  return { ok: true, message: `Generated demo data for ${date}`, ...(await getDayStatus(date)) };
}

async function closeDayData(date: string) {
  const result = await pgQuery<{ updated: string }>(`
    WITH updated AS (
      UPDATE delivery_status
      SET status = 'delivered',
          completed_at = ($1::date + interval '8 hours') + (random() * interval '9 hours'),
          is_absent = false,
          attempt_count = GREATEST(attempt_count, 1),
          updated_at = NOW()
      WHERE date = $1::date AND status NOT IN ('delivered', 'returned')
      RETURNING 1
    )
    SELECT COUNT(*)::text AS updated FROM updated
  `, [date]);

  await pgQuery(`
    UPDATE routes SET status = 'completed' WHERE date = $1::date
  `, [date]);

  const updated = parseInt(result[0]?.updated || "0");
  return { ok: true, message: `Closed ${date}: ${updated} packages marked delivered`, ...(await getDayStatus(date)) };
}

async function resetDayData(date: string) {
  await pgQuery(`DELETE FROM delivery_dwell WHERE date = $1::date`, [date]);
  await pgQuery(`DELETE FROM delivery_status WHERE date = $1::date`, [date]);
  await pgQuery(`DELETE FROM routes WHERE date = $1::date`, [date]);
  await pgQuery(`DELETE FROM packages WHERE date = $1::date`, [date]);
  await pgQuery(`DELETE FROM traffic_realtime WHERE datetime::date = $1::date`, [date]);

  return { ok: true, message: `Reset all data for ${date}`, ...(await getDayStatus(date)) };
}
