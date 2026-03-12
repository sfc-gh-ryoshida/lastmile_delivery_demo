import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { TrafficRealtime } from "@/types";

export async function GET() {
  try {
    const rows = await pgQuery<TrafficRealtime>(
      `SELECT
        h3_index::text AS h3_index,
        datetime::text AS datetime,
        congestion_level,
        speed_ratio
      FROM traffic_realtime
      WHERE datetime > NOW() - INTERVAL '2 hours'
      ORDER BY datetime DESC`
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching traffic:", error);
    return NextResponse.json({ error: "Failed to fetch traffic" }, { status: 500 });
  }
}
