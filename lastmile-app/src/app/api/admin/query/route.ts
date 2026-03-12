import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

const ALLOWED_TABLES = new Set([
  "drivers", "packages", "delivery_status", "routes",
  "driver_locations", "traffic_realtime", "road_construction", "depots",
]);

export async function POST(request: Request) {
  try {
    const { table, limit } = await request.json();
    if (!table || !ALLOWED_TABLES.has(table)) {
      return NextResponse.json({ error: "Invalid table" }, { status: 400 });
    }
    const lim = Math.min(parseInt(limit) || 50, 200);
    const rows = await pgQuery(`SELECT * FROM ${table} LIMIT $1`, [lim]);

    const colRows = await pgQuery<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );

    return NextResponse.json({ columns: colRows, rows, total: rows.length });
  } catch (error) {
    console.error("Error querying table:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
