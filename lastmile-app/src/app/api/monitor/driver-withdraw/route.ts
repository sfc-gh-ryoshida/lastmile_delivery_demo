import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface UndeliveredPkg {
  package_id: string;
  driver_id: string;
  status: string;
  trip_number: number;
  lat: number;
  lng: number;
  weight: number;
  volume: number;
  time_window: string | null;
}

interface AvailableDriver {
  driver_id: string;
  name: string;
  vehicle_capacity: number;
  vehicle_volume: number;
  current_weight: number;
  current_volume: number;
  current_count: number;
  max_trip: number;
  depot_lat: number;
  depot_lng: number;
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, withdraw_driver_id, reason, confirm = false } = body as {
      date: string;
      withdraw_driver_id: string;
      reason?: string;
      confirm?: boolean;
    };

    if (!date || !withdraw_driver_id) {
      return NextResponse.json(
        { error: "date and withdraw_driver_id are required" },
        { status: 400 }
      );
    }

    const undelivered = await pgQuery<UndeliveredPkg>(
      `SELECT ds.package_id, ds.driver_id, ds.status,
              COALESCE(ds.trip_number, 1) AS trip_number,
              p.lat, p.lng, p.weight, p.volume, p.time_window
       FROM delivery_status ds
       JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
       WHERE ds.date = $1 AND ds.driver_id = $2
         AND ds.status NOT IN ('delivered')
       ORDER BY ds.trip_number, ds.stop_order NULLS LAST`,
      [date, withdraw_driver_id]
    );

    if (undelivered.length === 0) {
      return NextResponse.json({
        withdraw_driver_id,
        date,
        reason,
        withdrawn_packages: 0,
        reassignments: [],
        unassigned_packages: [],
        confirmed: false,
      });
    }

    const available = await pgQuery<AvailableDriver>(
      `SELECT
         d.driver_id, d.name,
         d.vehicle_capacity, d.vehicle_volume,
         COALESCE(load.total_weight, 0) AS current_weight,
         COALESCE(load.total_volume, 0) AS current_volume,
         COALESCE(load.pkg_count, 0)::int AS current_count,
         COALESCE(load.max_trip, 1)::int AS max_trip,
         dp.lat AS depot_lat, dp.lng AS depot_lng
       FROM drivers d
       JOIN depots dp ON dp.depot_id = d.depot_id
       LEFT JOIN LATERAL (
         SELECT
           SUM(p.weight) AS total_weight,
           SUM(p.volume) AS total_volume,
           COUNT(*) AS pkg_count,
           MAX(ds.trip_number) AS max_trip
         FROM delivery_status ds
         JOIN packages p ON p.package_id = ds.package_id AND p.date = ds.date
         WHERE ds.date = $1 AND ds.driver_id = d.driver_id
           AND ds.status NOT IN ('delivered', 'returned')
       ) load ON true
       WHERE d.is_active = true AND d.driver_id != $2
       ORDER BY d.skill_level DESC`,
      [date, withdraw_driver_id]
    );

    const reassignments: {
      package_id: string;
      new_driver_id: string;
      new_driver_name: string;
      new_trip_number: number;
      new_stop_order: number;
    }[] = [];
    const unassignedPackages: string[] = [];

    const driverLoad = new Map(
      available.map((d) => [
        d.driver_id,
        {
          weight: Number(d.current_weight),
          volume: Number(d.current_volume),
          count: d.current_count,
          nextTrip: d.max_trip + 1,
          stopCounter: 0,
          name: d.name,
          capacity: Number(d.vehicle_capacity) || 350,
          volumeCap: Number(d.vehicle_volume) || 8,
          lat: Number(d.depot_lat),
          lng: Number(d.depot_lng),
        },
      ])
    );

    for (const pkg of undelivered) {
      const pkgLat = Number(pkg.lat);
      const pkgLng = Number(pkg.lng);
      const pkgWeight = Number(pkg.weight) || 2;
      const pkgVolume = Number(pkg.volume) || 0.02;

      let bestDriver: string | null = null;
      let bestDist = Infinity;

      for (const [driverId, load] of driverLoad) {
        if (load.weight + pkgWeight > load.capacity) continue;
        if (load.volume + pkgVolume > load.volumeCap) continue;
        if (load.count >= 50) continue;

        const dist = haversine(load.lat, load.lng, pkgLat, pkgLng);
        if (dist < bestDist) {
          bestDist = dist;
          bestDriver = driverId;
        }
      }

      if (bestDriver) {
        const load = driverLoad.get(bestDriver)!;
        load.weight += pkgWeight;
        load.volume += pkgVolume;
        load.count += 1;
        load.stopCounter += 1;

        reassignments.push({
          package_id: pkg.package_id,
          new_driver_id: bestDriver,
          new_driver_name: load.name,
          new_trip_number: load.nextTrip,
          new_stop_order: load.stopCounter,
        });
      } else {
        unassignedPackages.push(pkg.package_id);
      }
    }

    if (confirm && reassignments.length > 0) {
      for (const r of reassignments) {
        await pgQuery(
          `UPDATE delivery_status
           SET driver_id = $1, trip_number = $2, stop_order = $3, status = 'assigned', updated_at = NOW()
           WHERE package_id = $4 AND date = $5`,
          [r.new_driver_id, r.new_trip_number, r.new_stop_order, r.package_id, date]
        );
      }

      if (reason) {
        for (const pkg of undelivered) {
          await pgQuery(
            `UPDATE delivery_status
             SET notes = COALESCE(notes, '') || $1, updated_at = NOW()
             WHERE package_id = $2 AND date = $3`,
            [`[離脱] ${reason} `, pkg.package_id, date]
          );
        }
      }

      await pgQuery(
        `UPDATE drivers SET is_active = false WHERE driver_id = $1`,
        [withdraw_driver_id]
      );

      await pgQuery(
        `UPDATE routes SET status = 'cancelled'
         WHERE driver_id = $1 AND date = $2 AND status NOT IN ('completed')`,
        [withdraw_driver_id, date]
      );

      await pgQuery(
        `INSERT INTO driver_attendance (driver_id, date, status, check_out_time, reason)
         VALUES ($1, $2, 'withdrawn', NOW(), $3)
         ON CONFLICT (driver_id, date)
         DO UPDATE SET status = 'withdrawn', check_out_time = NOW(), reason = $3`,
        [withdraw_driver_id, date, reason || null]
      );
    }

    return NextResponse.json({
      withdraw_driver_id,
      date,
      reason,
      withdrawn_packages: undelivered.length,
      reassignments,
      unassigned_packages: unassignedPackages,
      confirmed: confirm,
    });
  } catch (error) {
    console.error("Error processing driver withdrawal:", error);
    return NextResponse.json({ error: "Failed to process driver withdrawal" }, { status: 500 });
  }
}
