import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, updates } = body as {
      date: string;
      updates: { driver_id: string; is_active: boolean }[];
    };

    if (!date || !updates || updates.length === 0) {
      return NextResponse.json({ error: "date and updates are required" }, { status: 400 });
    }

    const results: { driver_id: string; is_active: boolean; success: boolean }[] = [];

    for (const u of updates) {
      try {
        await pgQuery(
          `UPDATE drivers SET is_active = $1 WHERE driver_id = $2`,
          [u.is_active, u.driver_id]
        );

        const status = u.is_active ? "present" : "absent";
        await pgQuery(
          `INSERT INTO driver_attendance (driver_id, date, status, check_in_time)
           VALUES ($1, $2, $3, CASE WHEN $3 = 'present' THEN NOW() ELSE NULL END)
           ON CONFLICT (driver_id, date)
           DO UPDATE SET status = $3,
             check_in_time = CASE WHEN $3 = 'present' AND driver_attendance.check_in_time IS NULL THEN NOW() ELSE driver_attendance.check_in_time END`,
          [u.driver_id, date, status]
        );

        results.push({ driver_id: u.driver_id, is_active: u.is_active, success: true });
      } catch (err) {
        console.error(`Failed to update driver ${u.driver_id}:`, err);
        results.push({ driver_id: u.driver_id, is_active: u.is_active, success: false });
      }
    }

    return NextResponse.json({
      date,
      updated: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (error) {
    console.error("Error updating driver attendance:", error);
    return NextResponse.json({ error: "Failed to update attendance" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const drivers = await pgQuery<{
      driver_id: string;
      name: string;
      is_active: boolean;
      depot_name: string;
    }>(
      `SELECT d.driver_id, d.name, d.is_active, dp.name AS depot_name
       FROM drivers d
       JOIN depots dp ON dp.depot_id = d.depot_id
       ORDER BY d.driver_id`
    );

    return NextResponse.json({ drivers });
  } catch (error) {
    console.error("Error fetching driver attendance:", error);
    return NextResponse.json({ error: "Failed to fetch attendance" }, { status: 500 });
  }
}
