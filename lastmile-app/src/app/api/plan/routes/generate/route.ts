import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import { query as sfQuery } from "@/lib/snowflake";
import { latLngToCell } from "h3-js";

const OSRM_URL = process.env.OSRM_URL || "http://localhost:5000";

interface OsrmMatrix {
  distances: number[][];
  durations: number[][];
  coordIndex: Map<string, number>;
}

function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

const OSRM_BATCH_SIZE = 100;

async function fetchOsrmTableBatch(
  coords: { lat: number; lng: number }[]
): Promise<{ distances: number[][]; durations: number[][] } | null> {
  const coordStr = coords.map((c) => `${c.lng},${c.lat}`).join(";");
  const url = `${OSRM_URL}/table/v1/driving/${coordStr}?annotations=duration,distance&exclude=motorway`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`OSRM table batch failed: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.code !== "Ok") {
      console.warn(`OSRM table batch error: ${json.code} - ${json.message ?? ""}`);
      return null;
    }
    return {
      distances: json.distances.map((row: number[]) => row.map((d: number) => d / 1000)),
      durations: json.durations.map((row: number[]) => row.map((d: number) => d / 60)),
    };
  } catch (e) {
    console.warn("OSRM table batch error:", (e as Error).message);
    return null;
  }
}

async function fetchOsrmMatrix(
  points: { lat: number; lng: number }[]
): Promise<OsrmMatrix | null> {
  if (points.length < 2) return null;
  const unique = new Map<string, { lat: number; lng: number }>();
  for (const p of points) {
    const k = coordKey(p.lat, p.lng);
    if (!unique.has(k)) unique.set(k, p);
  }
  const coords = [...unique.values()];
  if (coords.length < 2) return null;

  console.log(`OSRM: requesting matrix for ${coords.length} unique points (URL=${OSRM_URL})`);

  if (coords.length <= OSRM_BATCH_SIZE) {
    const result = await fetchOsrmTableBatch(coords);
    if (!result) return null;
    const idx = new Map<string, number>();
    coords.forEach((c, i) => idx.set(coordKey(c.lat, c.lng), i));
    return { ...result, coordIndex: idx };
  }

  const n = coords.length;
  const distances: number[][] = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const durations: number[][] = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) {
    distances[i][i] = 0;
    durations[i][i] = 0;
  }

  let successCount = 0;
  let failCount = 0;

  for (let si = 0; si < n; si += OSRM_BATCH_SIZE) {
    const srcEnd = Math.min(si + OSRM_BATCH_SIZE, n);
    const srcSlice = coords.slice(si, srcEnd);

    for (let di = 0; di < n; di += OSRM_BATCH_SIZE) {
      const dstEnd = Math.min(di + OSRM_BATCH_SIZE, n);
      const dstSlice = coords.slice(di, dstEnd);

      const merged = [...srcSlice, ...dstSlice];
      const dedup = new Map<string, number>();
      const mergedUnique: { lat: number; lng: number }[] = [];
      for (const c of merged) {
        const k = coordKey(c.lat, c.lng);
        if (!dedup.has(k)) {
          dedup.set(k, mergedUnique.length);
          mergedUnique.push(c);
        }
      }

      const srcIndices = srcSlice.map((c) => dedup.get(coordKey(c.lat, c.lng))!);
      const dstIndices = dstSlice.map((c) => dedup.get(coordKey(c.lat, c.lng))!);

      const coordStr = mergedUnique.map((c) => `${c.lng},${c.lat}`).join(";");
      const url = `${OSRM_URL}/table/v1/driving/${coordStr}?annotations=duration,distance&exclude=motorway&sources=${srcIndices.join(";")}&destinations=${dstIndices.join(";")}`;

      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) { failCount++; continue; }
        const json = await res.json();
        if (json.code !== "Ok") { failCount++; continue; }

        for (let r = 0; r < srcSlice.length; r++) {
          for (let c = 0; c < dstSlice.length; c++) {
            const globalR = si + r;
            const globalC = di + c;
            const dRaw = json.distances[r][c];
            const tRaw = json.durations[r][c];
            if (dRaw != null && isFinite(dRaw)) distances[globalR][globalC] = dRaw / 1000;
            if (tRaw != null && isFinite(tRaw)) durations[globalR][globalC] = tRaw / 60;
          }
        }
        successCount++;
      } catch {
        failCount++;
      }
    }
  }

  if (successCount === 0) {
    console.warn("OSRM: all batches failed");
    return null;
  }

  console.log(`OSRM: matrix built from ${successCount} batches (${failCount} failed)`);
  const idx = new Map<string, number>();
  coords.forEach((c, i) => idx.set(coordKey(c.lat, c.lng), i));
  return { distances, durations, coordIndex: idx };
}

function osrmDistKm(matrix: OsrmMatrix | null, fromLat: number, fromLng: number, toLat: number, toLng: number): number | null {
  if (!matrix) return null;
  const fi = matrix.coordIndex.get(coordKey(fromLat, fromLng));
  const ti = matrix.coordIndex.get(coordKey(toLat, toLng));
  if (fi === undefined || ti === undefined) return null;
  const v = matrix.distances[fi][ti];
  if (v === null || v === undefined || !isFinite(v)) return null;
  return v;
}

function osrmDurationMin(matrix: OsrmMatrix | null, fromLat: number, fromLng: number, toLat: number, toLng: number): number | null {
  if (!matrix) return null;
  const fi = matrix.coordIndex.get(coordKey(fromLat, fromLng));
  const ti = matrix.coordIndex.get(coordKey(toLat, toLng));
  if (fi === undefined || ti === undefined) return null;
  const v = matrix.durations[fi][ti];
  if (v === null || v === undefined || !isFinite(v)) return null;
  return v;
}

async function fetchOsrmRouteSegment(
  points: { lat: number; lng: number }[]
): Promise<{ lat: number; lng: number }[] | null> {
  if (points.length < 2) return points;
  const coordStr = points.map((c) => `${c.lng},${c.lat}`).join(";");
  const url = `${OSRM_URL}/route/v1/driving/${coordStr}?overview=full&geometries=geojson&exclude=motorway`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`OSRM route segment failed: HTTP ${res.status} (${points.length} pts) ${body.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    if (json.code !== "Ok" || !json.routes?.[0]) {
      console.warn(`OSRM route segment error: ${json.code} (${points.length} pts)`);
      return null;
    }
    const coords: [number, number][] = json.routes[0].geometry.coordinates;
    return coords.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  } catch (e) {
    console.warn(`OSRM route segment exception: ${(e as Error).message} (${points.length} pts)`);
    return null;
  }
}

