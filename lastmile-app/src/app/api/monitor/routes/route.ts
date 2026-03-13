import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface RouteStop {
  driver_id: string;
  name: string;
  trip_number: number;
  stop_order: number;
  lat: number;
  lng: number;
  status: string;
  completed_at: string | null;
}

interface RouteRow {
  route_id: string;
  driver_id: string;
  trip_number: number;
  route_geometry: [number, number][] | null;
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
         COALESCE(ds.trip_number, 1) AS trip_number,
         COALESCE(ds.stop_order,
           ROW_NUMBER() OVER(PARTITION BY ds.driver_id ORDER BY ds.completed_at NULLS LAST, p.package_id)
         )::int AS stop_order,
         p.lat,
         p.lng,
         ds.status,
         ds.completed_at::text AS completed_at
       FROM delivery_status ds
       JOIN drivers d ON d.driver_id = ds.driver_id
       JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
       WHERE ds.date = $1
         AND ds.status IN ('assigned', 'loaded', 'in_transit', 'delivered')
       ORDER BY ds.driver_id, COALESCE(ds.trip_number, 1), stop_order`,
      [date]
    );

    const routeRows = await pgQuery<RouteRow>(
      `SELECT route_id, driver_id,
         CAST(SUBSTRING(route_id FROM 'T([0-9]+)$') AS int) AS trip_number,
         route_geometry
       FROM routes
       WHERE date = $1 AND route_geometry IS NOT NULL`,
      [date]
    );
    const geoMap = new Map<string, [number, number][]>();
    for (const r of routeRows) {
      const key = `${r.driver_id}-${r.trip_number}`;
      const geo = typeof r.route_geometry === "string"
        ? JSON.parse(r.route_geometry)
        : r.route_geometry;
      if (Array.isArray(geo) && geo.length > 0) {
        geoMap.set(key, geo);
      }
    }

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

      const rounds = new Map<number, RouteStop[]>();
      for (const s of stops) {
        const trip = s.trip_number;
        if (!rounds.has(trip)) rounds.set(trip, []);
        rounds.get(trip)!.push(s);
      }
      const roundEntries = [...rounds.entries()].sort((a, b) => a[0] - b[0]);

      const baseColor = DRIVER_COLORS[colorIdx % DRIVER_COLORS.length];

      for (let ri = 0; ri < roundEntries.length; ri++) {
        const [tripNum, roundStops] = roundEntries[ri];
        const geoKey = `${driverId}-${tripNum}`;
        const savedGeometry = geoMap.get(geoKey);

        let path: [number, number][];
        if (savedGeometry && savedGeometry.length >= 2) {
          path = savedGeometry;
        } else {
          path = [];
          if (loc && ri === 0) {
            path.push([loc.lng, loc.lat]);
          }
          for (const s of roundStops) {
            path.push([s.lng, s.lat]);
          }
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
            round: tripNum,
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
