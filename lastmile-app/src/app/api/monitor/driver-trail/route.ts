import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface TrailPoint {
  driver_id: string;
  lat: number;
  lng: number;
  speed: number;
  timestamp: number;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];
  const driverId = searchParams.get("driver_id");

  try {
    const whereDriver = driverId ? "AND dlh.driver_id = $2" : "";
    const params: unknown[] = [date];
    if (driverId) params.push(driverId);

    const rows = await pgQuery<TrailPoint>(
      `SELECT
        dlh.driver_id,
        dlh.lat,
        dlh.lng,
        dlh.speed,
        EXTRACT(EPOCH FROM dlh.recorded_at)::bigint AS timestamp
      FROM driver_locations_history dlh
      JOIN drivers d ON d.driver_id = dlh.driver_id AND d.is_active = true
      WHERE dlh.recorded_at::date = $1 ${whereDriver}
      ORDER BY dlh.driver_id, dlh.recorded_at`,
      params
    );

    const grouped: Record<string, { path: [number, number, number][]; timestamps: number[] }> = {};
    for (const r of rows) {
      if (!grouped[r.driver_id]) {
        grouped[r.driver_id] = { path: [], timestamps: [] };
      }
      grouped[r.driver_id].path.push([Number(r.lng), Number(r.lat), 0]);
      grouped[r.driver_id].timestamps.push(Number(r.timestamp));
    }

    const trails = Object.entries(grouped).map(([driver_id, data]) => ({
      driver_id,
      path: data.path,
      timestamps: data.timestamps,
    }));

    return NextResponse.json(trails);
  } catch (error) {
    console.error("Error fetching driver trail:", error);
    return NextResponse.json({ error: "Failed to fetch trail" }, { status: 500 });
  }
}
