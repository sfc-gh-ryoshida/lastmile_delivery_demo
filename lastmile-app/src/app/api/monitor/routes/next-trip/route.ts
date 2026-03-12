import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import { query as sfQuery } from "@/lib/snowflake";
import { latLngToCell } from "h3-js";

interface PackageRow {
  package_id: string;
  lat: number;
  lng: number;
  h3_index: string;
  time_window: string | null;
  weight: number;
  volume: number;
  is_redelivery: boolean;
  delivery_method: string;
  address: string;
  risk_score: number | null;
  prev_status: string;
}

interface DriverRow {
  driver_id: string;
  name: string;
  vehicle_capacity: number;
  vehicle_volume: number;
  shift_start: string;
  shift_end: string;
}

interface CostRow {
  FROM_H3: string;
  TO_H3: string;
  TOTAL_COST: number;
}

type CostMap = Map<string, number>;

function costKey(from: string, to: string): string {
  return from + "|" + to;
}

const DWELL_FACE_TO_FACE = 5;
const DWELL_DROP_OFF = 1;
const AVG_SPEED_KMH = 15;
const MAX_PACKAGES_PER_TRIP = 50;

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

function travelCost(
  fromH3: string,
  toH3: string,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  costMap: CostMap
): number {
  if (fromH3 && toH3 && fromH3 !== toH3) {
    const c = costMap.get(costKey(fromH3, toH3));
    if (c !== undefined) return c;
  }
  return haversine(fromLat, fromLng, toLat, toLng);
}

const COST_RES = 10;
const RISK_RES = 11;

function toH3(lat: number, lng: number, res: number): string {
  try {
    return latLngToCell(lat, lng, res);
  } catch {
    return "";
  }
}

