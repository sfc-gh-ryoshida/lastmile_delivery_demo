import { NextResponse } from "next/server";
import { query as sfQuery } from "@/lib/snowflake";
import { pgQuery } from "@/lib/postgres";

interface DensityRow {
  H3_INDEX?: string; h3_index?: string;
  APARTMENT_COUNT?: number; apartment_count?: number;
  AVG_FLOORS?: number; avg_floors?: number;
  HAS_BOX_PCT?: number; has_box_pct?: number;
  TOTAL_DELIVERIES?: number; total_deliveries?: number;
  ABSENT_COUNT?: number; absent_count?: number;
  LATE_RATE?: number; late_rate?: number;
}

interface MappedDensity {
  H3_INDEX: string;
  APARTMENT_COUNT: number;
  AVG_FLOORS: number;
  HAS_BOX_PCT: number;
  TOTAL_DELIVERIES: number;
  ABSENT_COUNT: number;
  LATE_RATE: number;
}

function toDensity(rows: DensityRow[]): MappedDensity[] {
  return rows.map((r) => ({
    H3_INDEX: r.H3_INDEX || r.h3_index || "",
    APARTMENT_COUNT: Number(r.APARTMENT_COUNT ?? r.apartment_count ?? 0),
    AVG_FLOORS: Number(r.AVG_FLOORS ?? r.avg_floors ?? 0),
    HAS_BOX_PCT: Number(r.HAS_BOX_PCT ?? r.has_box_pct ?? 0),
    TOTAL_DELIVERIES: Number(r.TOTAL_DELIVERIES ?? r.total_deliveries ?? 0),
    ABSENT_COUNT: Number(r.ABSENT_COUNT ?? r.absent_count ?? 0),
    LATE_RATE: Number(r.LATE_RATE ?? r.late_rate ?? 0),
  }));
}

async function fetchFromSnowflake(resolution: number): Promise<DensityRow[]> {
  const h3Expr =
    resolution === 11
      ? "b.H3_INDEX"
      : `H3_CELL_TO_PARENT(b.H3_INDEX, ${resolution})::STRING`;

  const delivH3 =
    resolution === 11
      ? "d.H3_INDEX_R9"
      : `H3_CELL_TO_PARENT(d.H3_INDEX_R9, ${resolution})::STRING`;

  return sfQuery<DensityRow>(
    `WITH bldg AS (
       SELECT ${h3Expr} AS H3_INDEX,
              COUNT_IF(BUILDING_TYPE = 'apartment') AS APARTMENT_COUNT,
              COALESCE(AVG(IFF(BUILDING_TYPE = 'apartment', AVG_FLOORS, NULL)), 0) AS AVG_FLOORS,
              COALESCE(AVG(IFF(BUILDING_TYPE = 'apartment', IFF(HAS_DELIVERY_BOX, 1.0, 0.0), NULL)), 0) AS HAS_BOX_PCT
       FROM ANALYTICS.BUILDING_ATTRIBUTES b
       GROUP BY 1
       HAVING APARTMENT_COUNT > 0
     ),
     deliv AS (
       SELECT ${delivH3} AS H3_INDEX,
              COUNT(*) AS TOTAL_DELIVERIES,
              COUNT_IF(IS_ABSENT) AS ABSENT_COUNT
       FROM ANALYTICS.DELIVERY_HISTORY d
       WHERE H3_GET_RESOLUTION(d.H3_INDEX_R9) >= ${resolution}
       GROUP BY 1
     )
     SELECT b.H3_INDEX,
            b.APARTMENT_COUNT,
            ROUND(b.AVG_FLOORS, 1) AS AVG_FLOORS,
            ROUND(b.HAS_BOX_PCT, 2) AS HAS_BOX_PCT,
            COALESCE(d.TOTAL_DELIVERIES, 0) AS TOTAL_DELIVERIES,
            COALESCE(d.ABSENT_COUNT, 0) AS ABSENT_COUNT,
            CASE WHEN COALESCE(d.TOTAL_DELIVERIES, 0) > 0
              THEN ROUND(d.ABSENT_COUNT / d.TOTAL_DELIVERIES, 3)
              ELSE 0 END AS LATE_RATE
     FROM bldg b
     LEFT JOIN deliv d ON b.H3_INDEX = d.H3_INDEX
     ORDER BY b.APARTMENT_COUNT DESC`
  );
}

