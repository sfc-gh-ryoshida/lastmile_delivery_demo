import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import { latLngToCell } from "h3-js";

interface DriverImpact {
  driver_id: string;
  name: string;
  driver_h3: string;
  driver_lat: number;
  driver_lng: number;
  distance_ring: number;
  affected_packages: number;
  total_packages: number;
  delivered: number;
  remaining: number;
  packages_in_zone: number;
  driver_in_zone: boolean;
  impact_reasons: string[];
  impact_detail: string;
  recommended_action: string;
  route_blocked_pct: number;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get("lat") || "0");
  const lng = parseFloat(searchParams.get("lng") || "0");
  const k = parseInt(searchParams.get("k") || "2", 10);

  if (!lat || !lng) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }

  try {
    const impactCells = await pgQuery<{
      h3_index: string;
      ring: number;
    }>(
      `WITH center AS (
        SELECT h3_latlng_to_cell(point($2::double precision, $1::double precision), 11) AS cell
      ),
      disk AS (
        SELECT h3_grid_disk((SELECT cell FROM center), $3) AS h3_cell
      )
      SELECT
        h3_cell::text AS h3_index,
        h3_grid_distance((SELECT cell FROM center), h3_cell) AS ring
      FROM disk`,
      [lat, lng, k]
    );

    const today = new Date().toISOString().split("T")[0];
    const parsedCells = impactCells.map((c) => ({ ...c, ring: Number(c.ring) }));
    const centerH3 = parsedCells.find((c) => c.ring === 0)?.h3_index || "";
    const cellH3List = parsedCells.map((c) => c.h3_index);

    const trafficData = await pgQuery<{
      child_h3: string;
      congestion_level: number;
      speed_ratio: number;
    }>(
      `WITH impact AS (
        SELECT unnest($1::h3index[]) AS child_cell
      ),
      parent_map AS (
        SELECT child_cell, h3_cell_to_parent(child_cell, 7) AS parent_cell
        FROM impact
      )
      SELECT
        pm.child_cell::text AS child_h3,
        t.congestion_level,
        t.speed_ratio
      FROM parent_map pm
      JOIN traffic_realtime t ON t.h3_index = pm.parent_cell
      WHERE t.datetime > NOW() - INTERVAL '2 hours'
      ORDER BY t.datetime DESC`,
      [cellH3List]
    );

    const trafficMap = new Map<string, { congestion_level: number; speed_ratio: number }>();
    for (const t of trafficData) {
      if (!trafficMap.has(t.child_h3)) {
        trafficMap.set(t.child_h3, {
          congestion_level: Number(t.congestion_level),
          speed_ratio: Number(t.speed_ratio),
        });
      }
    }

    const constructionData = await pgQuery<{
      child_h3: string;
      restriction_type: string;
    }>(
      `WITH impact AS (
        SELECT unnest($1::h3index[]) AS child_cell
      )
      SELECT i.child_cell::text AS child_h3, rc.restriction_type
      FROM impact i
      JOIN road_construction rc ON rc.h3_index = h3_cell_to_parent(i.child_cell, 9)
      WHERE rc.start_date <= $2
        AND (rc.end_date IS NULL OR rc.end_date >= $2)`,
      [cellH3List, today]
    );

    const constructionMap = new Map<string, string>();
    for (const c of constructionData) {
      constructionMap.set(c.child_h3, c.restriction_type);
    }

    const enrichedCells = parsedCells.map((cell) => {
      const traffic = trafficMap.get(cell.h3_index);
      const construction = constructionMap.get(cell.h3_index);

      const ringFactor = cell.ring === 0 ? 1.0 : cell.ring === 1 ? 0.7 : 0.4;
      let congestionFactor = 1.0;
      if (traffic) {
        congestionFactor = 1.0 + traffic.congestion_level * 0.25;
        if (traffic.speed_ratio < 0.5) congestionFactor += 0.5;
      }
      const constructionFactor = construction ? 1.5 : 1.0;
      const impact_weight = +(ringFactor * congestionFactor * constructionFactor).toFixed(2);

      return {
        h3_index: cell.h3_index,
        ring: cell.ring,
        impact_weight,
        congestion_level: traffic?.congestion_level ?? null,
        speed_ratio: traffic?.speed_ratio ?? null,
        has_construction: !!construction,
        restriction_type: construction ?? null,
      };
    });

    const ringMap = new Map(parsedCells.map((c) => [c.h3_index, c.ring]));

    const driverDetails = await pgQuery<{
      driver_id: string;
      name: string;
      driver_h3: string;
      driver_lat: number;
      driver_lng: number;
      total_packages: number;
      delivered: number;
      remaining: number;
      packages_in_zone: number;
    }>(
      `WITH impact_zone AS (
        SELECT unnest($1::h3index[]) AS h3_cell
      ),
      impact_r9 AS (
        SELECT DISTINCT h3_cell_to_parent(h3_cell, 9) AS h3_r9 FROM impact_zone
      ),
      pkg_stats AS (
        SELECT
          ds.driver_id,
          COUNT(*)::int AS total_packages,
          COUNT(*) FILTER (WHERE ds.status = 'delivered')::int AS delivered,
          COUNT(*) FILTER (WHERE ds.status != 'delivered')::int AS remaining,
          COUNT(*) FILTER (WHERE p.h3_index::h3index IN (SELECT h3_r9 FROM impact_r9))::int AS packages_in_zone
        FROM packages p
        JOIN delivery_status ds ON ds.package_id = p.package_id
        WHERE p.date = $2
        GROUP BY ds.driver_id
      )
      SELECT
        d.driver_id,
        d.name,
        dl.h3_index::text AS driver_h3,
        dl.lat::float AS driver_lat,
        dl.lng::float AS driver_lng,
        COALESCE(ps.total_packages, 0)::int AS total_packages,
        COALESCE(ps.delivered, 0)::int AS delivered,
        COALESCE(ps.remaining, 0)::int AS remaining,
        COALESCE(ps.packages_in_zone, 0)::int AS packages_in_zone
      FROM drivers d
      LEFT JOIN driver_locations dl ON dl.driver_id = d.driver_id
      LEFT JOIN pkg_stats ps ON ps.driver_id = d.driver_id
      WHERE d.is_active = true
        AND (
          COALESCE(ps.packages_in_zone, 0) > 0
          OR dl.h3_index IN (SELECT h3_r9 FROM impact_r9)
        )
      ORDER BY d.driver_id`,
      [cellH3List, today]
    );

    const cellWeightMap = new Map(enrichedCells.map((c) => [c.h3_index, c.impact_weight]));

    const affected: DriverImpact[] = driverDetails.map((raw) => {
      let driverH3R11 = "";
      try {
        driverH3R11 = latLngToCell(Number(raw.driver_lat), Number(raw.driver_lng), 11);
      } catch { /* ignore */ }
      const driverRing = ringMap.get(driverH3R11) ?? -1;
      const r = { ...raw, driver_ring: driverRing, packages_in_zone: Number(raw.packages_in_zone) };
      const driverInZone = r.driver_ring >= 0 && r.driver_ring <= k;
      const reasons: string[] = [];
      let detail = "";
      let action = "";

      const driverCellWeight = cellWeightMap.get(r.driver_h3) ?? 1.0;
      const isCongested = driverCellWeight > 1.2;

      if (driverInZone && r.driver_ring === 0) {
        reasons.push("driver_at_epicenter");
        detail = `${r.name}の現在位置（H3: ${r.driver_h3.slice(-7)}）が事故地点のH3セルと完全に一致。直接巻き込まれている可能性があります。`;
        action = "安否確認を最優先で実施。応答がない場合は現地確認を手配してください。残荷物は他ドライバーへ即時再割当てが必要です。";
      } else if (driverInZone && r.driver_ring === 1) {
        reasons.push("driver_adjacent");
        detail = `現在位置が事故地点から${r.driver_ring}リング（約${(r.driver_ring * 25).toLocaleString()}m）。H3隣接セルにいるため通行規制の直接影響を受けます。`;
        action = "迂回ルートを即時通知。影響エリア内の未配達荷物はルート再計算を実行してください。";
      } else if (driverInZone) {
        reasons.push("driver_nearby");
        detail = `現在位置が事故地点から${r.driver_ring}リング（約${(r.driver_ring * 25).toLocaleString()}m）。`;
        if (isCongested) {
          detail += `当該セルは渋滞重要度が高く（重み ${driverCellWeight}）、遅延影響が拡大する見込みです。`;
          action = "渋滞が激しいエリアです。即座に迂回ルートを通知し、影響エリア外の配達を優先してください。";
        } else {
          detail += "渋滞波及による遅延の可能性があります。";
          action = "渋滞情報をモニタリングし、必要に応じてルート変更を指示してください。";
        }
      }

      if (isCongested && driverInZone) {
        reasons.push("high_congestion");
      }

      if (r.packages_in_zone > 0) {
        const pctInZone = Math.round((r.packages_in_zone / Math.max(r.total_packages, 1)) * 100);
        reasons.push("packages_in_zone");
        const pkgDetail = `担当${r.total_packages}件中${r.packages_in_zone}件（${pctInZone}%）の配達先H3セルが影響範囲内。`;
        if (!detail) {
          detail = pkgDetail;
          action = pctInZone > 50
            ? "影響エリアの荷物を他ドライバーへ再割当てし、残りの配達を優先させてください。"
            : "影響エリア外の配達を先に回すルート変更を指示してください。影響エリアは規制解除後に再訪。";
        } else {
          detail += " " + pkgDetail;
          if (pctInZone > 50) {
            action += " 配達先の過半数が影響エリア内のため荷物再割当ても検討してください。";
          }
        }
      }

      const routeBlockedPct = r.total_packages > 0
        ? Math.round((r.packages_in_zone / r.total_packages) * 100)
        : 0;

      return {
        driver_id: r.driver_id,
        name: r.name,
        driver_h3: r.driver_h3,
        driver_lat: r.driver_lat,
        driver_lng: r.driver_lng,
        distance_ring: r.driver_ring,
        affected_packages: r.packages_in_zone,
        total_packages: r.total_packages,
        delivered: r.delivered,
        remaining: r.remaining,
        packages_in_zone: r.packages_in_zone,
        driver_in_zone: driverInZone,
        impact_reasons: reasons,
        impact_detail: detail,
        recommended_action: action,
        route_blocked_pct: routeBlockedPct,
      };
    });

    const h3Resolution = 11;
    const hexEdgeKm = 0.025;
    const totalImpactCells = enrichedCells.length;
    const impactAreaKm2 = +(totalImpactCells * 0.0022).toFixed(4);
    const congestedCells = enrichedCells.filter((c) => c.congestion_level !== null && c.congestion_level >= 1).length;
    const constructionCells = enrichedCells.filter((c) => c.has_construction).length;
    const avgWeight = +(enrichedCells.reduce((s, c) => s + c.impact_weight, 0) / Math.max(enrichedCells.length, 1)).toFixed(2);
    const maxWeight = Math.max(...enrichedCells.map((c) => c.impact_weight));

    return NextResponse.json({
      center: { lat, lng, k, h3_index: centerH3 },
      h3_analysis: {
        resolution: h3Resolution,
        hex_edge_km: hexEdgeKm,
        total_impact_cells: totalImpactCells,
        impact_area_km2: impactAreaKm2,
        rings: Array.from({ length: k + 1 }, (_, i) => ({
          ring: i,
          cells: enrichedCells.filter((c) => c.ring === i).length,
          radius_m: Math.round(i * hexEdgeKm * 1000),
        })),
      },
      road_context: {
        congested_cells: congestedCells,
        construction_cells: constructionCells,
        avg_impact_weight: avgWeight,
        max_impact_weight: maxWeight,
      },
      impact_cells: enrichedCells,
      affected_drivers: affected,
      summary: {
        total_affected_drivers: affected.length,
        drivers_in_zone: affected.filter((d) => d.driver_in_zone).length,
        drivers_with_packages: affected.filter((d) => d.packages_in_zone > 0).length,
        total_affected_packages: affected.reduce((s, d) => s + d.packages_in_zone, 0),
      },
    });
  } catch (error) {
    console.error("Error in incident simulation:", error);
    return NextResponse.json({ error: "Failed to simulate incident" }, { status: 500 });
  }
}
