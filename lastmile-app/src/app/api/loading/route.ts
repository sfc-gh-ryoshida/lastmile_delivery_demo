import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface LoadingItem {
  package_id: string;
  driver_id: string;
  driver_name: string;
  trip_number: number;
  stop_order: number;
  loading_order: number;
  address: string;
  weight: number;
  volume: number;
  time_window: string | null;
  recipient_type: string;
  is_redelivery: boolean;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];
  const driverId = searchParams.get("driver_id");

  try {
    let whereExtra = "";
    const params: (string | null)[] = [date];
    if (driverId) {
      whereExtra = " AND ds.driver_id = $2";
      params.push(driverId);
    }

    const rows = await pgQuery<LoadingItem>(
      `SELECT
         p.package_id,
         ds.driver_id,
         d.name AS driver_name,
         ds.trip_number,
         ds.stop_order,
         (MAX(ds.stop_order) OVER(PARTITION BY ds.driver_id, ds.trip_number) - ds.stop_order + 1)::int AS loading_order,
         p.address,
         p.weight,
         p.volume,
         p.time_window,
         p.recipient_type,
         p.is_redelivery
       FROM delivery_status ds
       JOIN drivers d ON d.driver_id = ds.driver_id
       JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
       WHERE ds.date = $1
         AND ds.status IN ('assigned', 'loaded')
         ${whereExtra}
       ORDER BY ds.driver_id, ds.trip_number, loading_order`,
      params
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching loading order:", error);
    return NextResponse.json({ error: "Failed to fetch loading order" }, { status: 500 });
  }
}