const ROUTE_SEGMENT_SIZE = 25;

async function fetchOsrmRoute(
  points: { lat: number; lng: number }[]
): Promise<{ lat: number; lng: number }[]> {
  if (points.length < 2) return points;

  if (points.length <= ROUTE_SEGMENT_SIZE) {
    const result = await fetchOsrmRouteSegment(points);
    if (result) {
      console.log(`OSRM route: ${points.length} waypoints → ${result.length} geometry points`);
      return result;
    }
    return points;
  }

  const allCoords: { lat: number; lng: number }[] = [];
  let failedSegments = 0;
  for (let i = 0; i < points.length - 1; i += ROUTE_SEGMENT_SIZE - 1) {
    const end = Math.min(i + ROUTE_SEGMENT_SIZE, points.length);
    const segment = points.slice(i, end);
    const result = await fetchOsrmRouteSegment(segment);
    if (result) {
      if (allCoords.length > 0) result.shift();
      allCoords.push(...result);
    } else {
      failedSegments++;
      const fallback = segment.slice(allCoords.length === 0 ? 0 : 1);
      allCoords.push(...fallback);
    }
  }
  if (allCoords.length > 0) {
    console.log(`OSRM route: ${points.length} waypoints → ${allCoords.length} geometry points (segmented, ${failedSegments} segments fell back)`);
    return allCoords;
  }
  console.warn(`OSRM route fallback to straight lines (${points.length} waypoints)`);
  return points;
}

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
  costMap: CostMap,
  osrm?: OsrmMatrix | null
): number {
  const od = osrmDistKm(osrm ?? null, fromLat, fromLng, toLat, toLng);
  if (od !== null) return od;
  if (fromH3R10 && toH3R10 && fromH3R10 !== toH3R10) {
    const c = costMap.get(costKey(fromH3R10, toH3R10));
    if (c !== undefined) return c;
  }
  return haversine(fromLat, fromLng, toLat, toLng);
}

