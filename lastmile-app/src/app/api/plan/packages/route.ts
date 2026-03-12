import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const rows = await pgQuery(
      `SELECT
        p.package_id,
        p.address,
        p.lat,
        p.lng,
        p.h3_index::text AS h3_index,
        p.time_window,
        p.weight,
        p.is_redelivery,
        p.route_id,
        p.stop_order,
        ds.driver_id,
        d.name AS driver_name,
        ds.status
      FROM packages p
      LEFT JOIN delivery_status ds ON ds.package_id = p.package_id AND ds.date = p.date
      LEFT JOIN drivers d ON d.driver_id = ds.driver_id
      WHERE p.date = $1
      ORDER BY p.time_window, p.package_id`,
      [date]
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching packages:", error);
    return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 });
  }
}
