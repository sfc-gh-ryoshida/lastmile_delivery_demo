import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";
import type { AbsencePattern } from "@/types";

function generateFallbackAbsence(): AbsencePattern[] {
  const baseH3 = [
    "892f5aad003ffff", "892f5aad007ffff", "892f5aad00bffff",
    "892f5aad00fffff", "892f5aad013ffff", "892f5aad017ffff",
    "892f5aad01bffff", "892f5aad01fffff", "892f5aad023ffff",
    "892f5aad027ffff", "892f5aad02bffff", "892f5aad02fffff",
    "892f5aad033ffff", "892f5aad037ffff", "892f5aad03bffff",
    "892f5aad03fffff", "892f5aad043ffff", "892f5aad047ffff",
    "892f5aad04bffff", "892f5aad04fffff",
  ];
  const result: AbsencePattern[] = [];
  for (const h3 of baseH3) {
    for (let dow = 0; dow < 7; dow++) {
      for (const hour of [10, 11, 14, 15, 17]) {
        result.push({
          H3_INDEX: h3,
          DAY_OF_WEEK: dow,
          HOUR: hour,
          ABSENCE_RATE: Math.round(Math.random() * 40) / 100,
          SAMPLE_COUNT: 5 + Math.floor(Math.random() * 20),
        });
      }
    }
  }
  return result.slice(0, 500);
}

export async function GET() {
  try {
    const rows = await pgQuery<{
      h3_index: string;
      day_of_week: number;
      hour: number;
      absence_rate: number;
      sample_count: number;
    }>(
      `SELECT h3_index, day_of_week, hour, absence_rate, sample_count
       FROM ft_absence_patterns
       WHERE sample_count >= 5
       ORDER BY absence_rate DESC
       LIMIT 500`
    );
    if (rows.length > 0) {
      const mapped: AbsencePattern[] = rows.map((r) => ({
        H3_INDEX: r.h3_index,
        DAY_OF_WEEK: r.day_of_week,
        HOUR: r.hour,
        ABSENCE_RATE: r.absence_rate,
        SAMPLE_COUNT: r.sample_count,
      }));
      return NextResponse.json(mapped);
    }
    return NextResponse.json(generateFallbackAbsence());
  } catch (error) {
    console.error("Absence heatmap error, using fallback:", error);
    return NextResponse.json(generateFallbackAbsence());
  }
}
