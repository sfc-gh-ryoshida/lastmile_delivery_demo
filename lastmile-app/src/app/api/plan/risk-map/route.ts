import { NextResponse } from "next/server";
import { query as sfQuery } from "@/lib/snowflake";
import { pgQuery } from "@/lib/postgres";
import type { RiskScore } from "@/types";

const VALID_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

function nearestHour(h: number): number {
  let best = VALID_HOURS[0];
  let diff = Math.abs(h - best);
  for (const v of VALID_HOURS) {
    const d = Math.abs(h - v);
    if (d < diff) { diff = d; best = v; }
  }
  return best;
}

interface RawRow {
  H3_INDEX?: string; h3_index?: string;
  DATE?: string; date?: string;
  HOUR?: number; hour?: number;
  RISK_SCORE?: number; risk_score?: number;
  WEATHER_RISK?: number; weather_risk?: number;
  ABSENCE_RISK?: number; absence_risk?: number;
  BUILDING_RISK?: number; building_risk?: number;
  POI_RISK?: number; poi_risk?: number;
}

function toRiskScores(rows: RawRow[]): RiskScore[] {
  return rows.map((r) => ({
    H3_INDEX: r.H3_INDEX || r.h3_index || "",
    DATE: String(r.DATE || r.date || ""),
    HOUR: r.HOUR ?? r.hour ?? 0,
    RISK_SCORE: r.RISK_SCORE ?? r.risk_score ?? 0,
    RISK_FACTORS: {
      base_absent_rate: r.ABSENCE_RISK ?? r.absence_risk ?? 0,
      weather_effect: r.WEATHER_RISK ?? r.weather_risk ?? 0,
      building_mult: r.BUILDING_RISK ?? r.building_risk ?? 0,
      poi_mult: r.POI_RISK ?? r.poi_risk ?? 0,
    },
  }));
}

const DATA_RES = 9;

async function fetchFromSnowflake(date: string, hour: number | null, resolution: number): Promise<RawRow[]> {
  const hourFilter = hour !== null ? "AND HOUR = ?" : "";
  const params = hour !== null ? [date, hour] : [date];
  const sql =
    resolution === DATA_RES
      ? `SELECT H3_INDEX, DATE, HOUR, RISK_SCORE,
                WEATHER_RISK, ABSENCE_RISK, BUILDING_RISK, POI_RISK
         FROM ANALYTICS.RISK_SCORES
         WHERE DATE = ? ${hourFilter}
         ORDER BY RISK_SCORE DESC`
    : resolution > DATA_RES
      ? `SELECT child.VALUE::STRING AS H3_INDEX,
                rs.DATE, rs.HOUR, rs.RISK_SCORE,
                rs.WEATHER_RISK, rs.ABSENCE_RISK, rs.BUILDING_RISK, rs.POI_RISK
         FROM ANALYTICS.RISK_SCORES rs,
              LATERAL FLATTEN(INPUT => H3_CELL_TO_CHILDREN_STRING(rs.H3_INDEX, ${resolution})) child
         WHERE rs.DATE = ? ${hourFilter}
         ORDER BY rs.RISK_SCORE DESC`
      : `SELECT H3_CELL_TO_PARENT(H3_INDEX, ${resolution})::STRING AS H3_INDEX,
                DATE, HOUR,
                AVG(RISK_SCORE) AS RISK_SCORE,
                AVG(WEATHER_RISK) AS WEATHER_RISK,
                AVG(ABSENCE_RISK) AS ABSENCE_RISK,
                AVG(BUILDING_RISK) AS BUILDING_RISK,
                AVG(POI_RISK) AS POI_RISK
         FROM ANALYTICS.RISK_SCORES
         WHERE DATE = ? ${hourFilter}
         GROUP BY 1, 2, 3
         ORDER BY RISK_SCORE DESC`;
  return sfQuery<RawRow>(sql, params);
}

async function fetchFromPostgres(date: string, hour: number | null, resolution: number): Promise<RawRow[]> {
  const hourFilter = hour !== null ? "AND hour = $2" : "";
  const params = hour !== null ? [date, hour] : [date];
  const sql =
    resolution === DATA_RES
      ? `SELECT h3_index, date, hour, risk_score,
                weather_risk, absence_risk, building_risk, poi_risk
         FROM ft_risk_scores
         WHERE date = $1 ${hourFilter}
         ORDER BY risk_score DESC`
    : resolution > DATA_RES
      ? `SELECT h3_cell_to_children(h3_index::h3index, ${resolution})::text AS h3_index,
                date, hour, risk_score,
                weather_risk, absence_risk, building_risk, poi_risk
         FROM ft_risk_scores
         WHERE date = $1 ${hourFilter}
         ORDER BY risk_score DESC`
      : `SELECT h3_cell_to_parent(h3_index::h3index, ${resolution})::text AS h3_index,
                date, hour,
                AVG(risk_score) AS risk_score,
                AVG(weather_risk) AS weather_risk,
                AVG(absence_risk) AS absence_risk,
                AVG(building_risk) AS building_risk,
                AVG(poi_risk) AS poi_risk
         FROM ft_risk_scores
         WHERE date = $1 ${hourFilter}
         GROUP BY 1, 2, 3
         ORDER BY risk_score DESC`;
  return pgQuery<RawRow>(sql, params);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];
  const hourParam = searchParams.get("hour");
  const hour = hourParam === "all" ? null : nearestHour(parseInt(hourParam || String(new Date().getHours())));
  const res = parseInt(searchParams.get("resolution") || "11");
  const resolution = [7, 8, 9, 10, 11].includes(res) ? res : 11;
  const source = searchParams.get("source") || "sf";

  try {
    if (source === "compare") {
      const [sfResult, pgResult] = await Promise.allSettled([
        timed(() => fetchFromSnowflake(date, hour, resolution)),
        timed(() => fetchFromPostgres(date, hour, resolution)),
      ]);

      const sf = sfResult.status === "fulfilled" ? sfResult.value : null;
      const pg = pgResult.status === "fulfilled" ? pgResult.value : null;

      return NextResponse.json({
        snowflake: {
          ok: !!sf,
          ms: sf?.ms ?? null,
          rows: sf ? toRiskScores(sf.data).length : 0,
          error: sfResult.status === "rejected" ? String(sfResult.reason) : null,
          data: sf ? toRiskScores(sf.data) : [],
        },
        postgres: {
          ok: !!pg,
          ms: pg?.ms ?? null,
          rows: pg ? toRiskScores(pg.data).length : 0,
          error: pgResult.status === "rejected" ? String(pgResult.reason) : null,
          data: pg ? toRiskScores(pg.data) : [],
        },
      });
    }

    const start = performance.now();
    const rows =
      source === "pg"
        ? await fetchFromPostgres(date, hour, resolution)
        : await fetchFromSnowflake(date, hour, resolution);
    const ms = Math.round(performance.now() - start);

    const mapped = toRiskScores(rows);
    return NextResponse.json(mapped, {
      headers: { "X-Source": source, "X-Query-Ms": String(ms), "X-Row-Count": String(mapped.length) },
    });
  } catch (error) {
    console.error("Error fetching risk map:", error);
    return NextResponse.json([], { status: 200 });
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ data: T; ms: number }> {
  const start = performance.now();
  const data = await fn();
  return { data, ms: Math.round(performance.now() - start) };
}
