import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const rows = await pgQuery(
      `SELECT
        d.driver_id,
        d.name,
        d.area_assignment,
        COUNT(ds.package_id)::int AS total,
        COUNT(*) FILTER (WHERE ds.status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE ds.status = 'absent')::int AS absent,
        ROUND(
          COUNT(*) FILTER (WHERE ds.status = 'delivered')::numeric
          / NULLIF(COUNT(ds.package_id), 0) * 100, 1
        )::float AS completion_rate,
        r.total_distance,
        r.total_time_est
      FROM drivers d
      LEFT JOIN delivery_status ds ON ds.driver_id = d.driver_id AND ds.date = $1
      LEFT JOIN routes r ON r.driver_id = d.driver_id AND r.date = $1
      WHERE d.is_active = true
      GROUP BY d.driver_id, d.name, d.area_assignment, r.total_distance, r.total_time_est
      ORDER BY completion_rate DESC NULLS LAST`,
      [date]
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching driver performance:", error);
    return NextResponse.json({ error: "Failed to fetch driver performance" }, { status: 500 });
  }
}
