import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import { query as sfQuery } from "@/lib/snowflake";

interface RemainingStop {
  package_id: string;
  lat: number;
  lng: number;
  time_window: string | null;
  is_redelivery: boolean;
  risk_score: number | null;
  status: string;
  trip_number: number;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseTimeWindow(tw: string | null): { start: number; end: number } | null {
  if (!tw) return null;
  const match = tw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const [h1, m1] = match[1].split(":").map(Number);
  const [h2, m2] = match[2].split(":").map(Number);
  return { start: h1 * 60 + (m1 || 0), end: h2 * 60 + (m2 || 0) };
}

function minutesToTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, driver_id, skip_absent = true, confirm = false, trip_number } = body as {
      date: string;
      driver_id: string;
      skip_absent?: boolean;
      confirm?: boolean;
      trip_number?: number;
    };

    if (!date || !driver_id) {
      return NextResponse.json({ error: "date and driver_id are required" }, { status: 400 });
    }

    const tripFilter = trip_number != null
      ? `AND ds.trip_number = ${Number(trip_number)}`
      : "";

    const locRows = await pgQuery<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM driver_locations WHERE driver_id = $1`,
      [driver_id]
    );
    const currentLat = locRows.length > 0 ? locRows[0].lat : 35.6466;
    const currentLng = locRows.length > 0 ? locRows[0].lng : 139.7828;

    const remaining = await pgQuery<RemainingStop>(
      `SELECT
         ds.package_id, p.lat, p.lng, p.time_window, p.is_redelivery, ds.status,
         COALESCE(ds.trip_number, 1) AS trip_number,
         NULL::float AS risk_score
       FROM delivery_status ds
       JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
       WHERE ds.date = $1 AND ds.driver_id = $2
         AND ds.status NOT IN ('delivered')
         ${tripFilter}
       ORDER BY ds.package_id`,
      [date, driver_id]
    );

    try {
      const currentHour = new Date().getHours();
      const riskRows = await sfQuery<{ H3_INDEX: string; RISK_SCORE: number }>(
        `SELECT H3_INDEX, RISK_SCORE FROM ANALYTICS.RISK_SCORES WHERE DATE = ? AND HOUR = ?`,
        [date, currentHour]
      );
      const riskMap = new Map(riskRows.map((r) => [r.H3_INDEX, r.RISK_SCORE]));
      const pkgH3 = await pgQuery<{ package_id: string; h3_index: string }>(
        `SELECT p.package_id, p.h3_index::text AS h3_index FROM packages p WHERE p.date = $1`,
        [date]
      );
      const h3Map = new Map(pkgH3.map((r) => [r.package_id, r.h3_index]));
      for (const r of remaining) {
        const h3 = h3Map.get(r.package_id);
        if (h3) r.risk_score = riskMap.get(h3) ?? null;
      }
    } catch (e) {
      console.warn("Risk scores unavailable for readjust:", (e as Error).message);
    }

    let toSequence = remaining;
    if (skip_absent) {
      const highRisk = remaining.filter(
        (r) => r.status === "absent" || (r.risk_score !== null && r.risk_score > 0.7)
      );
      const normal = remaining.filter(
        (r) => r.status !== "absent" && (r.risk_score === null || r.risk_score <= 0.7)
      );
      toSequence = [...normal, ...highRisk];
    }

    const timeWindowStops = toSequence.filter((s) => s.time_window);
    const otherStops = toSequence.filter((s) => !s.time_window);

    const twSorted = timeWindowStops.sort((a, b) =>
      (a.time_window || "").localeCompare(b.time_window || "")
    );

    const greedySorted: RemainingStop[] = [];
    const pool = [...otherStops];
    let curLat = currentLat;
    let curLng = currentLng;

    if (twSorted.length > 0) {
      curLat = twSorted[twSorted.length - 1].lat;
      curLng = twSorted[twSorted.length - 1].lng;
    }

    while (pool.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const d = haversine(curLat, curLng, pool[i].lat, pool[i].lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const next = pool.splice(bestIdx, 1)[0];
      greedySorted.push(next);
      curLat = next.lat;
      curLng = next.lng;
    }

    const newOrder = [...twSorted, ...greedySorted];

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const reorderResult = newOrder.map((s, i) => {
      const tw = parseTimeWindow(s.time_window);
      const estimatedEta = currentMinutes + (i + 1) * 8;
      const slaViolation = tw && estimatedEta > tw.end
        ? { time_window: s.time_window!, estimated_eta: minutesToTime(estimatedEta), delay_minutes: Math.round(estimatedEta - tw.end) }
        : null;

      return {
        package_id: s.package_id,
        new_stop_order: i + 1,
        status: s.status,
        time_window: s.time_window,
        risk_score: s.risk_score,
        trip_number: s.trip_number,
        sla_violation: slaViolation,
      };
    });

    if (confirm) {
      for (const item of reorderResult) {
        await pgQuery(
          `UPDATE delivery_status
           SET stop_order = $1, updated_at = NOW()
           WHERE package_id = $2 AND date = $3 AND driver_id = $4`,
          [item.new_stop_order, item.package_id, date, driver_id]
        );

        await pgQuery(
          `UPDATE packages SET stop_order = $1 WHERE package_id = $2`,
          [item.new_stop_order, item.package_id]
        );
      }

      let totalDist = 0;
      for (let i = 1; i < newOrder.length; i++) {
        totalDist += haversine(newOrder[i - 1].lat, newOrder[i - 1].lng, newOrder[i].lat, newOrder[i].lng);
      }
      const timeEst = Math.round(newOrder.length * 8);
      const tripNumbers = [...new Set(newOrder.map((s) => s.trip_number))];
      for (const tn of tripNumbers) {
        const routeId = `R-${driver_id}-${date}-T${tn}`;
        await pgQuery(
          `UPDATE routes SET total_distance = $1, total_time_est = $2, stop_count = $3
           WHERE route_id = $4`,
          [Math.round(totalDist * 100) / 100, timeEst, newOrder.filter((s) => s.trip_number === tn).length, routeId]
        );
      }
    }

    const slaViolations = reorderResult
      .filter((r) => r.sla_violation)
      .map((r) => ({
        package_id: r.package_id,
        ...r.sla_violation!,
      }));

    return NextResponse.json({
      driver_id,
      date,
      total_remaining: remaining.length,
      reordered: reorderResult.length,
      skipped_high_risk: skip_absent
        ? remaining.filter((r) => r.status === "absent" || (r.risk_score !== null && r.risk_score > 0.7)).length
        : 0,
      confirmed: confirm,
      sla_violations: slaViolations,
      new_sequence: reorderResult,
    });
  } catch (error) {
    console.error("Error readjusting route:", error);
    return NextResponse.json({ error: "Failed to readjust route" }, { status: 500 });
  }
}
