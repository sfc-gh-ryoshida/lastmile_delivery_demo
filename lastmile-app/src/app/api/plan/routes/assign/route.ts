import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface AssignMove {
  package_id: string;
  from_driver_id?: string | null;
  to_driver_id: string;
  trip_number?: number;
  trip?: number;
  stop_order?: number;
}

interface RouteGeometry {
  route_id: string;
  geometry: [number, number][];
}

interface AssignRequest {
  date: string;
  moves: AssignMove[];
  route_geometries?: RouteGeometry[];
}

const BATCH_SIZE = 200;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AssignRequest;
    const { date, moves } = body;

    if (!date || !moves || moves.length === 0) {
      return NextResponse.json({ error: "date and moves are required" }, { status: 400 });
    }

    const existingRows = await pgQuery<{ package_id: string; status: string }>(
      `SELECT package_id, status FROM delivery_status WHERE date = $1`,
      [date]
    );
    const existingMap = new Map(existingRows.map((r) => [r.package_id, r.status]));

    const skipped: { package_id: string; error: string }[] = [];
    const toInsert: AssignMove[] = [];
    const toUpdate: AssignMove[] = [];

    for (const move of moves) {
      const tripNum = move.trip_number ?? move.trip ?? 1;
      const m = { ...move, trip_number: tripNum };
      const status = existingMap.get(move.package_id);

      if (status === "delivered" || status === "in_transit") {
        skipped.push({ package_id: move.package_id, error: `Cannot reassign: status is ${status}` });
        continue;
      }

      if (status === undefined) {
        toInsert.push(m);
      } else {
        toUpdate.push(m);
      }
    }

    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const vals = batch.map((_, j) => {
        const b = j * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}::date, 'assigned', false, 0, $${b + 4}::int, $${b + 5}::int)`;
      }).join(", ");
      await pgQuery(
        `INSERT INTO delivery_status (package_id, driver_id, date, status, is_absent, attempt_count, trip_number, stop_order)
         VALUES ${vals}
         ON CONFLICT (package_id, date) DO UPDATE SET
           driver_id = EXCLUDED.driver_id, status = 'assigned', trip_number = EXCLUDED.trip_number,
           stop_order = EXCLUDED.stop_order, updated_at = NOW()`,
        batch.flatMap((m) => [m.package_id, m.to_driver_id, date, m.trip_number, m.stop_order ?? null])
      );
    }

    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + BATCH_SIZE);
      const vals = batch.map((_, j) => {
        const b = j * 4;
        return `($${b + 1}, $${b + 2}, $${b + 3}::int, $${b + 4}::int)`;
      }).join(", ");
      await pgQuery(
        `UPDATE delivery_status ds
         SET driver_id = v.driver_id, trip_number = v.trip_number, stop_order = v.stop_order,
             status = 'assigned', updated_at = NOW()
         FROM (VALUES ${vals}) AS v(package_id, driver_id, trip_number, stop_order)
         WHERE ds.package_id = v.package_id AND ds.date = $${batch.length * 4 + 1}`,
        [...batch.flatMap((m) => [m.package_id, m.to_driver_id, m.trip_number, m.stop_order ?? null]), date]
      );
    }

    const allValid = [...toInsert, ...toUpdate];
    for (let i = 0; i < allValid.length; i += BATCH_SIZE) {
      const batch = allValid.slice(i, i + BATCH_SIZE);
      const vals = batch.map((_, j) => {
        const b = j * 3;
        return `($${b + 1}, $${b + 2}, $${b + 3}::int)`;
      }).join(", ");
      await pgQuery(
        `UPDATE packages p
         SET route_id = v.route_id, stop_order = v.stop_order
         FROM (VALUES ${vals}) AS v(package_id, route_id, stop_order)
         WHERE p.package_id = v.package_id`,
        batch.flatMap((m) => {
          const tripNum = m.trip_number ?? m.trip ?? 1;
          const routeId = `R-${m.to_driver_id}-${date}-T${tripNum}`;
          return [m.package_id, routeId, m.stop_order ?? null];
        })
      );
    }

    const geoMap = new Map<string, [number, number][]>();
    if (body.route_geometries) {
      for (const rg of body.route_geometries) {
        geoMap.set(rg.route_id, rg.geometry);
      }
    }

    const uniqueRoutes = new Map<string, string>();
    for (const m of allValid) {
      const tripNum = m.trip_number ?? m.trip ?? 1;
      const routeId = `R-${m.to_driver_id}-${date}-T${tripNum}`;
      uniqueRoutes.set(routeId, m.to_driver_id);
    }
    const routeEntries = [...uniqueRoutes.entries()];
    for (let i = 0; i < routeEntries.length; i += BATCH_SIZE) {
      const batch = routeEntries.slice(i, i + BATCH_SIZE);
      const vals = batch.map((_, j) => {
        const b = j * 4;
        return `($${b + 1}, $${b + 2}, $${b + 3}::date, $${b + 4}::jsonb)`;
      }).join(", ");
      await pgQuery(
        `INSERT INTO routes (route_id, driver_id, depot_id, date, stop_count, status, route_geometry)
         SELECT v.route_id, v.driver_id, d.depot_id, v.date, 0, 'planned', v.geo
         FROM (VALUES ${vals}) AS v(route_id, driver_id, date, geo)
         JOIN drivers d ON d.driver_id = v.driver_id
         ON CONFLICT (route_id) DO UPDATE SET route_geometry = EXCLUDED.route_geometry`,
        batch.flatMap(([routeId, driverId]) => [
          routeId,
          driverId,
          date,
          geoMap.has(routeId) ? JSON.stringify(geoMap.get(routeId)) : null,
        ])
      );
    }

    const successCount = toInsert.length + toUpdate.length;
    return NextResponse.json({
      total: moves.length,
      success: successCount,
      failed: skipped.length,
      results: [
        ...Array.from({ length: successCount }, (_, i) => ({
          package_id: allValid[i].package_id,
          success: true,
        })),
        ...skipped.map((s) => ({
          package_id: s.package_id,
          success: false,
          error: s.error,
        })),
      ],
    });
  } catch (error) {
    console.error("Error assigning routes:", error);
    return NextResponse.json({ error: "Failed to assign routes" }, { status: 500 });
  }
}
