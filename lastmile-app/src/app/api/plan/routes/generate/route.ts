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
  recipient_type: string;
  delivery_method: string;
  address: string;
  risk_score: number | null;
  absence_rate: number | null;
}

interface DriverRow {
  driver_id: string;
  name: string;
  vehicle_capacity: number;
  vehicle_volume: number;
  skill_level: number;
  area_assignment: string | null;
  shift_start: string;
  shift_end: string;
  max_trips: number;
  depot_lat: number;
  depot_lng: number;
  depot_name: string;
}

interface ConstructionRow {
  h3_index: string;
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
const DEPOT_TURNAROUND_MINUTES = 20;
const MAX_PACKAGES_PER_TRIP = 50;

interface StopDetail {
  package_id: string;
  stop_order: number;
  address: string;
  weight: number;
  volume: number;
  time_window: string | null;
  is_redelivery: boolean;
  recipient_type: string;
  delivery_method: string;
  risk_score: number | null;
  lat: number;
  lng: number;
  eta: string;
}

interface TripAssignment {
  trip: number;
  packages: StopDetail[];
  total_weight: number;
  total_volume: number;
  total_packages: number;
  departure_time: string;
  return_time: string;
  route: { lat: number; lng: number }[];
  quality_score: number;
  quality_flags: string[];
}

interface DriverAssignment {
  driver_id: string;
  driver_name: string;
  shift_start: string;
  shift_end: string;
  depot: { lat: number; lng: number; name: string };
  trips: TripAssignment[];
  total_packages: number;
  total_weight: number;
  total_volume: number;
  capacity_pct: number;
  volume_pct: number;
  route: { lat: number; lng: number }[];
  quality_score: number;
  quality_flags: string[];
  needs_review: boolean;
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

function travelCost(
  fromH3R10: string,
  toH3R10: string,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  costMap: CostMap
): number {
  if (fromH3R10 && toH3R10 && fromH3R10 !== toH3R10) {
    const c = costMap.get(costKey(fromH3R10, toH3R10));
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

function greedySortWithETA(
  pkgs: PackageRow[],
  startLat: number,
  startLng: number,
  startH3: string,
  startMinutes: number,
  costMap: CostMap,
  depotLat: number,
  depotLng: number,
  depotH3: string
): { ordered: (PackageRow & { eta: number })[]; returnMinutes: number } {
  if (pkgs.length === 0) return { ordered: [], returnMinutes: startMinutes };

  const ordered: (PackageRow & { eta: number })[] = [];
  const remaining = [...pkgs];
  let curLat = startLat;
  let curLng = startLng;
  let curH3 = startH3;
  let curTime = startMinutes;

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

      const absencePenalty =
        p.delivery_method === "drop_off" ? 0
        : (p.absence_rate ?? 0) > 0.4 && arriveAt < 16 * 60 ? 0.3 : 0;

      const score = dist + twPenalty + absencePenalty;
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

    const dwell = next.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
    ordered.push({ ...next, eta });
    curTime = eta + dwell;
    curLat = next.lat;
    curLng = next.lng;
    curH3 = destH3;
  }

  const lastPkg = ordered[ordered.length - 1];
  const returnDist = travelCost(
    toR10(lastPkg.lat, lastPkg.lng), depotH3, lastPkg.lat, lastPkg.lng, depotLat, depotLng, costMap
  );
  const returnMinutes = curTime + travelMinutes(returnDist);

  return { ordered, returnMinutes };
}

function scoreTripQuality(
  ordered: (PackageRow & { eta: number })[],
  departureMin: number,
  returnMin: number,
  shiftEndMin: number,
  load: { weight: number; volume: number },
  driver: { vehicle_capacity: number; vehicle_volume: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 80;

  if (ordered.length === 0) return { score: 0, flags: ["荷物なし"] };

  const twPkgs = ordered.filter((p) => p.time_window);
  if (twPkgs.length > 0) {
    let violations = 0;
    let lateMinutesTotal = 0;
    for (const p of twPkgs) {
      const tw = parseTimeWindow(p.time_window);
      if (tw) {
        if (p.eta > tw.end) {
          violations++;
          lateMinutesTotal += p.eta - tw.end;
        } else if (p.eta < tw.start - 15) {
          violations++;
        }
      }
    }
    const twRate = 1 - violations / twPkgs.length;
    if (twRate === 1) {
      score += 10;
    } else {
      score -= Math.round((1 - twRate) * 35);
      flags.push(`時間指定違反 ${violations}/${twPkgs.length}件 (遅延計${Math.round(lateMinutesTotal)}分)`);
    }
  } else {
    score += 5;
  }

  const highRisk = ordered.filter((p) => (p.risk_score ?? 0) >= 0.7);
  const medRisk = ordered.filter((p) => {
    const s = p.risk_score ?? 0;
    return s >= 0.4 && s < 0.7;
  });
  if (highRisk.length > 0) {
    score -= Math.min(highRisk.length * 4, 20);
    flags.push(`高リスク ${highRisk.length}件`);
  }
  if (medRisk.length > ordered.length * 0.3) {
    score -= 5;
    flags.push(`中リスク多 ${medRisk.length}件`);
  }

  const tripDuration = returnMin - departureMin;
  const shiftRemaining = shiftEndMin - returnMin;
  if (shiftRemaining < 10) {
    score -= 12;
    flags.push(`シフト余裕 ${Math.round(shiftRemaining)}分`);
  } else if (shiftRemaining < 30) {
    score -= 5;
    flags.push(`シフト余裕 ${Math.round(shiftRemaining)}分`);
  }

  let totalDist = 0;
  for (let i = 1; i < ordered.length; i++) {
    totalDist += haversine(ordered[i - 1].lat, ordered[i - 1].lng, ordered[i].lat, ordered[i].lng);
  }

  if (ordered.length >= 2) {
    const firstPkg = ordered[0];
    const lastPkg = ordered[ordered.length - 1];
    const directDist = haversine(firstPkg.lat, firstPkg.lng, lastPkg.lat, lastPkg.lng);
    const detourRatio = directDist > 0.1 ? totalDist / directDist : 1;
    if (detourRatio > 4) {
      score -= Math.min(Math.round((detourRatio - 4) * 5), 15);
      flags.push(`迂回率 ${detourRatio.toFixed(1)}倍`);
    }
  }

  const avgDist = ordered.length > 1 ? totalDist / (ordered.length - 1) : 0;
  if (avgDist > 1.0) {
    score -= Math.min(Math.round((avgDist - 1.0) * 8), 15);
    flags.push(`平均停車間 ${avgDist.toFixed(2)}km`);
  }

  const deliveryRate = tripDuration > 0 ? ordered.length / (tripDuration / 60) : 0;
  if (deliveryRate < 5) {
    score -= 5;
    flags.push(`配送効率 ${deliveryRate.toFixed(1)}件/h`);
  } else if (deliveryRate > 12) {
    score += 5;
  }

  const weightUtil = load.weight / driver.vehicle_capacity;
  const volumeUtil = load.volume / driver.vehicle_volume;
  if (weightUtil > 0.95 || volumeUtil > 0.95) {
    score -= 8;
    flags.push("積載上限");
  } else if (weightUtil > 0.7 || volumeUtil > 0.7) {
    score += 3;
  }
  if (weightUtil < 0.15 && ordered.length < 8) {
    score -= 10;
    flags.push(`積載過少 (重量${Math.round(weightUtil * 100)}%)`);
  }

  const redeliveryCount = ordered.filter((p) => p.is_redelivery).length;
  if (redeliveryCount > ordered.length * 0.3) {
    score -= 5;
    flags.push(`再配達比率 ${Math.round((redeliveryCount / ordered.length) * 100)}%`);
  }

  const faceToFaceInHighAbsence = ordered.filter(
    (p) => p.delivery_method === "face_to_face" && (p.absence_rate ?? 0) > 0.4
  ).length;
  if (faceToFaceInHighAbsence > 3) {
    score -= Math.min(faceToFaceInHighAbsence * 2, 10);
    flags.push(`不在リスク高エリアに対面${faceToFaceInHighAbsence}件`);
  }

  return { score: Math.max(0, Math.min(100, score)), flags };
}

function scoreDriverQuality(
  trips: TripAssignment[],
  totalWeight: number,
  totalVolume: number,
  driver: { vehicle_capacity: number; vehicle_volume: number; skill_level: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  const avgTripScore = trips.reduce((s, t) => s + t.quality_score, 0) / trips.length;
  let score = avgTripScore;

  const allHighRisk = trips.flatMap((t) => t.packages.filter((p) => (p.risk_score ?? 0) >= 0.7));
  if (allHighRisk.length > 5 && driver.skill_level < 3) {
    score -= 10;
    flags.push("スキル不足で高リスク多数");
  }

  for (const t of trips) {
    if (t.quality_flags.length > 0) {
      flags.push(...t.quality_flags.map((f) => `${t.trip}便: ${f}`));
    }
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), flags: [...new Set(flags)] };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, mode = "auto", confirm = false } = body as { date: string; mode?: string; confirm?: boolean };

    if (!date) {
      return NextResponse.json({ error: "date is required" }, { status: 400 });
    }

    const [rawPackages, rawDrivers, constructionZones] = await Promise.all([
      pgQuery<PackageRow>(
        `SELECT
           p.package_id, p.lat, p.lng, p.h3_index::text AS h3_index,
           p.time_window, p.weight, p.volume, p.is_redelivery, p.recipient_type,
           COALESCE(p.delivery_method, 'face_to_face') AS delivery_method, p.address,
           NULL::float AS risk_score,
           NULL::float AS absence_rate
         FROM packages p
         WHERE p.date = $1
         ORDER BY p.package_id`,
        [date]
      ),
      pgQuery<DriverRow>(
        `SELECT d.driver_id, d.name, d.vehicle_capacity, d.vehicle_volume, d.skill_level, d.area_assignment,
                d.shift_start::text, d.shift_end::text, d.max_trips,
                dp.lat AS depot_lat, dp.lng AS depot_lng, dp.name AS depot_name
         FROM drivers d
         JOIN depots dp ON dp.depot_id = d.depot_id
         WHERE d.is_active = true
         ORDER BY d.driver_id`
      ),
      pgQuery<ConstructionRow>(
        `SELECT h3_index::text AS h3_index
         FROM road_construction
         WHERE start_date <= $1 AND (end_date IS NULL OR end_date >= $1)`,
        [date]
      ),
    ]);

    const packages = rawPackages.map((p) => ({
      ...p,
      lat: Number(p.lat),
      lng: Number(p.lng),
      weight: Number(p.weight) || 2,
      volume: Number(p.volume) || 0.02,
    }));

    const drivers = rawDrivers.map((d) => ({
      ...d,
      vehicle_capacity: Number(d.vehicle_capacity) || 350,
      vehicle_volume: Number(d.vehicle_volume) || 8,
      skill_level: Number(d.skill_level) || 3,
      max_trips: Number(d.max_trips) || 2,
      shift_start: String(d.shift_start || "08:00:00").substring(0, 5),
      shift_end: String(d.shift_end || "18:00:00").substring(0, 5),
      depot_lat: Number(d.depot_lat) || 35.6495,
      depot_lng: Number(d.depot_lng) || 139.7914,
      depot_name: String(d.depot_name || "集配所"),
    }));

    const defaultDepot = drivers[0] ?? { depot_lat: 35.6495, depot_lng: 139.7914 };
    const depotLat = defaultDepot.depot_lat;
    const depotLng = defaultDepot.depot_lng;
    const depotH3R10 = toR10(depotLat, depotLng);

    if (packages.length === 0) {
      return NextResponse.json({ error: "No packages found for this date", assignments: [] }, { status: 200 });
    }

    try {
      const riskRows = await sfQuery<{ H3_INDEX: string; RISK_SCORE: number }>(
        `SELECT H3_INDEX, RISK_SCORE FROM ANALYTICS.RISK_SCORES WHERE DATE = ? AND HOUR = 10`,
        [date]
      );
      const riskMap = new Map(riskRows.map((r) => [r.H3_INDEX, r.RISK_SCORE]));
      for (const pkg of packages) {
        pkg.risk_score = riskMap.get(toH3(pkg.lat, pkg.lng, RISK_RES)) ?? null;
      }
    } catch (e) {
      console.warn("Risk scores unavailable:", (e as Error).message);
    }

    try {
      const dow = new Date(date).getDay();
      const absRows = await sfQuery<{ H3_INDEX: string; ABSENCE_RATE: number }>(
        `SELECT H3_INDEX, ABSENCE_RATE FROM ANALYTICS.ABSENCE_PATTERNS WHERE DAY_OF_WEEK = ? AND HOUR = 10`,
        [dow]
      );
      const absMap = new Map(absRows.map((r) => [r.H3_INDEX, r.ABSENCE_RATE]));
      for (const pkg of packages) {
        pkg.absence_rate = absMap.get(toH3(pkg.lat, pkg.lng, RISK_RES)) ?? null;
      }
    } catch (e) {
      console.warn("Absence patterns unavailable:", (e as Error).message);
    }

    const constructionH3 = new Set(constructionZones.map((c) => c.h3_index));
    for (const pkg of packages) {
      if (constructionH3.has(pkg.h3_index)) {
        pkg.risk_score = Math.max(pkg.risk_score ?? 0, 0.8);
      }
    }

    let costMap: CostMap = new Map();
    try {
      const hour = 10;
      const r10Set = new Set<string>();
      r10Set.add(depotH3R10);
      for (const pkg of packages) {
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
      console.log(`H3 cost matrix loaded: ${costMap.size} pairs (from ${r10Set.size} cells)`);
    } catch (e) {
      console.warn("H3 cost matrix unavailable, falling back to haversine:", (e as Error).message);
    }

    const driverAssignments: DriverAssignment[] = [];
    let morningPkgs: PackageRow[] = [];
    let afternoonPkgs: PackageRow[] = [];
    let eveningPkgs: PackageRow[] = [];
    let flexPkgs: PackageRow[] = [];

    if (mode === "auto") {
      const sortedDrivers = [...drivers].sort((a, b) => b.skill_level - a.skill_level);

      for (const pkg of packages) {
        const tw = parseTimeWindow(pkg.time_window);
        if (tw) {
          if (tw.end <= 13 * 60) morningPkgs.push(pkg);
          else if (tw.start >= 17 * 60) eveningPkgs.push(pkg);
          else afternoonPkgs.push(pkg);
        } else {
          flexPkgs.push(pkg);
        }
      }

      interface TripLoad {
        weight: number;
        volume: number;
        packages: PackageRow[];
      }

      const maxTripsGlobal = Math.max(...sortedDrivers.map((d) => d.max_trips), 2);

      const timePools: PackageRow[][] = [];
      if (maxTripsGlobal <= 2) {
        timePools.push([...morningPkgs, ...flexPkgs]);
        timePools.push([...afternoonPkgs, ...eveningPkgs]);
      } else {
        const shiftHours = 10;
        const slotHours = shiftHours / maxTripsGlobal;
        for (let t = 0; t < maxTripsGlobal; t++) {
          timePools.push([]);
        }
        for (const pkg of packages) {
          const tw = parseTimeWindow(pkg.time_window);
          if (tw) {
            const midHour = (tw.start + tw.end) / 2 / 60;
            const slot = Math.min(Math.floor((midHour - 8) / slotHours), maxTripsGlobal - 1);
            timePools[Math.max(0, slot)].push(pkg);
          } else {
            timePools[0].push(pkg);
          }
        }
      }

      const driverTrips = new Map<string, TripLoad[]>();
      for (const d of sortedDrivers) {
        const trips: TripLoad[] = [];
        for (let t = 0; t < d.max_trips; t++) {
          trips.push({ weight: 0, volume: 0, packages: [] });
        }
        driverTrips.set(d.driver_id, trips);
      }

      function assignToTrip(pkg: PackageRow, tripIdx: number): boolean {
        let bestDriver: DriverRow | null = null;
        let bestScore = Infinity;

        for (const d of sortedDrivers) {
          const trips = driverTrips.get(d.driver_id)!;
          if (tripIdx >= trips.length) continue;
          const load = trips[tripIdx];
          if (load.weight + pkg.weight > d.vehicle_capacity) continue;
          if (load.volume + pkg.volume > d.vehicle_volume) continue;
          if (load.packages.length >= MAX_PACKAGES_PER_TRIP) continue;

          const tripPkgs = load.packages.length;
          const totalPkgs = trips.reduce((s, t) => s + t.packages.length, 0);
          const score = tripPkgs * 2 + totalPkgs;
          if (score < bestScore) {
            bestScore = score;
            bestDriver = d;
          }
        }

        if (bestDriver) {
          const load = driverTrips.get(bestDriver.driver_id)![tripIdx];
          load.weight += pkg.weight;
          load.volume += pkg.volume;
          load.packages.push(pkg);
          return true;
        }
        return false;
      }

      const riskSorted = (pool: PackageRow[]) =>
        [...pool].sort((a, b) => (a.risk_score ?? 0) - (b.risk_score ?? 0));

      for (let poolIdx = 0; poolIdx < timePools.length; poolIdx++) {
        for (const pkg of riskSorted(timePools[poolIdx])) {
          if (!assignToTrip(pkg, poolIdx)) {
            for (let alt = 0; alt < maxTripsGlobal; alt++) {
              if (alt !== poolIdx && assignToTrip(pkg, alt)) break;
            }
          }
        }
      }

      for (const d of sortedDrivers) {
        const trips = driverTrips.get(d.driver_id)!;
        const dDepotLat = d.depot_lat;
        const dDepotLng = d.depot_lng;
        const dDepotH3 = toR10(dDepotLat, dDepotLng);
        const shiftStartMin = timeToMinutes(d.shift_start);
        const shiftEndMin = timeToMinutes(d.shift_end);
        const tripResults: TripAssignment[] = [];
        let allRoute: { lat: number; lng: number }[] = [];
        let totalPkgs = 0;
        let totalWt = 0;
        let totalVol = 0;
        let currentTime = shiftStartMin;

        const tripEntries: { idx: number; load: TripLoad }[] = [];
        for (let ti = 0; ti < trips.length; ti++) {
          if (trips[ti].packages.length > 0) tripEntries.push({ idx: ti, load: trips[ti] });
        }

        for (let ti = 0; ti < tripEntries.length; ti++) {
          const { load } = tripEntries[ti];
          const tripNum = tripEntries[ti].idx + 1;
          const departureTime = currentTime;

          const { ordered, returnMinutes } = greedySortWithETA(
            load.packages,
            dDepotLat,
            dDepotLng,
            dDepotH3,
            departureTime,
            costMap,
            dDepotLat,
            dDepotLng,
            dDepotH3
          );

          if (returnMinutes > shiftEndMin) {
            let trimCount = 0;
            while (ordered.length > 0) {
              const last = ordered[ordered.length - 1];
              const lastDwell = last.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
              if (last.eta + lastDwell + travelMinutes(
                haversine(last.lat, last.lng, dDepotLat, dDepotLng)
              ) <= shiftEndMin) break;
              ordered.pop();
              trimCount++;
            }
            if (trimCount > 0) {
              console.log(`${d.name} trip${tripNum}: trimmed ${trimCount} packages (shift overflow)`);
            }
          }

          if (ordered.length === 0) continue;

          const lastStop = ordered[ordered.length - 1];
          const lastStopDwell = lastStop.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
          const actualReturn = lastStop.eta + lastStopDwell + travelMinutes(
            haversine(lastStop.lat, lastStop.lng, dDepotLat, dDepotLng)
          );

          const tripRoute = [
            { lat: dDepotLat, lng: dDepotLng },
            ...ordered.map((p) => ({ lat: p.lat, lng: p.lng })),
            { lat: dDepotLat, lng: dDepotLng },
          ];

          const tripQuality = scoreTripQuality(ordered, departureTime, actualReturn, shiftEndMin, load, d);

          let stopOrder = 0;
          tripResults.push({
            trip: tripNum,
            packages: ordered.map((p) => ({
              package_id: p.package_id,
              stop_order: ++stopOrder,
              address: p.address,
              weight: p.weight,
              volume: p.volume,
              time_window: p.time_window,
              is_redelivery: p.is_redelivery,
              recipient_type: p.recipient_type,
              delivery_method: p.delivery_method,
              risk_score: p.risk_score,
              lat: p.lat,
              lng: p.lng,
              eta: minutesToTime(p.eta),
            })),
            total_weight: load.weight,
            total_volume: load.volume,
            total_packages: ordered.length,
            departure_time: minutesToTime(departureTime),
            return_time: minutesToTime(actualReturn),
            route: tripRoute,
            quality_score: tripQuality.score,
            quality_flags: tripQuality.flags,
          });

          allRoute = [...allRoute, ...tripRoute];
          totalPkgs += ordered.length;
          totalWt += ordered.reduce((s, p) => s + p.weight, 0);
          totalVol += ordered.reduce((s, p) => s + p.volume, 0);
          currentTime = actualReturn + DEPOT_TURNAROUND_MINUTES;
        }

        if (tripResults.length === 0) continue;

        const driverQuality = scoreDriverQuality(tripResults, totalWt, totalVol, d);

        driverAssignments.push({
          driver_id: d.driver_id,
          driver_name: d.name,
          shift_start: d.shift_start,
          shift_end: d.shift_end,
          depot: { lat: dDepotLat, lng: dDepotLng, name: d.depot_name },
          trips: tripResults,
          total_packages: totalPkgs,
          total_weight: totalWt,
          total_volume: totalVol,
          capacity_pct: Math.round((totalWt / d.vehicle_capacity) * 100),
          volume_pct: Math.round((totalVol / d.vehicle_volume) * 100),
          route: allRoute,
          quality_score: driverQuality.score,
          quality_flags: driverQuality.flags,
          needs_review: driverQuality.score < 70,
        });
      }
    }

    const assignedCount = driverAssignments.reduce((s, a) => s + a.total_packages, 0);

    const riskApplied = packages.filter((p) => p.risk_score != null).length;
    const absenceApplied = packages.filter((p) => p.absence_rate != null).length;
    const constructionPenalty = packages.filter((p) => constructionH3.has(p.h3_index)).length;
    const timeWindowCount = packages.filter((p) => p.time_window != null).length;
    const redeliveryCount = packages.filter((p) => p.is_redelivery).length;
    const recipientBreakdown = {
      apartment: packages.filter((p) => p.recipient_type === "apartment").length,
      office: packages.filter((p) => p.recipient_type === "office").length,
      house: packages.filter((p) => p.recipient_type === "house").length,
      other: packages.filter((p) => !["apartment", "office", "house"].includes(p.recipient_type)).length,
    };
    const avgRisk = riskApplied > 0
      ? packages.reduce((s, p) => s + (p.risk_score ?? 0), 0) / riskApplied
      : null;

    const reviewNeeded = driverAssignments.filter((a) => a.needs_review).length;

    if (confirm && driverAssignments.length > 0) {
      await pgQuery(
        `DELETE FROM routes WHERE date = $1`,
        [date]
      );

      for (const da of driverAssignments) {
        for (const trip of da.trips) {
          const routeId = `R-${da.driver_id}-${date}-T${trip.trip}`;
          const totalDist = trip.route.reduce((sum, pt, i, arr) => {
            if (i === 0) return 0;
            return sum + haversine(arr[i - 1].lat, arr[i - 1].lng, pt.lat, pt.lng);
          }, 0);
          const timeEst = Math.round((trip.return_time ? timeToMinutes(trip.return_time) : 0) - (trip.departure_time ? timeToMinutes(trip.departure_time) : 0));

          await pgQuery(
            `INSERT INTO routes (route_id, driver_id, depot_id, date, total_distance, total_time_est, stop_count, status)
             VALUES ($1, $2, (SELECT depot_id FROM drivers WHERE driver_id = $2), $3, $4, $5, $6, 'planned')`,
            [routeId, da.driver_id, date, Math.round(totalDist * 100) / 100, timeEst, trip.total_packages]
          );

          for (const pkg of trip.packages) {
            await pgQuery(
              `UPDATE delivery_status
               SET driver_id = $1, trip_number = $2, stop_order = $3, status = 'assigned', updated_at = NOW()
               WHERE package_id = $4 AND date = $5`,
              [da.driver_id, trip.trip, pkg.stop_order, pkg.package_id, date]
            );

            await pgQuery(
              `UPDATE packages
               SET route_id = $1, stop_order = $2
               WHERE package_id = $3`,
              [routeId, pkg.stop_order, pkg.package_id]
            );
          }
        }
      }
    }

    return NextResponse.json({
      date,
      total_packages: packages.length,
      assigned_packages: assignedCount,
      unassigned_packages: packages.length - assignedCount,
      drivers_used: driverAssignments.length,
      review_needed_count: reviewNeeded,
      confirmed: confirm,
      assignments: driverAssignments,
      optimization_summary: {
        cost_matrix_pairs: costMap.size,
        risk_applied_count: riskApplied,
        absence_applied_count: absenceApplied,
        construction_penalty_count: constructionPenalty,
        time_window_count: timeWindowCount,
        redelivery_count: redeliveryCount,
        recipient_breakdown: recipientBreakdown,
        avg_risk_score: avgRisk,
        morning_pool: morningPkgs?.length ?? 0,
        afternoon_pool: afternoonPkgs?.length ?? 0,
        evening_pool: eveningPkgs?.length ?? 0,
        flex_pool: flexPkgs?.length ?? 0,
        drop_off_count: packages.filter((p) => p.delivery_method === "drop_off").length,
        face_to_face_count: packages.filter((p) => p.delivery_method === "face_to_face").length,
      },
    });
  } catch (error) {
    console.error("Error generating routes:", error);
    return NextResponse.json({ error: "Failed to generate routes" }, { status: 500 });
  }
}
