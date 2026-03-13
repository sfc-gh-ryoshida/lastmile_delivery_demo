"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { safeFetch } from "@/lib/fetcher";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, Truck, Clock, Weight, Box, RotateCcw, ArrowDown, ArrowUp } from "lucide-react";
import { useDate } from "@/context/date-context";

interface LoadingItem {
  package_id: string;
  driver_id: string;
  driver_name: string;
  trip_number: number;
  stop_order: number;
  loading_order: number;
  address: string;
  weight: number;
  volume: number;
  time_window: string | null;
  recipient_type: string;
  is_redelivery: boolean;
}

type SortMode = "loading" | "delivery";

export default function LoadingPage() {
  const { date } = useDate();
  const { data: items } = useSWR<LoadingItem[]>(
    `/api/loading?date=${date}`,
    safeFetch
  );
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("loading");

  const drivers = useMemo(() => {
    if (!items) return [];
    const map = new Map<string, { name: string; count: number; totalWeight: number; totalVolume: number; trips: Set<number> }>();
    for (const item of items) {
      if (!map.has(item.driver_id)) {
        map.set(item.driver_id, { name: item.driver_name, count: 0, totalWeight: 0, totalVolume: 0, trips: new Set() });
      }
      const d = map.get(item.driver_id)!;
      d.count++;
      d.totalWeight += Number(item.weight) || 0;
      d.totalVolume += Number(item.volume) || 0;
      d.trips.add(item.trip_number);
    }
    return Array.from(map.entries()).map(([id, info]) => ({
      driver_id: id,
      name: info.name,
      count: info.count,
      totalWeight: info.totalWeight,
      totalVolume: info.totalVolume,
      tripCount: info.trips.size,
    }));
  }, [items]);

  const tripGroups = useMemo(() => {
    if (!items || !selectedDriver) return [];
    const filtered = items.filter((i) => i.driver_id === selectedDriver);
    const tripMap = new Map<number, LoadingItem[]>();
    for (const item of filtered) {
      const tn = item.trip_number ?? 1;
      if (!tripMap.has(tn)) tripMap.set(tn, []);
      tripMap.get(tn)!.push(item);
    }
    return Array.from(tripMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([tripNum, pkgs]) => {
        const sorted = sortMode === "loading"
          ? [...pkgs].sort((a, b) => a.loading_order - b.loading_order)
          : [...pkgs].sort((a, b) => a.stop_order - b.stop_order);
        return {
          trip: tripNum,
          packages: sorted,
          totalWeight: pkgs.reduce((s, p) => s + (Number(p.weight) || 0), 0),
          totalVolume: pkgs.reduce((s, p) => s + (Number(p.volume) || 0), 0),
        };
      });
  }, [items, selectedDriver, sortMode]);

  const selectedInfo = drivers.find((d) => d.driver_id === selectedDriver);
  const totalPkgs = tripGroups.reduce((s, g) => s + g.packages.length, 0);

  return (
    <div className="flex h-full">
      <div className="w-72 shrink-0 overflow-y-auto border-r bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Truck className="h-4 w-4" />
            ドライバー選択
          </h2>
        </div>
        <div className="space-y-1">
          {drivers.map((d) => (
            <button
              key={d.driver_id}
              onClick={() => setSelectedDriver(d.driver_id)}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors ${
                selectedDriver === d.driver_id
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              }`}
            >
              <span className="truncate">{d.name}</span>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  {d.count}件
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {d.totalWeight.toFixed(1)}kg
                </Badge>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!selectedDriver && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p className="text-sm">ドライバーを選択して積み荷順を表示</p>
          </div>
        )}
        {selectedDriver && selectedInfo && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <h2 className="text-lg font-bold">{selectedInfo.name}</h2>
              <Badge variant="outline">{totalPkgs} 件</Badge>
              <Badge variant="secondary">合計 {selectedInfo.totalWeight.toFixed(1)} kg</Badge>
              <Badge variant="secondary">体積 {selectedInfo.totalVolume.toFixed(2)} m³</Badge>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">表示順:</span>
              <button
                onClick={() => setSortMode("loading")}
                className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  sortMode === "loading"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                <ArrowUp className="h-3 w-3" />
                積込順（LIFO）
              </button>
              <button
                onClick={() => setSortMode("delivery")}
                className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  sortMode === "delivery"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                <ArrowDown className="h-3 w-3" />
                配達順
              </button>
            </div>

            {tripGroups.map((group) => (
              <Card key={group.trip}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      {group.trip}便目
                      <Badge variant="outline" className="text-[10px]">{group.packages.length}件</Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Weight className="h-3 w-3" />
                        {group.totalWeight.toFixed(1)}kg
                      </span>
                      <span className="flex items-center gap-1">
                        <Box className="h-3 w-3" />
                        {group.totalVolume.toFixed(2)}m³
                      </span>
                    </div>
                  </CardTitle>
                  {sortMode === "loading" && (
                    <p className="text-xs text-muted-foreground">
                      最後に配達する荷物を先に積み、最初に配達する荷物を最後（手前）に積みます
                    </p>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y">
                    {group.packages.map((item, idx) => (
                      <div
                        key={item.package_id}
                        className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                          {idx + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{item.address}</span>
                            {item.is_redelivery && (
                              <Badge variant="destructive" className="text-[10px]">
                                <RotateCcw className="mr-1 h-2.5 w-2.5" />
                                再配達
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="font-mono">{item.package_id}</span>
                            <span className="flex items-center gap-1">
                              {sortMode === "loading" ? (
                                <>
                                  <ArrowDown className="h-3 w-3" />
                                  配達順 {item.stop_order}
                                </>
                              ) : (
                                <>
                                  <ArrowUp className="h-3 w-3" />
                                  積込順 {item.loading_order}
                                </>
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-xs">
                          {item.time_window && (
                            <Badge variant="outline" className="gap-1 text-[10px]">
                              <Clock className="h-2.5 w-2.5" />
                              {item.time_window}
                            </Badge>
                          )}
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Weight className="h-3 w-3" />
                            {Number(item.weight).toFixed(2)}kg
                          </div>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Box className="h-3 w-3" />
                            {Number(item.volume).toFixed(3)}m³
                          </div>
                          <Badge
                            variant={item.recipient_type === "office" ? "default" : "secondary"}
                            className="text-[10px]"
                          >
                            {item.recipient_type === "office" ? "法人" : "個人"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">積み込みサマリー</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-5 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold">{selectedInfo.tripCount}</p>
                    <p className="text-xs text-muted-foreground">便数</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{totalPkgs}</p>
                    <p className="text-xs text-muted-foreground">荷物数</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{selectedInfo.totalWeight.toFixed(1)}</p>
                    <p className="text-xs text-muted-foreground">総重量 (kg)</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{selectedInfo.totalVolume.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">総体積 (m³)</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {tripGroups.reduce((s, g) => s + g.packages.filter((i) => i.is_redelivery).length, 0)}
                    </p>
                    <p className="text-xs text-muted-foreground">再配達</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
