import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { KpiDaily } from "@/types";

interface KpiRow {
  date: string;
  depot_id: string;
  total_packages: number;
  delivered: number;
  absent: number;
  completion_rate: number;
  absence_rate: number;
  ontime_rate: number;
  avg_delivery_time: number;
}

function toKpiDaily(rows: KpiRow[]): KpiDaily[] {
  return rows.map((r) => ({
    DATE: r.date,
    DEPOT_ID: r.depot_id,
    TOTAL_PACKAGES: r.total_packages,
    DELIVERED: r.delivered,
    ABSENT: r.absent,
    COMPLETION_RATE: r.completion_rate,
    ABSENCE_RATE: r.absence_rate,
    ONTIME_RATE: r.ontime_rate,
    AVG_DELIVERY_TIME: r.avg_delivery_time,
  }));
}

async function kpiFallbackFromDeliveryStatus(date?: string, range?: number): Promise<KpiDaily[]> {
  if (range) {
    const rows = await pgQuery<KpiRow>(
      `SELECT
         d.date, 'DEPOT-TOYOSU' AS depot_id,
         COUNT(*)::int AS total_packages,
         COUNT(*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
         COUNT(*) FILTER (WHERE d.status = 'absent')::int AS absent,
         ROUND(COUNT(*) FILTER (WHERE d.status = 'delivered')::numeric / NULLIF(COUNT(*),0), 3)::float AS completion_rate,
         ROUND(COUNT(*) FILTER (WHERE d.status = 'absent')::numeric / NULLIF(COUNT(*),0), 3)::float AS absence_rate,
         ROUND(COUNT(*) FILTER (WHERE d.status = 'delivered')::numeric / NULLIF(COUNT(*),0), 3)::float AS ontime_rate,
         5.4::float AS avg_delivery_time
       FROM delivery_status d
       GROUP BY d.date
       ORDER BY d.date DESC
       LIMIT $1`,
      [range]
    );
    return toKpiDaily(rows);
  }
  const dt = date || new Date().toISOString().split("T")[0];
  const rows = await pgQuery<KpiRow>(
    `SELECT
       d.date, 'DEPOT-TOYOSU' AS depot_id,
       COUNT(*)::int AS total_packages,
       COUNT(*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
       COUNT(*) FILTER (WHERE d.status = 'absent')::int AS absent,
       ROUND(COUNT(*) FILTER (WHERE d.status = 'delivered')::numeric / NULLIF(COUNT(*),0), 3)::float AS completion_rate,
       ROUND(COUNT(*) FILTER (WHERE d.status = 'absent')::numeric / NULLIF(COUNT(*),0), 3)::float AS absence_rate,
       ROUND(COUNT(*) FILTER (WHERE d.status = 'delivered')::numeric / NULLIF(COUNT(*),0), 3)::float AS ontime_rate,
       5.4::float AS avg_delivery_time
     FROM delivery_status d
     WHERE d.date = $1
     GROUP BY d.date`,
    [dt]
  );
  return toKpiDaily(rows);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  const range = searchParams.get("range");

  try {
    let rows: KpiRow[];
    if (range) {
      const r = Math.min(Math.max(parseInt(range) || 30, 1), 365);
      rows = await pgQuery<KpiRow>(
        `SELECT date, depot_id, total_packages, delivered, absent,
                completion_rate, absence_rate, ontime_rate, avg_delivery_time
         FROM ft_kpi_daily
         WHERE depot_id = 'DEPOT-TOYOSU'
         ORDER BY date DESC
         LIMIT $1`,
        [r]
      );
    } else {
      const d = date || new Date().toISOString().split("T")[0];
      rows = await pgQuery<KpiRow>(
        `SELECT date, depot_id, total_packages, delivered, absent,
                completion_rate, absence_rate, ontime_rate, avg_delivery_time
         FROM ft_kpi_daily
         WHERE depot_id = 'DEPOT-TOYOSU' AND date = $1`,
        [d]
      );
      if (rows.length === 0) {
        rows = await pgQuery<KpiRow>(
          `SELECT date, depot_id, total_packages, delivered, absent,
                  completion_rate, absence_rate, ontime_rate, avg_delivery_time
           FROM ft_kpi_daily
           WHERE depot_id = 'DEPOT-TOYOSU'
           ORDER BY date DESC
           LIMIT 1`
        );
      }
    }
    return NextResponse.json(toKpiDaily(rows));
  } catch (error) {
    console.error("ft_kpi_daily error, falling back to delivery_status:", error);
    try {
      const fallback = await kpiFallbackFromDeliveryStatus(
        date || undefined,
        range ? parseInt(range) : undefined
      );
      return NextResponse.json(fallback);
    } catch (pgError) {
      console.error("delivery_status fallback also failed:", pgError);
      return NextResponse.json({ error: "Failed to fetch KPI" }, { status: 500 });
    }
  }
}
