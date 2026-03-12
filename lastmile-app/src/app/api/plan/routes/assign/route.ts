import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface AssignRequest {
  date: string;
  moves: {
    package_id: string;
    from_driver_id: string | null;
    to_driver_id: string;
    trip_number?: number;
    stop_order?: number;
  }[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AssignRequest;
    const { date, moves } = body;

    if (!date || !moves || moves.length === 0) {
      return NextResponse.json({ error: "date and moves are required" }, { status: 400 });
    }

    const results: { package_id: string; success: boolean; error?: string }[] = [];

    for (const move of moves) {
      try {
        const tripNum = move.trip_number ?? 1;
        const stopOrd = move.stop_order ?? null;
        const routeId = `R-${move.to_driver_id}-${date}-T${tripNum}`;

        const existing = await pgQuery<{ driver_id: string | null; status: string }>(
          `SELECT driver_id, status FROM delivery_status
           WHERE package_id = $1 AND date = $2`,
          [move.package_id, date]
        );

        if (existing.length === 0) {
          await pgQuery(
            `INSERT INTO delivery_status (package_id, driver_id, date, status, is_absent, attempt_count, trip_number, stop_order)
             VALUES ($1, $2, $3, 'assigned', false, 0, $4, $5)`,
            [move.package_id, move.to_driver_id, date, tripNum, stopOrd]
          );
        } else {
          const current = existing[0];
          if (current.status === "delivered" || current.status === "in_transit") {
            results.push({
              package_id: move.package_id,
              success: false,
              error: `Cannot reassign: status is ${current.status}`,
            });
            continue;
          }

          await pgQuery(
            `UPDATE delivery_status
             SET driver_id = $1, status = 'assigned', trip_number = $2, stop_order = $3, updated_at = NOW()
             WHERE package_id = $4 AND date = $5`,
            [move.to_driver_id, tripNum, stopOrd, move.package_id, date]
          );
        }

        await pgQuery(
          `UPDATE packages SET route_id = $1, stop_order = $2 WHERE package_id = $3`,
          [routeId, stopOrd, move.package_id]
        );

        await pgQuery(
          `INSERT INTO routes (route_id, driver_id, depot_id, date, stop_count, status)
           SELECT $1, $2, d.depot_id, $3, 0, 'planned'
           FROM drivers d WHERE d.driver_id = $2
           ON CONFLICT (route_id) DO NOTHING`,
          [routeId, move.to_driver_id, date]
        );

        results.push({ package_id: move.package_id, success: true });
      } catch (err) {
        results.push({
          package_id: move.package_id,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({
      total: moves.length,
      success: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (error) {
    console.error("Error assigning routes:", error);
    return NextResponse.json({ error: "Failed to assign routes" }, { status: 500 });
  }
}
