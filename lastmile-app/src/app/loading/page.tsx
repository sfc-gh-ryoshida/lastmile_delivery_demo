"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { safeFetch } from "@/lib/fetcher";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Package, Truck, Clock, Weight, Box, RotateCcw, ArrowUp, ArrowDown } from "lucide-react";
import { useDate } from "@/context/date-context";

interface LoadingItem {
  package_id: string;
  driver_id: string;
  driver_name: string;
  stop_order: number;
  address: string;
  weight: number;
  volume: number;
  time_window: string | null;
  recipient_type: string;
  is_redelivery: boolean;
}

export default function LoadingPage() {
  const { date } = useDate();
  const { data: items } = useSWR<LoadingItem[]>(
    `/api/loading?date=${date}`,
    safeFetch
  );
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);

  const drivers = useMemo(() => {
    if (!items) return [];
    const map = new Map<string, { name: string; count: number; totalWeight: number; totalVolume: number }>();
    for (const item of items) {
      if (!map.has(item.driver_id)) {
        map.set(item.driver_id, { name: item.driver_name, count: 0, totalWeight: 0, totalVolume: 0 });
      }
      const d = map.get(item.driver_id)!;
      d.count++;
      d.totalWeight += item.weight ?? 0;
      d.totalVolume += item.volume ?? 0;
    }
    return Array.from(map.entries()).map(([id, info]) => ({ driver_id: id, ...info }));
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!items) return [];
    if (!selectedDriver) return [];
    return items.filter((i) => i.driver_id === selectedDriver);
  }, [items, selectedDriver]);

  const selectedInfo = drivers.find((d) => d.driver_id === selectedDriver);

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
                  {Number(d.totalWeight || 0).toFixed(1)}kg
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
              <Badge variant="outline">{selectedInfo.count} 件</Badge>
              <Badge variant="secondary">合計 {Number(selectedInfo.totalWeight || 0).toFixed(1)} kg</Badge>
              <Badge variant="secondary">体積 {Number(selectedInfo.totalVolume || 0).toFixed(2)} m³</Badge>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Package className="h-4 w-4" />
                  積み荷順序（配達逆順＝積込順）
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  最後に配達する荷物を先に積み、最初に配達する荷物を最後（手前）に積みます
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y">
                  {[...filteredItems].reverse().map((item, idx) => (
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
                            <ArrowDown className="h-3 w-3" />
                            配達順 {item.stop_order}
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
                          {item.weight}kg
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Box className="h-3 w-3" />
                          {item.volume}m³
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

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">積み込みサマリー</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold">{filteredItems.length}</p>
                    <p className="text-xs text-muted-foreground">荷物数</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{Number(selectedInfo.totalWeight || 0).toFixed(1)}</p>
                    <p className="text-xs text-muted-foreground">総重量 (kg)</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{Number(selectedInfo.totalVolume || 0).toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">総体積 (m³)</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {filteredItems.filter((i) => i.is_redelivery).length}
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
