import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, driver_id, trip_number } = body as {
      date: string;
      driver_id: string;
      trip_number: number;
    };

    if (!date || !driver_id || trip_number == null) {
      return NextResponse.json(
        { error: "date, driver_id, and trip_number are required" },
        { status: 400 }
      );
    }

    const result = await pgQuery<{ count: number }>(
      `WITH updated AS (
         UPDATE delivery_status
         SET status = 'loaded', updated_at = NOW()
         WHERE driver_id = $1 AND date = $2 AND trip_number = $3 AND status = 'assigned'
         RETURNING package_id, stop_order
       )
       SELECT COUNT(*)::int AS count FROM updated`,
      [driver_id, date, trip_number]
    );

    const updatedCount = result[0]?.count ?? 0;

    if (updatedCount > 0) {
      await pgQuery(
        `UPDATE packages p
         SET loading_order = ds.stop_order
         FROM delivery_status ds
         WHERE ds.package_id = p.package_id
           AND ds.date = $1
           AND ds.driver_id = $2
           AND ds.trip_number = $3
           AND ds.status = 'loaded'`,
        [date, driver_id, trip_number]
      );

      const routeId = `R-${driver_id}-${date}-T${trip_number}`;
      await pgQuery(
        `UPDATE routes SET status = 'loaded' WHERE route_id = $1 AND status IN ('planned', 'loading')`,
        [routeId]
      );
    }

    return NextResponse.json({
      driver_id,
      date,
      trip_number,
      loaded_count: updatedCount,
    });
  } catch (error) {
    console.error("Error confirming load:", error);
    return NextResponse.json({ error: "Failed to confirm load" }, { status: 500 });
  }
}
