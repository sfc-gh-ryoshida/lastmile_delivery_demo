import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { RoadConstruction } from "@/types";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const rows = await pgQuery<RoadConstruction>(
      `SELECT construction_id, h3_index::text AS h3_index, center_lat, center_lng,
              radius_m, start_date, end_date, restriction_type, description
         FROM road_construction
         WHERE start_date <= $1 AND (end_date IS NULL OR end_date >= $1)`,
      [date]
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching construction:", error);
    return NextResponse.json({ error: "Failed to fetch construction" }, { status: 500 });
  }
}
