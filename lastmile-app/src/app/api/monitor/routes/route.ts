import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface RouteStop {
  driver_id: string;
  name: string;
  stop_order: number;
  lat: number;
  lng: number;
  status: string;
  completed_at: string | null;
}

export interface RouteData {
  driver_id: string;
  name: string;
  color: [number, number, number];
  path: [number, number][];
  delivered: number;
  total: number;
  round: number;
  latest_completed_at: string | null;
}

const DRIVER_COLORS: [number, number, number][] = [
  [59, 130, 246],
  [34, 197, 94],
  [249, 115, 22],
  [168, 85, 247],
  [236, 72, 153],
  [20, 184, 166],
  [234, 179, 8],
  [239, 68, 68],
  [99, 102, 241],
  [6, 182, 212],
  [132, 204, 22],
  [244, 63, 94],
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const rows = await pgQuery<RouteStop>(
      `SELECT
         ds.driver_id,
         d.name,
         ROW_NUMBER() OVER(PARTITION BY ds.driver_id ORDER BY ds.completed_at NULLS LAST, p.package_id)::int AS stop_order,
         p.lat,
         p.lng,
         ds.status,
         ds.completed_at::text AS completed_at
       FROM delivery_status ds
       JOIN drivers d ON d.driver_id = ds.driver_id
       JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
       WHERE ds.date = $1
       ORDER BY ds.driver_id, stop_order`,
      [date]
    );

    const locRows = await pgQuery<{ driver_id: string; lat: number; lng: number }>(
      `SELECT dl.driver_id, dl.lat, dl.lng
       FROM driver_locations dl
       JOIN drivers d ON d.driver_id = dl.driver_id
       WHERE d.is_active = true`
    );
    const locMap = new Map(locRows.map((l) => [l.driver_id, l]));

    const grouped = new Map<string, { name: string; stops: RouteStop[] }>();
    for (const r of rows) {
      if (!grouped.has(r.driver_id)) {
        grouped.set(r.driver_id, { name: r.name, stops: [] });
      }
      grouped.get(r.driver_id)!.stops.push(r);
    }

    const routes: RouteData[] = [];
    let colorIdx = 0;
    for (const [driverId, { name, stops }] of grouped) {
      const loc = locMap.get(driverId);

      const rounds: RouteStop[][] = [];
      let currentRound: RouteStop[] = [];
      let lastCompleted: Date | null = null;

      for (const s of stops) {
        const ts = s.completed_at ? new Date(s.completed_at) : null;
        if (lastCompleted && ts && ts.getTime() - lastCompleted.getTime() > 60 * 60 * 1000) {
          if (currentRound.length > 0) rounds.push(currentRound);
          currentRound = [];
        }
        currentRound.push(s);
        if (ts) lastCompleted = ts;
      }
      if (currentRound.length > 0) rounds.push(currentRound);

      const baseColor = DRIVER_COLORS[colorIdx % DRIVER_COLORS.length];

      for (let ri = 0; ri < rounds.length; ri++) {
        const roundStops = rounds[ri];
        const path: [number, number][] = [];
        if (loc && ri === 0) {
          path.push([loc.lng, loc.lat]);
        }
        for (const s of roundStops) {
          path.push([s.lng, s.lat]);
        }
        if (path.length >= 2) {
          const delivered = roundStops.filter((s) => s.status === "delivered").length;
          const completedTimes = roundStops
            .map((s) => s.completed_at)
            .filter(Boolean) as string[];
          routes.push({
            driver_id: driverId,
            name,
            color: baseColor,
            path,
            delivered,
            total: roundStops.length,
            round: ri + 1,
            latest_completed_at: completedTimes.length > 0
              ? completedTimes[completedTimes.length - 1]
              : null,
          });
        }
      }
      colorIdx++;
    }

    return NextResponse.json(routes);
  } catch (error) {
    console.error("Error fetching routes:", error);
    return NextResponse.json({ error: "Failed to fetch routes" }, { status: 500 });
  }
}
