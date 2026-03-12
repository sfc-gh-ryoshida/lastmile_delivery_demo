"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { KpiDaily } from "@/types";

interface Props {
  data: KpiDaily[];
}

export function KpiChart({ data }: Props) {
  const chartData = data
    .slice()
    .sort((a, b) => a.DATE.localeCompare(b.DATE))
    .map((d) => ({
      date: d.DATE.slice(5),
      配送数: d.TOTAL_PACKAGES,
      完了率: Math.round(d.COMPLETION_RATE * 100),
      不在率: Math.round(d.ABSENCE_RATE * 100),
    }));

  const comparison = useMemo(() => {
    if (data.length < 8) return null;
    const sorted = data.slice().sort((a, b) => b.DATE.localeCompare(a.DATE));
    const thisWeek = sorted.slice(0, 7);
    const lastWeek = sorted.slice(7, 14);
    if (lastWeek.length < 7) return null;

    const avg = (arr: KpiDaily[], key: keyof KpiDaily) =>
      arr.reduce((s, d) => s + Number(d[key] || 0), 0) / arr.length;

    const thisComp = avg(thisWeek, "COMPLETION_RATE") * 100;
    const lastComp = avg(lastWeek, "COMPLETION_RATE") * 100;
    const thisAbs = avg(thisWeek, "ABSENCE_RATE") * 100;
    const lastAbs = avg(lastWeek, "ABSENCE_RATE") * 100;
    const thisPkg = avg(thisWeek, "TOTAL_PACKAGES");
    const lastPkg = avg(lastWeek, "TOTAL_PACKAGES");

    return {
      completionDelta: thisComp - lastComp,
      absenceDelta: thisAbs - lastAbs,
      packagesDelta: thisPkg - lastPkg,
      thisComp,
      thisAbs,
    };
  }, [data]);

  const TrendIcon = ({ delta, invert }: { delta: number; invert?: boolean }) => {
    const positive = invert ? delta < 0 : delta > 0;
    if (Math.abs(delta) < 0.5)
      return <Minus className="h-3 w-3 text-muted-foreground" />;
    return positive ? (
      <TrendingUp className="h-3 w-3 text-green-500" />
    ) : (
      <TrendingDown className="h-3 w-3 text-red-500" />
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">KPI推移</CardTitle>
          {comparison && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-[10px]">
                <TrendIcon delta={comparison.completionDelta} />
                <span className="text-muted-foreground">完了率</span>
                <span className={comparison.completionDelta >= 0 ? "text-green-500" : "text-red-500"}>
                  {comparison.completionDelta >= 0 ? "+" : ""}
                  {comparison.completionDelta.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <TrendIcon delta={comparison.absenceDelta} invert />
                <span className="text-muted-foreground">不在率</span>
                <span className={comparison.absenceDelta <= 0 ? "text-green-500" : "text-red-500"}>
                  {comparison.absenceDelta >= 0 ? "+" : ""}
                  {comparison.absenceDelta.toFixed(1)}%
                </span>
              </div>
              <Badge variant="outline" className="text-[9px]">vs前週</Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#888" />
            <YAxis yAxisId="left" stroke="#888" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 100]} stroke="#888" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ backgroundColor: "#1a1a1a", border: "1px solid #333" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {comparison && (
              <ReferenceLine
                yAxisId="right"
                y={comparison.thisComp}
                stroke="#22c55e"
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
            )}
            <Bar yAxisId="left" dataKey="配送数" fill="#3b82f6" radius={[2, 2, 0, 0]} />
            <Line yAxisId="right" type="monotone" dataKey="完了率" stroke="#22c55e" strokeWidth={2} dot={false} />
            <Line yAxisId="right" type="monotone" dataKey="不在率" stroke="#ef4444" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
