import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { DriverProgress } from "@/types";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const rows = await pgQuery<DriverProgress>(
      `SELECT
        d.driver_id,
        d.name,
        COUNT(ds.package_id)::int AS total_packages,
        COUNT(*) FILTER (WHERE ds.status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE ds.status = 'absent')::int AS absent,
        COUNT(*) FILTER (WHERE ds.status = 'in_transit')::int AS in_transit,
        ROUND(
          COUNT(*) FILTER (WHERE ds.status = 'delivered')::numeric
          / NULLIF(COUNT(ds.package_id), 0) * 100, 1
        )::float AS progress_pct,
        dl.lat AS current_lat,
        dl.lng AS current_lng,
        dl.speed AS current_speed
      FROM drivers d
      LEFT JOIN delivery_status ds ON ds.driver_id = d.driver_id AND ds.date = $1
      LEFT JOIN driver_locations dl ON dl.driver_id = d.driver_id
      WHERE d.is_active = true
      GROUP BY d.driver_id, d.name, dl.lat, dl.lng, dl.speed
      ORDER BY progress_pct ASC NULLS FIRST`,
      [date]
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching progress:", error);
    return NextResponse.json({ error: "Failed to fetch progress" }, { status: 500 });
  }
}
