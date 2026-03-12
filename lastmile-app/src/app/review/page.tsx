"use client";

import useSWR from "swr";
import { safeFetch } from "@/lib/fetcher";
import { KpiCards } from "@/components/review/kpi-cards";
import { KpiChart } from "@/components/review/kpi-chart";
import { DriverRanking, type DriverPerf } from "@/components/review/driver-ranking";
import { AbsenceHeatmap } from "@/components/review/absence-heatmap";
import { DailyClosePanel } from "@/components/review/daily-close-panel";
import { DemandForecastChart } from "@/components/review/demand-forecast-chart";
import { MlBadge } from "@/components/shared/ml-badge";
import { useDate } from "@/context/date-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BrainCircuit, TrendingUp, MapPin, Shield, AlertTriangle, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { KpiDaily, AbsencePattern, DemandForecast } from "@/types";

function downloadCSV(data: KpiDaily[], filename: string) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const rows = data.map((d) => headers.map((h) => String((d as unknown as Record<string, unknown>)[h] ?? "")).join(","));
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReviewPage() {
  const { date } = useDate();

  const { data: kpiToday } = useSWR<KpiDaily[]>(
    `/api/review/kpi?date=${date}`,
    safeFetch
  );
  const { data: kpiTrend } = useSWR<KpiDaily[]>(
    "/api/review/kpi?range=30",
    safeFetch
  );
  const { data: driverPerf } = useSWR<DriverPerf[]>(
    `/api/review/driver-performance?date=${date}`,
    safeFetch
  );
  const { data: absenceData } = useSWR<AbsencePattern[]>(
    "/api/review/absence-heatmap",
    safeFetch
  );
  const { data: forecast } = useSWR<DemandForecast[]>(
    "/api/review/demand-forecast",
    safeFetch
  );

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">振り返りダッシュボード</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => downloadCSV(kpiTrend || [], `kpi_trend_${date}.csv`)}
          >
            <Download className="h-3 w-3" />
            CSV
          </Button>

        </div>
      </div>
      <DailyClosePanel date={date} />
      <KpiCards kpi={kpiToday?.[0] ?? null} />
      <div className="grid grid-cols-2 gap-4">
        <KpiChart data={kpiTrend || []} />
        <DriverRanking data={driverPerf || []} />
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-medium">需要予測</h3>
          <MlBadge model="Cortex ML 予測" />
        </div>
        <DemandForecastChart data={forecast || []} />
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-medium">不在ヒートマップ</h3>
          <MlBadge model="XGBoost 不在予測" />
        </div>
        <AbsenceHeatmap data={absenceData || []} />
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuit className="h-4 w-4 text-violet-400" />
            AI/ML 活用状況
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <TrendingUp className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
              <div>
                <p className="text-xs font-medium">需要予測</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  過去30日の配送実績からCortex ML時系列モデルで7日先の荷物数を予測。信頼区間付きで人員配置の参考に。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-orange-400" />
              <div>
                <p className="text-xs font-medium">不在予測</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  XGBoostモデルが曜日・時間帯・地域別の不在確率を推定。ヒートマップで高リスクエリアを可視化。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <Shield className="mt-0.5 h-5 w-5 shrink-0 text-green-400" />
              <div>
                <p className="text-xs font-medium">リスクスコア</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  天候・交通渋滞・工事情報を複合的に分析し、エリアごとの配送遅延リスクを0〜1で算出。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
              <div>
                <p className="text-xs font-medium">異常検知</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  配達ペースの異常をリアルタイム検知。停滞やルート逸脱時に自動アラートを発生。
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
