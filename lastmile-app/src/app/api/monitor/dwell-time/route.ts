import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface DwellSummary {
  driver_id: string;
  name: string;
  total_deliveries: number;
  avg_dwell: number;
  max_dwell: number;
  total_dwell_minutes: number;
  apartment_avg: number | null;
  office_avg: number | null;
  house_avg: number | null;
  long_dwell_count: number;
}

interface DwellDetail {
  package_id: string;
  location_type: string;
  dwell_seconds: number;
  lat: number;
  lng: number;
  floor_number: number | null;
  has_elevator: boolean;
  arrived_at: string;
  notes: string | null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];
  const driverId = searchParams.get("driver_id");

  try {
    if (driverId) {
      const rows = await pgQuery<DwellDetail>(
        `SELECT
          dd.package_id,
          dd.location_type,
          dd.dwell_seconds,
          dd.lat, dd.lng,
          dd.floor_number,
          dd.has_elevator,
          dd.arrived_at::text AS arrived_at,
          dd.notes
        FROM delivery_dwell dd
        WHERE dd.driver_id = $1 AND dd.date = $2
        ORDER BY dd.arrived_at`,
        [driverId, date]
      );
      return NextResponse.json(rows);
    }

    const rows = await pgQuery<DwellSummary>(
      `SELECT
        d.driver_id,
        d.name,
        COUNT(dd.id)::int AS total_deliveries,
        ROUND(AVG(dd.dwell_seconds))::int AS avg_dwell,
        MAX(dd.dwell_seconds)::int AS max_dwell,
        ROUND(SUM(dd.dwell_seconds) / 60.0, 1)::float AS total_dwell_minutes,
        ROUND(AVG(dd.dwell_seconds) FILTER (WHERE dd.location_type = 'apartment'))::int AS apartment_avg,
        ROUND(AVG(dd.dwell_seconds) FILTER (WHERE dd.location_type = 'office'))::int AS office_avg,
        ROUND(AVG(dd.dwell_seconds) FILTER (WHERE dd.location_type = 'house'))::int AS house_avg,
        COUNT(*) FILTER (WHERE dd.dwell_seconds > 180)::int AS long_dwell_count
      FROM drivers d
      LEFT JOIN delivery_dwell dd ON dd.driver_id = d.driver_id AND dd.date = $1
      WHERE d.is_active = true
      GROUP BY d.driver_id, d.name
      ORDER BY avg_dwell DESC NULLS LAST`,
      [date]
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching dwell time:", error);
    return NextResponse.json({ error: "Failed to fetch dwell time" }, { status: 500 });
  }
}
