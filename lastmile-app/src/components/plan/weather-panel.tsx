"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CloudRain, Sun, CloudSun, Wind, Thermometer, ChevronDown } from "lucide-react";
import type { WeatherForecast } from "@/types";

interface Props {
  data: WeatherForecast[];
  selectedHour?: number;
}

function weatherIcon(code: string) {
  if (code?.includes("rain")) return <CloudRain className="h-4 w-4 text-blue-400" />;
  if (code?.includes("cloud")) return <CloudSun className="h-4 w-4 text-gray-400" />;
  return <Sun className="h-4 w-4 text-yellow-400" />;
}

export function WeatherPanel({ data, selectedHour }: Props) {
  const [expanded, setExpanded] = useState(false);

  const hourlyGroups = data.reduce<Record<string, WeatherForecast[]>>((acc, w) => {
    const hr = new Date(w.DATETIME).getHours().toString().padStart(2, "0") + ":00";
    if (!acc[hr]) acc[hr] = [];
    acc[hr].push(w);
    return acc;
  }, {});

  const summary = Object.entries(hourlyGroups)
    .map(([hour, items]) => {
      const avgPrecip = items.reduce((s, i) => s + i.PRECIPITATION, 0) / items.length;
      const avgWind = items.reduce((s, i) => s + i.WIND_SPEED, 0) / items.length;
      const avgTemp = items.reduce((s, i) => s + i.TEMPERATURE, 0) / items.length;
      const code = items[0]?.WEATHER_CODE || "";
      return { hour, avgPrecip, avgWind, avgTemp, code };
    })
    .sort((a, b) => a.hour.localeCompare(b.hour));

  const selectedRows = summary.filter((s) => {
    const h = parseInt(s.hour);
    return selectedHour !== undefined && h >= selectedHour && h < selectedHour + 3;
  });
  const displayRows = expanded ? summary : selectedRows.length > 0 ? selectedRows : summary.slice(0, 3);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle
          className="flex items-center gap-2 text-sm cursor-pointer select-none"
          onClick={() => setExpanded((v) => !v)}
        >
          <CloudRain className="h-4 w-4" />
          天気予報
          <span className="text-[10px] text-muted-foreground ml-auto">
            {expanded ? "全時間帯" : `${displayRows.length}/${summary.length}h`}
          </span>
          <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 p-3">
        {summary.length === 0 && (
          <p className="text-xs text-muted-foreground">データなし</p>
        )}
        {displayRows.map((s) => {
          const h = parseInt(s.hour);
          const isSelected = selectedHour !== undefined && h >= selectedHour && h < selectedHour + 3;
          return (
            <div key={s.hour} className={`flex items-center justify-between text-sm rounded px-1 ${isSelected ? "bg-blue-500/15 font-medium" : ""}`}>
              <span className="w-12 font-mono text-xs">{s.hour}</span>
              {weatherIcon(s.code)}
              <span className="flex items-center gap-1 text-xs">
                <Thermometer className="h-3 w-3" />
                {s.avgTemp.toFixed(0)}°
              </span>
              <span className="flex items-center gap-1 text-xs">
                <Wind className="h-3 w-3" />
                {s.avgWind.toFixed(0)}m/s
              </span>
              {s.avgPrecip > 0 ? (
                <Badge variant="destructive" className="text-[10px]">
                  {s.avgPrecip.toFixed(1)}mm
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">晴</Badge>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
