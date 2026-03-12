import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { Driver } from "@/types";

export async function GET() {
  try {
    const rows = await pgQuery<Driver>(
      `SELECT driver_id, depot_id, name, vehicle_type, vehicle_capacity,
              vehicle_volume, skill_level, area_assignment, is_active
       FROM drivers
       WHERE is_active = true
       ORDER BY driver_id`
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching drivers:", error);
    return NextResponse.json({ error: "Failed to fetch drivers" }, { status: 500 });
  }
}
