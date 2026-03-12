import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { DemandForecast } from "@/types";

function generateFallbackForecast(): DemandForecast[] {
  const base = 487;
  const result: DemandForecast[] = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    const jitter = Math.round((Math.random() - 0.5) * 40);
    const vol = base + jitter;
    result.push({
      DEPOT_ID: "DEPOT-TOYOSU",
      DATE: dateStr,
      FORECAST_VOLUME: vol,
      CONFIDENCE_LOWER: vol - 30,
      CONFIDENCE_UPPER: vol + 30,
    });
  }
  return result;
}

export async function GET() {
  try {
    const rows = await pgQuery<{
      depot_id: string;
      date: string;
      forecast_volume: number;
      confidence_lower: number;
      confidence_upper: number;
    }>(
      `SELECT depot_id, date::text AS date, forecast_volume, confidence_lower, confidence_upper
       FROM ft_demand_forecast
       ORDER BY date`
    );
    if (rows.length > 0) {
      const mapped: DemandForecast[] = rows.map((r) => ({
        DEPOT_ID: r.depot_id,
        DATE: r.date,
        FORECAST_VOLUME: r.forecast_volume,
        CONFIDENCE_LOWER: r.confidence_lower,
        CONFIDENCE_UPPER: r.confidence_upper,
      }));
      return NextResponse.json(mapped);
    }
    return NextResponse.json(generateFallbackForecast());
  } catch (error) {
    console.error("Demand forecast error, using fallback:", error);
    return NextResponse.json(generateFallbackForecast());
  }
}
