import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date } = body as { date: string };

    if (!date) {
      return NextResponse.json({ error: "date is required" }, { status: 400 });
    }

    const preCheck = await pgQuery<{ status: string; cnt: number }>(
      `SELECT status, COUNT(*)::int AS cnt
       FROM delivery_status
       WHERE date = $1
       GROUP BY status
       ORDER BY status`,
      [date]
    );

    const returnedResult = await pgQuery<{ count: number }>(
      `WITH updated AS (
         UPDATE delivery_status
         SET status = 'returned', updated_at = NOW()
         WHERE date = $1
           AND status IN ('pending', 'assigned', 'loaded', 'in_transit', 'absent', 'failed')
         RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM updated`,
      [date]
    );

    const returnedCount = returnedResult[0]?.count ?? 0;

    await pgQuery(
      `UPDATE routes SET status = 'completed'
       WHERE date = $1 AND status NOT IN ('completed', 'cancelled')`,
      [date]
    );

    await pgQuery(
      `INSERT INTO driver_attendance (driver_id, date, status, check_out_time)
       SELECT DISTINCT ds.driver_id, $1, 'present', NOW()
       FROM delivery_status ds
       WHERE ds.date = $1 AND ds.driver_id IS NOT NULL
       ON CONFLICT (driver_id, date)
       DO UPDATE SET check_out_time = NOW()`,
      [date]
    );

    const summary = await pgQuery<{ status: string; cnt: number }>(
      `SELECT status, COUNT(*)::int AS cnt
       FROM delivery_status
       WHERE date = $1
       GROUP BY status
       ORDER BY status`,
      [date]
    );

    const byDriver = await pgQuery<{
      driver_id: string;
      name: string;
      delivered: number;
      returned: number;
      trips_completed: number;
    }>(
      `SELECT
         ds.driver_id,
         d.name,
         COUNT(*) FILTER (WHERE ds.status = 'delivered')::int AS delivered,
         COUNT(*) FILTER (WHERE ds.status = 'returned')::int AS returned,
         COALESCE(MAX(ds.trip_number), 1)::int AS trips_completed
       FROM delivery_status ds
       JOIN drivers d ON d.driver_id = ds.driver_id
       WHERE ds.date = $1 AND ds.driver_id IS NOT NULL
       GROUP BY ds.driver_id, d.name
       ORDER BY delivered DESC`,
      [date]
    );

    const statusMap = Object.fromEntries(summary.map((s) => [s.status, s.cnt]));
    const totalPackages = summary.reduce((s, r) => s + r.cnt, 0);
    const delivered = statusMap["delivered"] ?? 0;

    return NextResponse.json({
      date,
      total_packages: totalPackages,
      delivered,
      returned: returnedCount,
      absent: statusMap["absent"] ?? 0,
      failed: statusMap["failed"] ?? 0,
      delivery_rate: totalPackages > 0 ? Math.round((delivered / totalPackages) * 1000) / 10 : 0,
      status_breakdown: statusMap,
      pre_close_breakdown: Object.fromEntries(preCheck.map((s) => [s.status, s.cnt])),
      by_driver: byDriver,
    });
  } catch (error) {
    console.error("Error processing daily close:", error);
    return NextResponse.json({ error: "Failed to process daily close" }, { status: 500 });
  }
}
