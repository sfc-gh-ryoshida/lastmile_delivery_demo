"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Package, CheckCircle2, XCircle, Clock, TrendingUp, Users } from "lucide-react";
import type { KpiDaily } from "@/types";

interface Props {
  kpi: KpiDaily | null;
}

export function KpiCards({ kpi }: Props) {
  const cards = [
    {
      label: "配送数",
      value: kpi?.TOTAL_PACKAGES ?? "—",
      icon: Package,
      color: "text-chart-1",
    },
    {
      label: "完了率",
      value: kpi ? `${(kpi.COMPLETION_RATE * 100).toFixed(1)}%` : "—",
      icon: CheckCircle2,
      color: "text-green-500",
    },
    {
      label: "不在率",
      value: kpi ? `${(kpi.ABSENCE_RATE * 100).toFixed(1)}%` : "—",
      icon: XCircle,
      color: "text-destructive",
    },
    {
      label: "時間内率",
      value: kpi ? `${(kpi.ONTIME_RATE * 100).toFixed(1)}%` : "—",
      icon: Clock,
      color: "text-yellow-500",
    },
    {
      label: "平均配達時間",
      value: kpi ? `${kpi.AVG_DELIVERY_TIME?.toFixed(0)}分` : "—",
      icon: TrendingUp,
      color: "text-chart-2",
    },
    {
      label: "配達完了",
      value: kpi?.DELIVERED ?? "—",
      sub: kpi ? `不在 ${kpi.ABSENT}件` : undefined,
      icon: Users,
      color: "text-chart-3",
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader className="flex flex-row items-center justify-between pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {c.label}
            </CardTitle>
            <c.icon className={`h-4 w-4 ${c.color}`} />
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p className="text-xl font-bold">{c.value}</p>
            {c.sub && <p className="text-xs text-muted-foreground">{c.sub}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
