import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { TrafficRealtime } from "@/types";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const res = parseInt(searchParams.get("resolution") || "10");
  const resolution = [7, 8, 9, 10, 11].includes(res) ? res : 10;

  try {
    const sql =
      resolution === 7
        ? `SELECT
            h3_index::text AS h3_index,
            datetime::text AS datetime,
            congestion_level,
            speed_ratio
          FROM traffic_realtime
          WHERE datetime > NOW() - INTERVAL '2 hours'
          ORDER BY datetime DESC`
        : `SELECT
            h3_cell_to_children(h3_index::h3index, ${resolution})::text AS h3_index,
            datetime::text AS datetime,
            congestion_level,
            speed_ratio
          FROM traffic_realtime
          WHERE datetime > NOW() - INTERVAL '2 hours'
          ORDER BY datetime DESC`;
    const rows = await pgQuery<TrafficRealtime>(sql);
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching traffic:", error);
    return NextResponse.json({ error: "Failed to fetch traffic" }, { status: 500 });
  }
}