const COST_RES = 10;
const RISK_RES = 10;

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

function travelMinutes(distKm: number, osrmMin?: number | null): number {
  if (osrmMin !== null && osrmMin !== undefined && isFinite(osrmMin)) return osrmMin;
  return (distKm / AVG_SPEED_KMH) * 60;
}

function parseTimeWindow(tw: string | null): { start: number; end: number } | null {
  if (!tw) return null;
  const match = tw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) return null;
  return { start: timeToMinutes(match[1]), end: timeToMinutes(match[2]) };
}

const CLUSTER_RES = 8;

function toClusterCell(lat: number, lng: number): string {
  try {
    return latLngToCell(lat, lng, CLUSTER_RES);
  } catch {
    return "";
  }
}

interface Cluster {
  id: number;
  cells: Set<string>;
  packages: PackageRow[];
  centroidLat: number;
  centroidLng: number;
  totalWeight: number;
  totalVolume: number;
}

function clusterPackages(pkgs: PackageRow[]): Cluster[] {
  const cellMap = new Map<string, PackageRow[]>();
  for (const p of pkgs) {
    const cell = toClusterCell(p.lat, p.lng);
    if (!cell) continue;
    if (!cellMap.has(cell)) cellMap.set(cell, []);
    cellMap.get(cell)!.push(p);
  }

  const clusters: Cluster[] = [];
  let nextId = 0;

  for (const [, cellPkgs] of cellMap) {
    const cluster: Cluster = {
      id: nextId++,
      cells: new Set(),
      packages: cellPkgs,
      centroidLat: cellPkgs.reduce((s, p) => s + p.lat, 0) / cellPkgs.length,
      centroidLng: cellPkgs.reduce((s, p) => s + p.lng, 0) / cellPkgs.length,
      totalWeight: cellPkgs.reduce((s, p) => s + p.weight, 0),
      totalVolume: cellPkgs.reduce((s, p) => s + p.volume, 0),
    };
    clusters.push(cluster);
  }

  return clusters;
}

function splitLargeClusters(clusters: Cluster[], maxSize: number, maxWeight: number): Cluster[] {
  const result: Cluster[] = [];
  let nextId = clusters.length;
  for (const c of clusters) {
    if (c.packages.length <= maxSize && c.totalWeight <= maxWeight) {
      result.push(c);
      continue;
    }
    const sorted = [...c.packages].sort((a, b) => a.lat - b.lat || a.lng - b.lng);
    let chunk: PackageRow[] = [];
    let chunkWeight = 0;
    for (const p of sorted) {
      if (chunk.length >= maxSize || (chunkWeight + p.weight > maxWeight && chunk.length > 0)) {
        const sub: Cluster = {
          id: nextId++,
          cells: new Set(),
          packages: chunk,
          centroidLat: chunk.reduce((s, x) => s + x.lat, 0) / chunk.length,
          centroidLng: chunk.reduce((s, x) => s + x.lng, 0) / chunk.length,
          totalWeight: chunkWeight,
          totalVolume: chunk.reduce((s, x) => s + x.volume, 0),
        };
        result.push(sub);
        chunk = [];
        chunkWeight = 0;
      }
      chunk.push(p);
      chunkWeight += p.weight;
    }
    if (chunk.length > 0) {
      const sub: Cluster = {
        id: nextId++,
        cells: new Set(),
        packages: chunk,
        centroidLat: chunk.reduce((s, x) => s + x.lat, 0) / chunk.length,
        centroidLng: chunk.reduce((s, x) => s + x.lng, 0) / chunk.length,
        totalWeight: chunkWeight,
        totalVolume: chunk.reduce((s, x) => s + x.volume, 0),
      };
      result.push(sub);
    }
  }
  return result;
}

