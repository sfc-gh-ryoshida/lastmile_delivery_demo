import { NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import type { WeatherForecast } from "@/types";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const rows = await query<WeatherForecast>(
      `SELECT H3_INDEX, DATETIME, PRECIPITATION, WIND_SPEED, TEMPERATURE, WEATHER_CODE
       FROM LASTMILE_DB.ANALYTICS.V_WEATHER_FORECAST_LIVE
       WHERE DATETIME::DATE = ?
       ORDER BY DATETIME`,
      [date]
    );
    if (rows.length === 0) {
      const fallback = await query<WeatherForecast>(
        `SELECT H3_INDEX, DATETIME, PRECIPITATION, WIND_SPEED, TEMPERATURE, WEATHER_CODE
         FROM LASTMILE_DB.ANALYTICS.WEATHER_FORECAST
         WHERE DATETIME::DATE = ?
         ORDER BY DATETIME`,
        [date]
      );
      if (fallback.length === 0) {
        const latest = await query<WeatherForecast>(
          `SELECT H3_INDEX, DATETIME, PRECIPITATION, WIND_SPEED, TEMPERATURE, WEATHER_CODE
           FROM LASTMILE_DB.ANALYTICS.V_WEATHER_FORECAST_LIVE
           ORDER BY DATETIME
           LIMIT 200`
        );
        return NextResponse.json(latest);
      }
      return NextResponse.json(fallback);
    }
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching weather:", error);
    return NextResponse.json({ error: "Failed to fetch weather" }, { status: 500 });
  }
}
