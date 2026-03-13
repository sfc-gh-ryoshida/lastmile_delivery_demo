import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface RouteRow {
  route_id: string;
  driver_id: string;
  trip_number: number;
  route_geometry: [number, number][] | null;
}

interface StopRow {
  package_id: string;
  driver_id: string;
  trip_number: number;
  stop_order: number;
  address: string;
  lat: number;
  lng: number;
  weight: number;
  volume: number;
  time_window: string | null;
  is_redelivery: boolean;
  recipient_type: string;
  risk_score: number | null;
  eta: string | null;
}

interface DriverRow {
  driver_id: string;
  name: string;
  shift_start: string;
  shift_end: string;
  depot_lat: number;
  depot_lng: number;
  depot_name: string;
  vehicle_capacity: number;
  vehicle_volume: number;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const routeRows = await pgQuery<RouteRow>(
      `SELECT route_id, driver_id,
         CAST(SUBSTRING(route_id FROM 'T([0-9]+)$') AS int) AS trip_number,
         route_geometry
       FROM routes
       WHERE date = $1 AND route_id LIKE 'R-%'`,
      [date]
    );

    if (routeRows.length === 0) {
      return NextResponse.json({ confirmed: false, assignments: [] });
    }

    const stopRows = await pgQuery<StopRow>(
      `SELECT ds.package_id, ds.driver_id, COALESCE(ds.trip_number, 1) AS trip_number,
         COALESCE(ds.stop_order, 0) AS stop_order,
         p.address, p.lat, p.lng, p.weight, p.volume,
         p.time_window, p.is_redelivery, p.recipient_type,
         NULL::numeric AS risk_score, NULL::text AS eta
       FROM delivery_status ds
       JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
       WHERE ds.date = $1 AND ds.status IN ('assigned', 'loaded', 'in_transit', 'delivered')
       ORDER BY ds.driver_id, ds.trip_number, ds.stop_order`,
      [date]
    );

    const driverRows = await pgQuery<DriverRow>(
      `SELECT d.driver_id, d.name, d.shift_start::text, d.shift_end::text,
         dep.lat AS depot_lat, dep.lng AS depot_lng, dep.name AS depot_name,
         d.vehicle_capacity, d.vehicle_volume
       FROM drivers d
       JOIN depots dep ON dep.depot_id = d.depot_id
       WHERE d.is_active = true`,
      []
    );
    const driverMap = new Map(driverRows.map((d) => [d.driver_id, d]));

    const geoMap = new Map<string, [number, number][]>();
    for (const r of routeRows) {
      const key = `${r.driver_id}-${r.trip_number}`;
      const geo = typeof r.route_geometry === "string"
        ? JSON.parse(r.route_geometry)
        : r.route_geometry;
      if (Array.isArray(geo)) geoMap.set(key, geo);
    }

    const driverTrips = new Map<string, Map<number, StopRow[]>>();
    for (const s of stopRows) {
      if (!driverTrips.has(s.driver_id)) driverTrips.set(s.driver_id, new Map());
      const trips = driverTrips.get(s.driver_id)!;
      if (!trips.has(s.trip_number)) trips.set(s.trip_number, []);
      trips.get(s.trip_number)!.push(s);
    }

    const assignments = [];
    for (const [driverId, trips] of driverTrips) {
      const dInfo = driverMap.get(driverId);
      if (!dInfo) continue;
      const tripEntries = [...trips.entries()].sort((a, b) => a[0] - b[0]);
      const tripResults = tripEntries.map(([tripNum, stops]) => {
        const geoKey = `${driverId}-${tripNum}`;
        const geometry = geoMap.get(geoKey) || stops.map((s) => [s.lng, s.lat] as [number, number]);
        return {
          trip: tripNum,
          packages: stops.map((s) => ({
            package_id: s.package_id,
            stop_order: s.stop_order,
            address: s.address,
            weight: s.weight,
            volume: s.volume,
            time_window: s.time_window,
            is_redelivery: s.is_redelivery,
            recipient_type: s.recipient_type,
            delivery_method: "face_to_face",
            risk_score: s.risk_score,
            lat: s.lat,
            lng: s.lng,
            eta: s.eta || "",
          })),
          total_weight: stops.reduce((s, p) => s + Number(p.weight), 0),
          total_volume: stops.reduce((s, p) => s + Number(p.volume), 0),
          total_packages: stops.length,
          departure_time: "",
          return_time: "",
          route: geometry.map((pt) => ({ lat: pt[1], lng: pt[0] })),
        };
      });

      const allRoute = tripResults.flatMap((t) => t.route);
      const totalPkgs = tripResults.reduce((s, t) => s + t.total_packages, 0);
      const totalWt = tripResults.reduce((s, t) => s + t.total_weight, 0);
      const totalVol = tripResults.reduce((s, t) => s + t.total_volume, 0);

      assignments.push({
        driver_id: driverId,
        driver_name: dInfo.name,
        shift_start: dInfo.shift_start,
        shift_end: dInfo.shift_end,
        depot: { lat: dInfo.depot_lat, lng: dInfo.depot_lng, name: dInfo.depot_name },
        trips: tripResults,
        total_packages: totalPkgs,
        total_weight: totalWt,
        total_volume: totalVol,
        capacity_pct: dInfo.vehicle_capacity ? Math.round((totalWt / dInfo.vehicle_capacity) * 100) : 0,
        volume_pct: dInfo.vehicle_volume ? Math.round((totalVol / dInfo.vehicle_volume) * 100) : 0,
        route: allRoute,
      });
    }

    return NextResponse.json({
      confirmed: true,
      date,
      total_packages: stopRows.length,
      assigned_packages: stopRows.length,
      unassigned_packages: 0,
      drivers_used: assignments.length,
      assignments,
    });
  } catch (error) {
    console.error("Error fetching confirmed routes:", error);
    return NextResponse.json({ error: "Failed to fetch confirmed routes" }, { status: 500 });
  }
}
