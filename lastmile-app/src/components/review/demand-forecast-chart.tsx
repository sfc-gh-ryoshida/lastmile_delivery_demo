"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import type { DemandForecast } from "@/types";

interface Props {
  data: DemandForecast[];
}

export function DemandForecastChart({ data }: Props) {
  const chartData = data.map((d) => ({
    date: d.DATE.slice(5),
    forecast: d.FORECAST_VOLUME,
    lower: d.CONFIDENCE_LOWER,
    upper: d.CONFIDENCE_UPPER,
    range: [d.CONFIDENCE_LOWER, d.CONFIDENCE_UPPER],
  }));

  if (chartData.length === 0) {
    return (
      <Card>
        <CardContent className="flex h-[200px] items-center justify-center">
          <p className="text-xs text-muted-foreground">データなし</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-3">
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#a1a1aa' }} stroke="#a1a1aa" />
            <YAxis tick={{ fontSize: 10, fill: '#a1a1aa' }} stroke="#a1a1aa" />
            <Tooltip
              contentStyle={{
                background: '#27272a',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                fontSize: 12,
                color: '#e4e4e7',
              }}
            />
            <Area
              dataKey="range"
              fill="#6d9eeb"
              fillOpacity={0.18}
              stroke="none"
              name="信頼区間"
            />
            <Line
              type="monotone"
              dataKey="forecast"
              stroke="#6d9eeb"
              strokeWidth={2}
              dot={{ r: 3, fill: "#6d9eeb" }}
              name="予測荷物数"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