async function fetchFromPostgres(resolution: number): Promise<DensityRow[]> {
  const h3Expr =
    resolution === 11
      ? "b.h3_index"
      : `h3_cell_to_parent(b.h3_index::h3index, ${resolution})::text`;

  const delivH3 =
    resolution === 11
      ? "h3_index_r9"
      : `h3_cell_to_parent(h3_index_r9::h3index, ${resolution})::text`;

  return pgQuery<DensityRow>(
    `WITH bldg AS (
       SELECT ${h3Expr} AS h3_index,
              COUNT(*) FILTER (WHERE building_type = 'apartment') AS apartment_count,
              COALESCE(AVG(CASE WHEN building_type = 'apartment' THEN avg_floors END), 0) AS avg_floors,
              COALESCE(AVG(CASE WHEN building_type = 'apartment' THEN CASE WHEN has_delivery_box THEN 1.0 ELSE 0.0 END END), 0) AS has_box_pct
       FROM ft_building_attributes b
       GROUP BY 1
       HAVING COUNT(*) FILTER (WHERE building_type = 'apartment') > 0
     ),
     deliv AS (
       SELECT ${delivH3} AS h3_index,
              COUNT(*) AS total_deliveries,
              COUNT(*) FILTER (WHERE is_absent) AS absent_count
       FROM ft_delivery_history
       GROUP BY 1
     )
     SELECT b.h3_index,
            b.apartment_count,
            ROUND(b.avg_floors::numeric, 1)::float AS avg_floors,
            ROUND(b.has_box_pct::numeric, 2)::float AS has_box_pct,
            COALESCE(d.total_deliveries, 0) AS total_deliveries,
            COALESCE(d.absent_count, 0) AS absent_count,
            CASE WHEN COALESCE(d.total_deliveries, 0) > 0
              THEN ROUND(d.absent_count::numeric / d.total_deliveries, 3)::float
              ELSE 0 END AS late_rate
     FROM bldg b
     LEFT JOIN deliv d ON b.h3_index = d.h3_index
     ORDER BY b.apartment_count DESC`
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const res = parseInt(searchParams.get("resolution") || "11");
  const resolution = [7, 8, 9, 10, 11].includes(res) ? res : 11;
  const source = searchParams.get("source") || "sf";

  try {
    if (source === "compare") {
      const [sfResult, pgResult] = await Promise.allSettled([
        timed(() => fetchFromSnowflake(resolution)),
        timed(() => fetchFromPostgres(resolution)),
      ]);

      const sf = sfResult.status === "fulfilled" ? sfResult.value : null;
      const pg = pgResult.status === "fulfilled" ? pgResult.value : null;

      return NextResponse.json({
        snowflake: {
          ok: !!sf,
          ms: sf?.ms ?? null,
          rows: sf ? toDensity(sf.data).length : 0,
          error: sfResult.status === "rejected" ? String(sfResult.reason) : null,
          data: sf ? toDensity(sf.data) : [],
        },
        postgres: {
          ok: !!pg,
          ms: pg?.ms ?? null,
          rows: pg ? toDensity(pg.data).length : 0,
          error: pgResult.status === "rejected" ? String(pgResult.reason) : null,
          data: pg ? toDensity(pg.data) : [],
        },
      });
    }

    const start = performance.now();
    const rows =
      source === "pg"
        ? await fetchFromPostgres(resolution)
        : await fetchFromSnowflake(resolution);
    const ms = Math.round(performance.now() - start);

    const mapped = toDensity(rows);
    return NextResponse.json(mapped, {
      headers: { "X-Source": source, "X-Query-Ms": String(ms), "X-Row-Count": String(mapped.length) },
    });
  } catch (error) {
    console.error("Building density error:", error);
    return NextResponse.json({ error: "Failed to fetch building density" }, { status: 500 });
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ data: T; ms: number }> {
  const start = performance.now();
  const data = await fn();
  return { data, ms: Math.round(performance.now() - start) };
}