function assignClustersByArea(
  timePools: PackageRow[][],
  sortedDrivers: DriverRow[],
  maxTripsGlobal: number
): Map<string, { weight: number; volume: number; packages: PackageRow[] }[]> {
  const driverTrips = new Map<string, { weight: number; volume: number; packages: PackageRow[] }[]>();
  for (const d of sortedDrivers) {
    const trips: { weight: number; volume: number; packages: PackageRow[] }[] = [];
    for (let t = 0; t < d.max_trips; t++) {
      trips.push({ weight: 0, volume: 0, packages: [] });
    }
    driverTrips.set(d.driver_id, trips);
  }

  const minCap = Math.min(...sortedDrivers.map((d) => d.vehicle_capacity));
  const avgTrips = sortedDrivers.reduce((s, d) => s + d.max_trips, 0) / sortedDrivers.length;
  const totalPkgs = timePools.flat().length;
  const targetPerTrip = Math.min(MAX_PACKAGES_PER_TRIP, Math.ceil(totalPkgs / (sortedDrivers.length * avgTrips) * 1.3));
  const targetWeight = minCap / avgTrips * 0.85;

  function tryAssignCluster(cluster: Cluster, preferTrip: number): boolean {
    let bestDriver: DriverRow | null = null;
    let bestTrip = preferTrip;
    let bestScore = Infinity;

    const tryTrips = [preferTrip];
    for (let t = 0; t < maxTripsGlobal; t++) {
      if (t !== preferTrip) tryTrips.push(t);
    }

    for (const d of sortedDrivers) {
      const trips = driverTrips.get(d.driver_id)!;
      for (const ti of tryTrips) {
        if (ti >= trips.length) continue;
        const load = trips[ti];
        if (load.weight + cluster.totalWeight > d.vehicle_capacity) continue;
        if (load.volume + cluster.totalVolume > d.vehicle_volume) continue;
        if (load.packages.length + cluster.packages.length > targetPerTrip) continue;

        let areaAffinity = haversine(cluster.centroidLat, cluster.centroidLng, d.depot_lat, d.depot_lng);
        if (load.packages.length > 0) {
          const avgLat = load.packages.reduce((s, p) => s + p.lat, 0) / load.packages.length;
          const avgLng = load.packages.reduce((s, p) => s + p.lng, 0) / load.packages.length;
          areaAffinity = haversine(cluster.centroidLat, cluster.centroidLng, avgLat, avgLng);
        }

        const tripPenalty = ti !== preferTrip ? 2 : 0;
        const totalPkgs = trips.reduce((s, t) => s + t.packages.length, 0);
        const score = areaAffinity * 5 + totalPkgs * 0.1 + tripPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestDriver = d;
          bestTrip = ti;
        }
      }
    }

    if (bestDriver) {
      const load = driverTrips.get(bestDriver.driver_id)![bestTrip];
      for (const p of cluster.packages) {
        load.weight += p.weight;
        load.volume += p.volume;
        load.packages.push(p);
      }
      return true;
    }
    return false;
  }

  function tryAssignSingle(p: PackageRow, preferTrip: number): boolean {
    const tryTrips = [preferTrip];
    for (let t = 0; t < maxTripsGlobal; t++) {
      if (t !== preferTrip) tryTrips.push(t);
    }

    for (const ti of tryTrips) {
      let bestD: DriverRow | null = null;
      let bestS = Infinity;
      for (const d of sortedDrivers) {
        const trips = driverTrips.get(d.driver_id)!;
        if (ti >= trips.length) continue;
        const load = trips[ti];
        if (load.weight + p.weight > d.vehicle_capacity) continue;
        if (load.volume + p.volume > d.vehicle_volume) continue;
        if (load.packages.length >= targetPerTrip) continue;
        const totalPkgs = trips.reduce((s, t) => s + t.packages.length, 0);
        let affinity = haversine(p.lat, p.lng, d.depot_lat, d.depot_lng);
        if (load.packages.length > 0) {
          const aLat = load.packages.reduce((s, x) => s + x.lat, 0) / load.packages.length;
          const aLng = load.packages.reduce((s, x) => s + x.lng, 0) / load.packages.length;
          affinity = haversine(p.lat, p.lng, aLat, aLng);
        }
        const sc = affinity * 3 + totalPkgs * 0.1;
        if (sc < bestS) { bestS = sc; bestD = d; }
      }
      if (bestD) {
        const load = driverTrips.get(bestD.driver_id)![ti];
        load.weight += p.weight;
        load.volume += p.volume;
        load.packages.push(p);
        return true;
      }
    }
    return false;
  }

  for (let poolIdx = 0; poolIdx < timePools.length; poolIdx++) {
    const pool = timePools[poolIdx];
    if (pool.length === 0) continue;

    const rawClusters = clusterPackages(pool);
    const clusters = splitLargeClusters(rawClusters, targetPerTrip, targetWeight);
    clusters.sort((a, b) => b.packages.length - a.packages.length);

    for (const cluster of clusters) {
      if (!tryAssignCluster(cluster, poolIdx)) {
        for (const p of cluster.packages) {
          tryAssignSingle(p, poolIdx);
        }
      }
    }
  }

  return driverTrips;
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
  depotH3: string,
  osrm?: OsrmMatrix | null
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
      const dist = travelCost(curH3, destH3, curLat, curLng, p.lat, p.lng, costMap, osrm);
      const oMin = osrmDurationMin(osrm ?? null, curLat, curLng, p.lat, p.lng);
      const travel = travelMinutes(dist, oMin);
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
    const dist = travelCost(curH3, destH3, curLat, curLng, next.lat, next.lng, costMap, osrm);
    const oMin = osrmDurationMin(osrm ?? null, curLat, curLng, next.lat, next.lng);
    const travel = travelMinutes(dist, oMin);
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
    toR10(lastPkg.lat, lastPkg.lng), depotH3, lastPkg.lat, lastPkg.lng, depotLat, depotLng, costMap, osrm
  );
  const retOMin = osrmDurationMin(osrm ?? null, lastPkg.lat, lastPkg.lng, depotLat, depotLng);
  const returnMinutes = curTime + travelMinutes(returnDist, retOMin);

  return { ordered, returnMinutes };
}

