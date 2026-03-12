import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { DriverLocation } from "@/types";

export async function GET() {
  try {
    const rows = await pgQuery<DriverLocation>(
      `SELECT
        dl.driver_id,
        dl.lat,
        dl.lng,
        dl.h3_index::text AS h3_index,
        dl.speed,
        dl.heading,
        dl.timestamp::text AS timestamp
      FROM driver_locations dl
      JOIN drivers d ON d.driver_id = dl.driver_id
      WHERE d.is_active = true`
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching locations:", error);
    return NextResponse.json({ error: "Failed to fetch locations" }, { status: 500 });
  }
}
