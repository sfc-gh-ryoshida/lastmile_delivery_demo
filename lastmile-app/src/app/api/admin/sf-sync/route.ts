import { NextResponse } from "next/server";
import { query as sfQuery } from "@/lib/snowflake";

interface StepResult {
  step: string;
  ok: boolean;
  message: string;
  ms: number;
}

const COST_MATRIX_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

export async function POST(request: Request) {
  const body = await request.json();
  const date = body.date as string;

  if (!date?.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const results: StepResult[] = [];

  const steps: { name: string; fn: () => Promise<string> }[] = [
    {
      name: "ETL (PG→SF DELIVERY_HISTORY + KPI_DAILY)",
      fn: async () => {
        const [r] = await sfQuery<{ SP_ETL_POSTGRES_SYNC: string }>(
          "CALL LASTMILE_DB.ANALYTICS.SP_ETL_POSTGRES_SYNC()"
        );
        return r?.SP_ETL_POSTGRES_SYNC || "done";
      },
    },
    {
      name: "リスクスコア再計算",
      fn: async () => {
        const [r] = await sfQuery<{ SP_RECALC_RISK_SCORES: string }>(
          "CALL LASTMILE_DB.ANALYTICS.SP_RECALC_RISK_SCORES()"
        );
        return r?.SP_RECALC_RISK_SCORES || "done";
      },
    },
    {
      name: "不在パターン再計算",
      fn: async () => {
        const [r] = await sfQuery<{ SP_PREDICT_ABSENCE: string }>(
          "CALL LASTMILE_DB.ML.SP_PREDICT_ABSENCE()"
        );
        return r?.SP_PREDICT_ABSENCE || "done";
      },
    },
    {
      name: "需要予測更新",
      fn: async () => {
        const [r] = await sfQuery<{ SP_REFRESH_DEMAND_FORECAST: string }>(
          "CALL LASTMILE_DB.ANALYTICS.SP_REFRESH_DEMAND_FORECAST()"
        );
        return r?.SP_REFRESH_DEMAND_FORECAST || "done";
      },
    },
    ...COST_MATRIX_HOURS.map((hour) => ({
      name: `H3コスト行列 (${date} ${hour}:00)`,
      fn: async () => {
        const [r] = await sfQuery<{ SP_GENERATE_H3_COST_MATRIX: string }>(
          `CALL LASTMILE_DB.ANALYTICS.SP_GENERATE_H3_COST_MATRIX('${date}', ${hour})`
        );
        return r?.SP_GENERATE_H3_COST_MATRIX || "done";
      },
    })),
  ];

  for (const step of steps) {
    const start = performance.now();
    try {
      const msg = await step.fn();
      results.push({ step: step.name, ok: true, message: msg, ms: Math.round(performance.now() - start) });
    } catch (err) {
      results.push({ step: step.name, ok: false, message: String(err), ms: Math.round(performance.now() - start) });
    }
  }

  const allOk = results.every((r) => r.ok);
  const totalMs = results.reduce((s, r) => s + r.ms, 0);

  return NextResponse.json({
    ok: allOk,
    date,
    totalMs,
    steps: results,
  });
}