function twoOptImprove(
  ordered: (PackageRow & { eta: number })[],
  startLat: number,
  startLng: number,
  startH3: string,
  startMinutes: number,
  costMap: CostMap,
  depotLat: number,
  depotLng: number,
  depotH3: string,
  osrm?: OsrmMatrix | null
): (PackageRow & { eta: number })[] {
  if (ordered.length < 4) return ordered;

  const route = [...ordered];
  const n = route.length;
  let improved = true;
  let iterations = 0;
  const MAX_ITER = 10;

  while (improved && iterations < MAX_ITER) {
    improved = false;
    iterations++;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        const aLat = i === 0 ? startLat : route[i - 1].lat;
        const aLng = i === 0 ? startLng : route[i - 1].lng;
        const aH3 = i === 0 ? startH3 : toR10(route[i - 1].lat, route[i - 1].lng);

        const bLat = j + 1 < n ? route[j + 1].lat : depotLat;
        const bLng = j + 1 < n ? route[j + 1].lng : depotLng;
        const bH3 = j + 1 < n ? toR10(route[j + 1].lat, route[j + 1].lng) : depotH3;

        const iH3 = toR10(route[i].lat, route[i].lng);
        const jH3 = toR10(route[j].lat, route[j].lng);
        const i1H3 = i + 1 < n ? toR10(route[i + 1].lat, route[i + 1].lng) : depotH3;

        const dBefore =
          travelCost(aH3, iH3, aLat, aLng, route[i].lat, route[i].lng, costMap, osrm) +
          travelCost(jH3, bH3, route[j].lat, route[j].lng, bLat, bLng, costMap, osrm);
        const dAfter =
          travelCost(aH3, jH3, aLat, aLng, route[j].lat, route[j].lng, costMap, osrm) +
          travelCost(iH3, bH3, route[i].lat, route[i].lng, bLat, bLng, costMap, osrm);

        if (dAfter < dBefore - 0.001) {
          const segment = route.slice(i, j + 1).reverse();
          for (let k = 0; k < segment.length; k++) {
            route[i + k] = segment[k];
          }
          improved = true;
        }
      }
    }
  }

  let curLat = startLat;
  let curLng = startLng;
  let curH3 = startH3;
  let curTime = startMinutes;

  for (const p of route) {
    const destH3 = toR10(p.lat, p.lng);
    const dist = travelCost(curH3, destH3, curLat, curLng, p.lat, p.lng, costMap, osrm);
    const oMin = osrmDurationMin(osrm ?? null, curLat, curLng, p.lat, p.lng);
    const travel = travelMinutes(dist, oMin);
    const arriveAt = curTime + travel;

    const tw = parseTimeWindow(p.time_window);
    p.eta = tw && arriveAt < tw.start ? tw.start : arriveAt;

    const dwell = p.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
    curTime = p.eta + dwell;
    curLat = p.lat;
    curLng = p.lng;
    curH3 = destH3;
  }

  return route;
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
        `SELECT child.VALUE::STRING AS H3_INDEX, rs.RISK_SCORE FROM ANALYTICS.RISK_SCORES rs, LATERAL FLATTEN(INPUT => H3_CELL_TO_CHILDREN_STRING(rs.H3_INDEX, 10)) child WHERE rs.DATE = ? AND rs.HOUR = 10`,
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
        `SELECT child.VALUE::STRING AS H3_INDEX, rs.ABSENCE_RATE FROM ANALYTICS.ABSENCE_PATTERNS rs, LATERAL FLATTEN(INPUT => H3_CELL_TO_CHILDREN_STRING(rs.H3_INDEX, 10)) child WHERE rs.DAY_OF_WEEK = ? AND rs.HOUR = 10`,
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

    const osrmPoints = [
      { lat: depotLat, lng: depotLng },
      ...packages.map((p) => ({ lat: p.lat, lng: p.lng })),
      ...drivers.map((d) => ({ lat: d.depot_lat, lng: d.depot_lng })),
    ];
    const osrmMatrix = await fetchOsrmMatrix(osrmPoints);
    if (osrmMatrix) {
      console.log(`OSRM matrix loaded: ${osrmMatrix.coordIndex.size} unique points`);
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

      const driverTrips = assignClustersByArea(timePools, sortedDrivers, maxTripsGlobal);

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

        const tripEntries: { idx: number; load: { weight: number; volume: number; packages: PackageRow[] } }[] = [];
        for (let ti = 0; ti < trips.length; ti++) {
          if (trips[ti].packages.length > 0) tripEntries.push({ idx: ti, load: trips[ti] });
        }

        for (let ti = 0; ti < tripEntries.length; ti++) {
          const { load } = tripEntries[ti];
          const tripNum = tripEntries[ti].idx + 1;
          const departureTime = currentTime;

          const greedy = greedySortWithETA(
            load.packages,
            dDepotLat,
            dDepotLng,
            dDepotH3,
            departureTime,
            costMap,
            dDepotLat,
            dDepotLng,
            dDepotH3,
            osrmMatrix
          );
          const ordered = twoOptImprove(
            greedy.ordered,
            dDepotLat,
            dDepotLng,
            dDepotH3,
            departureTime,
            costMap,
            dDepotLat,
            dDepotLng,
            dDepotH3,
            osrmMatrix
          );
          let returnMinutes = greedy.returnMinutes;
          if (ordered.length > 0) {
            const last2opt = ordered[ordered.length - 1];
            const dwell2opt = last2opt.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
            const retDist = travelCost(toR10(last2opt.lat, last2opt.lng), dDepotH3, last2opt.lat, last2opt.lng, dDepotLat, dDepotLng, costMap, osrmMatrix);
            const retOMin = osrmDurationMin(osrmMatrix, last2opt.lat, last2opt.lng, dDepotLat, dDepotLng);
            returnMinutes = last2opt.eta + dwell2opt + travelMinutes(retDist, retOMin);
          }

          if (returnMinutes > shiftEndMin) {
            let trimCount = 0;
            while (ordered.length > 0) {
              const last = ordered[ordered.length - 1];
              const lastDwell = last.delivery_method === "drop_off" ? DWELL_DROP_OFF : DWELL_FACE_TO_FACE;
              const trimDist = travelCost(toR10(last.lat, last.lng), dDepotH3, last.lat, last.lng, dDepotLat, dDepotLng, costMap, osrmMatrix);
              const trimOMin = osrmDurationMin(osrmMatrix, last.lat, last.lng, dDepotLat, dDepotLng);
              if (last.eta + lastDwell + travelMinutes(trimDist, trimOMin) <= shiftEndMin) break;
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
          const retDist2 = travelCost(toR10(lastStop.lat, lastStop.lng), dDepotH3, lastStop.lat, lastStop.lng, dDepotLat, dDepotLng, costMap, osrmMatrix);
          const retOMin2 = osrmDurationMin(osrmMatrix, lastStop.lat, lastStop.lng, dDepotLat, dDepotLng);
          const actualReturn = lastStop.eta + lastStopDwell + travelMinutes(retDist2, retOMin2);

          const waypointsForRoute = [
            { lat: dDepotLat, lng: dDepotLng },
            ...ordered.map((p) => ({ lat: p.lat, lng: p.lng })),
            { lat: dDepotLat, lng: dDepotLng },
          ];
          const tripRoute = osrmMatrix
            ? await fetchOsrmRoute(waypointsForRoute)
            : waypointsForRoute;

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
      await pgQuery(`DELETE FROM routes WHERE date = $1`, [date]);

      const routeValues: unknown[][] = [];
      const dsUpdates: { driver_id: string; trip: number; stop_order: number; package_id: string }[] = [];
      const pkgUpdates: { route_id: string; stop_order: number; package_id: string }[] = [];

      for (const da of driverAssignments) {
        for (const trip of da.trips) {
          const routeId = `R-${da.driver_id}-${date}-T${trip.trip}`;
          const totalDist = trip.route.reduce((sum, pt, i, arr) => {
            if (i === 0) return 0;
            return sum + haversine(arr[i - 1].lat, arr[i - 1].lng, pt.lat, pt.lng);
          }, 0);
          const timeEst = Math.round((trip.return_time ? timeToMinutes(trip.return_time) : 0) - (trip.departure_time ? timeToMinutes(trip.departure_time) : 0));
          routeValues.push([routeId, da.driver_id, date, Math.round(totalDist * 100) / 100, timeEst, trip.total_packages]);

          for (const pkg of trip.packages) {
            dsUpdates.push({ driver_id: da.driver_id, trip: trip.trip, stop_order: pkg.stop_order, package_id: pkg.package_id });
            pkgUpdates.push({ route_id: routeId, stop_order: pkg.stop_order, package_id: pkg.package_id });
          }
        }
      }

      if (routeValues.length > 0) {
        const rPlaceholders = routeValues.map((_, i) => {
          const b = i * 6;
          return `($${b+1}, $${b+2}, (SELECT depot_id FROM drivers WHERE driver_id = $${b+2}), $${b+3}, $${b+4}, $${b+5}, $${b+6}, 'planned')`;
        }).join(",\n");
        await pgQuery(
          `INSERT INTO routes (route_id, driver_id, depot_id, date, total_distance, total_time_est, stop_count, status) VALUES ${rPlaceholders}`,
          routeValues.flat()
        );
      }

      const DS_BATCH = 200;
      for (let i = 0; i < dsUpdates.length; i += DS_BATCH) {
        const batch = dsUpdates.slice(i, i + DS_BATCH);
        const vals = batch.map((_, j) => {
          const b = j * 5;
          return `($${b+1}, $${b+2}::int, $${b+3}::int, $${b+4}, $${b+5}::date)`;
        }).join(", ");
        await pgQuery(
          `UPDATE delivery_status ds SET
             driver_id = v.driver_id, trip_number = v.trip, stop_order = v.stop_order, status = 'assigned', updated_at = NOW()
           FROM (VALUES ${vals}) AS v(driver_id, trip, stop_order, package_id, date)
           WHERE ds.package_id = v.package_id AND ds.date = v.date`,
          batch.flatMap((u) => [u.driver_id, u.trip, u.stop_order, u.package_id, date])
        );
      }

      for (let i = 0; i < pkgUpdates.length; i += DS_BATCH) {
        const batch = pkgUpdates.slice(i, i + DS_BATCH);
        const vals = batch.map((_, j) => {
          const b = j * 3;
          return `($${b+1}, $${b+2}::int, $${b+3})`;
        }).join(", ");
        await pgQuery(
          `UPDATE packages p SET route_id = v.route_id, stop_order = v.stop_order
           FROM (VALUES ${vals}) AS v(route_id, stop_order, package_id)
           WHERE p.package_id = v.package_id`,
          batch.flatMap((u) => [u.route_id, u.stop_order, u.package_id])
        );
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
        osrm_enabled: osrmMatrix !== null,
        osrm_points: osrmMatrix?.coordIndex.size ?? 0,
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