function toR10(lat: number, lng: number): string {
  return toH3(lat, lng, COST_RES);
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function travelMinutes(distKm: number): number {
  return (distKm / AVG_SPEED_KMH) * 60;
}

function parseTimeWindow(tw: string | null): { start: number; end: number } | null {
  if (!tw) return null;
  const match = tw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) return null;
  return { start: timeToMinutes(match[1]), end: timeToMinutes(match[2]) };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, driver_id, confirm = false } = body as {
      date: string;
      driver_id: string;
      confirm?: boolean;
    };

    if (!date || !driver_id) {
      return NextResponse.json({ error: "date and driver_id are required" }, { status: 400 });
    }

    const depotRows = await pgQuery<{ lat: number; lng: number }>("SELECT dp.lat, dp.lng FROM drivers d JOIN depots dp ON dp.depot_id = d.depot_id WHERE d.driver_id = $1", [driver_id]);
    const depotLat = depotRows.length > 0 ? Number(depotRows[0].lat) : 35.6466;
    const depotLng = depotRows.length > 0 ? Number(depotRows[0].lng) : 139.7828;
    const depotH3R10 = toR10(depotLat, depotLng);

    const [driverRows, currentTripRow] = await Promise.all([
      pgQuery<DriverRow>(
        `SELECT driver_id, name, vehicle_capacity, vehicle_volume,
                shift_start::text, shift_end::text
         FROM drivers WHERE driver_id = $1`,
        [driver_id]
      ),
      pgQuery<{ current_trip: number }>(
        `SELECT COALESCE(MAX(trip_number), 1) AS current_trip
         FROM delivery_status
         WHERE driver_id = $1 AND date = $2`,
        [driver_id, date]
      ),
    ]);

    if (driverRows.length === 0) {
      return NextResponse.json({ error: "Driver not found" }, { status: 404 });
    }

    const driver = {
      ...driverRows[0],
      vehicle_capacity: Number(driverRows[0].vehicle_capacity) || 350,
      vehicle_volume: Number(driverRows[0].vehicle_volume) || 8,
      shift_start: String(driverRows[0].shift_start || "08:00:00").substring(0, 5),
      shift_end: String(driverRows[0].shift_end || "18:00:00").substring(0, 5),
    };

    const currentTrip = currentTripRow[0]?.current_trip ?? 1;
    const nextTripNumber = currentTrip + 1;

    const [prevTripStatuses, existingNextTrip] = await Promise.all([
      pgQuery<PackageRow>(
        `SELECT
           ds.package_id, p.lat, p.lng, p.h3_index::text AS h3_index,
           p.time_window, p.weight, p.volume, p.is_redelivery,
           COALESCE(p.delivery_method, 'face_to_face') AS delivery_method, p.address,
           NULL::float AS risk_score,
           ds.status AS prev_status
         FROM delivery_status ds
         JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
         WHERE ds.date = $1 AND ds.driver_id = $2 AND ds.trip_number = $3`,
        [date, driver_id, currentTrip]
      ),
      pgQuery<PackageRow>(
        `SELECT
           ds.package_id, p.lat, p.lng, p.h3_index::text AS h3_index,
           p.time_window, p.weight, p.volume, p.is_redelivery,
           COALESCE(p.delivery_method, 'face_to_face') AS delivery_method, p.address,
           NULL::float AS risk_score,
           ds.status AS prev_status
         FROM delivery_status ds
         JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
         WHERE ds.date = $1 AND ds.driver_id = $2 AND ds.trip_number = $3`,
        [date, driver_id, nextTripNumber]
      ),
    ]);

    const failedFromPrev = prevTripStatuses
      .filter((p) => ["absent", "failed", "pending", "in_transit"].includes(p.prev_status))
      .map((p) => ({
        ...p,
        lat: Number(p.lat),
        lng: Number(p.lng),
        weight: Number(p.weight) || 2,
        volume: Number(p.volume) || 0.02,
      }));

    const existingNext = existingNextTrip.map((p) => ({
      ...p,
      lat: Number(p.lat),
      lng: Number(p.lng),
      weight: Number(p.weight) || 2,
      volume: Number(p.volume) || 0.02,
    }));

    const nextIds = new Set(existingNext.map((p) => p.package_id));
    const newFromPrev = failedFromPrev.filter((p) => !nextIds.has(p.package_id));
    const tripPool = [...existingNext, ...newFromPrev];

    if (tripPool.length === 0) {
      return NextResponse.json({
        driver_id,
        driver_name: driver.name,
        date,
        current_trip: currentTrip,
        next_trip_number: nextTripNumber,
        prev_trip_summary: {
          total: prevTripStatuses.length,
          delivered: prevTripStatuses.filter((p) => p.prev_status === "delivered").length,
          absent: prevTripStatuses.filter((p) => p.prev_status === "absent").length,
          failed: prevTripStatuses.filter((p) => ["failed", "pending", "in_transit"].includes(p.prev_status)).length,
        },
        message: "No packages for next trip",
        next_trip: null,
        confirmed: false,
      });
    }

    try {
      const currentHour = new Date().getHours();
      const riskRows = await sfQuery<{ H3_INDEX: string; RISK_SCORE: number }>(
        `SELECT H3_INDEX, RISK_SCORE FROM ANALYTICS.RISK_SCORES WHERE DATE = ? AND HOUR = ?`,
        [date, currentHour >= 14 ? currentHour : 14]
      );
      const riskMap = new Map(riskRows.map((r) => [r.H3_INDEX, r.RISK_SCORE]));
      for (const pkg of tripPool) {
        pkg.risk_score = riskMap.get(toH3(pkg.lat, pkg.lng, RISK_RES)) ?? null;
      }
    } catch (e) {
      console.warn("Risk scores unavailable for next-trip:", (e as Error).message);
    }

    let costMap: CostMap = new Map();
    try {
      const hour = 14;
      const r10Set = new Set<string>();
      r10Set.add(depotH3R10);
      for (const pkg of tripPool) {
        const r10 = toR10(pkg.lat, pkg.lng);
        if (r10) r10Set.add(r10);
      }
      const r10List = [...r10Set].map((h) => `'${h}'`).join(",");
      const costRows = await sfQuery<CostRow>(
        `SELECT FROM_H3, TO_H3, TOTAL_COST FROM ANALYTICS.H3_COST_MATRIX WHERE DATE = ? AND HOUR = ? AND FROM_H3 IN (${r10List}) AND TO_H3 IN (${r10List})`,
        [date, hour]
      );
      for (const r of costRows) {
        costMap.set(costKey(String(r.FROM_H3), String(r.TO_H3)), Number(r.TOTAL_COST));
      }
    } catch (e) {
      console.warn("Cost matrix unavailable for next-trip:", (e as Error).message);
    }

    const shiftEndMin = timeToMinutes(driver.shift_end);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const departureTime = Math.max(currentMinutes + 20, 12 * 60);

    let capWeight = 0;
    let capVolume = 0;
    const capped: typeof tripPool = [];
    const sorted = [...tripPool].sort((a, b) => {
      const twA = parseTimeWindow(a.time_window);
      const twB = parseTimeWindow(b.time_window);
      if (twA && !twB) return -1;
      if (!twA && twB) return 1;
      if (twA && twB) return twA.start - twB.start;
      return (a.risk_score ?? 0) - (b.risk_score ?? 0);
    });

    for (const pkg of sorted) {
      if (capWeight + pkg.weight > driver.vehicle_capacity) continue;
      if (capVolume + pkg.volume > driver.vehicle_volume) continue;
      if (capped.length >= MAX_PACKAGES_PER_TRIP) break;
      capWeight += pkg.weight;
      capVolume += pkg.volume;
      capped.push(pkg);
    }

    const ordered: (typeof capped[0] & { eta: number })[] = [];
    const remaining = [...capped];
    let curLat = depotLat;
    let curLng = depotLng;
    let curH3 = depotH3R10;
    let curTime = departureTime;

    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i];
        const destH3 = toR10(p.lat, p.lng);
        const dist = travelCost(curH3, destH3, curLat, curLng, p.lat, p.lng, costMap);
        const travel = travelMinutes(dist);
        const arriveAt = curTime + travel;

        const tw = parseTimeWindow(p.time_window);
        let twPenalty = 0;
        if (tw) {
          if (arriveAt < tw.start) twPenalty = (tw.start - arriveAt) * 0.1;
          if (arriveAt > tw.end) twPenalty = (arriveAt - tw.end) * 2;
        }

        const score = dist + twPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      const next = remaining.splice(bestIdx, 1)[0];
      const destH3 = toR10(next.lat, next.lng);
      const dist = travelCost(curH3, destH3, curLat, curLng, next.lat, next.lng, costMap);
      const travel = travelMinutes(dist);
      const arriveAt = curTime + travel;

      const tw = parseTimeWindow(next.time_window);
      const eta = tw && arriveAt < tw.start ? tw.start : arriveAt;

      ordered.push({ ...next, eta });
      const dwell = next.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
      curTime = eta + dwell;
      curLat = next.lat;
      curLng = next.lng;
      curH3 = destH3;
    }

    while (ordered.length > 0) {
      const last = ordered[ordered.length - 1];
      const lastDwell = last.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
      const returnTime = last.eta + lastDwell + travelMinutes(
        haversine(last.lat, last.lng, depotLat, depotLng)
      );
      if (returnTime <= shiftEndMin) break;
      ordered.pop();
    }

    if (ordered.length === 0) {
      return NextResponse.json({
        driver_id,
        driver_name: driver.name,
        date,
        current_trip: currentTrip,
        next_trip_number: nextTripNumber,
        prev_trip_summary: {
          total: prevTripStatuses.length,
          delivered: prevTripStatuses.filter((p) => p.prev_status === "delivered").length,
          absent: prevTripStatuses.filter((p) => p.prev_status === "absent").length,
          failed: prevTripStatuses.filter((p) => ["failed", "pending", "in_transit"].includes(p.prev_status)).length,
        },
        message: "Cannot fit any packages in remaining shift",
        next_trip: null,
        confirmed: false,
      });
    }

    if (confirm) {
      const routeId = `R-${driver_id}-${date}-T${nextTripNumber}`;
      let totalDist = 0;
      for (let i = 1; i < ordered.length; i++) {
        totalDist += haversine(ordered[i - 1].lat, ordered[i - 1].lng, ordered[i].lat, ordered[i].lng);
      }
      const lastS = ordered[ordered.length - 1];
      const lastD = lastS.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
      const estReturn = lastS.eta + lastD + travelMinutes(haversine(lastS.lat, lastS.lng, depotLat, depotLng));
      const timeEst = Math.round(estReturn - departureTime);

      await pgQuery(
        `INSERT INTO routes (route_id, driver_id, depot_id, date, total_distance, total_time_est, stop_count, status)
         SELECT $1, $2, d.depot_id, $3, $4, $5, $6, 'planned'
         FROM drivers d WHERE d.driver_id = $2
         ON CONFLICT (route_id) DO UPDATE SET total_distance = $4, total_time_est = $5, stop_count = $6, status = 'planned'`,
        [routeId, driver_id, date, Math.round(totalDist * 100) / 100, timeEst, ordered.length]
      );

      for (let i = 0; i < ordered.length; i++) {
        const pkg = ordered[i];
        const isNewFromPrev = newFromPrev.some((p) => p.package_id === pkg.package_id);

        if (isNewFromPrev) {
          await pgQuery(
            `UPDATE delivery_status
             SET trip_number = $1, stop_order = $2, status = 'assigned', updated_at = NOW()
             WHERE package_id = $3 AND date = $4`,
            [nextTripNumber, i + 1, pkg.package_id, date]
          );
        } else {
          await pgQuery(
            `UPDATE delivery_status
             SET stop_order = $1, updated_at = NOW()
             WHERE package_id = $2 AND date = $3 AND trip_number = $4`,
            [i + 1, pkg.package_id, date, nextTripNumber]
          );
        }

        await pgQuery(
          `UPDATE packages SET route_id = $1, stop_order = $2 WHERE package_id = $3`,
          [routeId, i + 1, pkg.package_id]
        );
      }
    }

    const lastStop = ordered[ordered.length - 1];
    const lastDwell = lastStop.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
    const returnTime = lastStop.eta + lastDwell + travelMinutes(
      haversine(lastStop.lat, lastStop.lng, depotLat, depotLng)
    );

    const route = [
      { lat: depotLat, lng: depotLng },
      ...ordered.map((p) => ({ lat: p.lat, lng: p.lng })),
      { lat: depotLat, lng: depotLng },
    ];

    return NextResponse.json({
      driver_id,
      driver_name: driver.name,
      date,
      current_trip: currentTrip,
      next_trip_number: nextTripNumber,
      confirmed: confirm,
      prev_trip_summary: {
        total: prevTripStatuses.length,
        delivered: prevTripStatuses.filter((p) => p.prev_status === "delivered").length,
        absent: prevTripStatuses.filter((p) => p.prev_status === "absent").length,
        failed: prevTripStatuses.filter((p) => ["failed", "pending", "in_transit"].includes(p.prev_status)).length,
      },
      next_trip: {
        trip_number: nextTripNumber,
        total_packages: ordered.length,
        from_prev_failed: newFromPrev.filter((p) => ordered.some((o) => o.package_id === p.package_id)).length,
        original_next: existingNext.filter((p) => ordered.some((o) => o.package_id === p.package_id)).length,
        dropped: tripPool.length - ordered.length,
        total_weight: ordered.reduce((s, p) => s + p.weight, 0),
        total_volume: ordered.reduce((s, p) => s + p.volume, 0),
        departure_time: minutesToTime(departureTime),
        return_time: minutesToTime(returnTime),
        stops: ordered.map((p, i) => ({
          stop_order: i + 1,
          package_id: p.package_id,
          address: p.address,
          time_window: p.time_window,
          is_redelivery: p.is_redelivery,
          delivery_method: p.delivery_method,
          from_prev: newFromPrev.some((np) => np.package_id === p.package_id),
          risk_score: p.risk_score,
          eta: minutesToTime(p.eta),
          lat: p.lat,
          lng: p.lng,
        })),
        route,
      },
    });
  } catch (error) {
    console.error("Error generating next trip:", error);
    return NextResponse.json({ error: "Failed to generate next trip" }, { status: 500 });
  }
}
