"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { User, TrendingDown, TrendingUp, ChevronDown, Gauge, Package, MapPin } from "lucide-react";
import type { DriverProgress } from "@/types";

interface Props {
  drivers: DriverProgress[];
  selectedDriverId?: string | null;
  onSelectDriver?: (driver: DriverProgress) => void;
}

function statusBadge(pct: number | null, speed: number | null) {
  if (pct === null || pct === 0) return <Badge variant="secondary">待機</Badge>;
  if (speed !== null && speed <= 0) return <Badge variant="destructive">遅延</Badge>;
  if (pct >= 100) return <Badge className="bg-purple-600 text-white">完了</Badge>;
  return <Badge className="bg-green-600 text-white">配達中</Badge>;
}

export function DriverStatusList({ drivers, selectedDriverId, onSelectDriver }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Card className="flex-1 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <User className="h-4 w-4" />
          ドライバー ({drivers.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-[340px] space-y-2 overflow-y-auto p-3">
        {drivers.map((d) => {
          const isExpanded = expandedId === d.driver_id;
          const remaining = d.total_packages - d.delivered - d.absent;
          return (
            <div
              key={d.driver_id}
              className={`rounded-md border text-sm transition-colors hover:bg-muted/50 cursor-pointer ${selectedDriverId === d.driver_id ? "border-blue-500 bg-blue-500/10" : ""}`}
              onClick={() => {
                setExpandedId(isExpanded ? null : d.driver_id);
                onSelectDriver?.(d);
              }}
            >
              <div className="flex items-center justify-between p-2">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{d.name}</span>
                    {statusBadge(d.progress_pct, d.current_speed)}
                  </div>
                  <div className="flex gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-0.5">
                      <TrendingUp className="h-3 w-3" />
                      {d.delivered}/{d.total_packages}
                    </span>
                    {d.absent > 0 && (
                      <span className="flex items-center gap-0.5 text-destructive">
                        <TrendingDown className="h-3 w-3" />
                        不在{d.absent}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-lg font-bold">
                    {d.progress_pct != null ? `${d.progress_pct}%` : "—"}
                  </span>
                  <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                </div>
              </div>
              {isExpanded && (
                <div className="border-t px-2 pb-2 pt-1.5 space-y-2">
                  <div className="h-1.5 w-full rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-blue-500 to-green-500 transition-all"
                      style={{ width: `${d.progress_pct ?? 0}%` }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Gauge className="h-3 w-3" />
                      速度
                    </div>
                    <div className="font-medium text-right">
                      {d.current_speed != null ? `${d.current_speed.toFixed(1)} km/h` : "—"}
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Package className="h-3 w-3" />
                      配達済
                    </div>
                    <div className="font-medium text-right">{d.delivered} 件</div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <TrendingDown className="h-3 w-3" />
                      不在
                    </div>
                    <div className="font-medium text-right">{d.absent} 件</div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <TrendingUp className="h-3 w-3" />
                      残り
                    </div>
                    <div className="font-medium text-right">{remaining > 0 ? `${remaining} 件` : "—"}</div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      ID
                    </div>
                    <div className="font-medium text-right text-muted-foreground">{d.driver_id}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
