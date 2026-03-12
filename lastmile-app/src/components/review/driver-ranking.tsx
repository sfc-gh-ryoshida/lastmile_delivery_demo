"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Trophy, User, TrendingUp, XCircle, MapPin } from "lucide-react";

export interface DriverPerf {
  driver_id: string;
  name: string;
  area_assignment: string | null;
  total: number;
  delivered: number;
  absent: number;
  completion_rate: number | null;
  total_distance: number | null;
  total_time_est: number | null;
}

interface Props {
  data: DriverPerf[];
}

export function DriverRanking({ data }: Props) {
  const [selected, setSelected] = useState<DriverPerf | null>(null);

  const avgCompletion = data.length
    ? data.reduce((s, d) => s + (d.completion_rate ?? 0), 0) / data.length
    : 0;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Trophy className="h-4 w-4 text-yellow-500" />
            ドライバー実績
          </CardTitle>
        </CardHeader>
        <CardContent className="max-h-[300px] overflow-y-auto p-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="pb-1">#</th>
                <th className="pb-1">名前</th>
                <th className="pb-1 text-right">完了</th>
                <th className="pb-1 text-right">不在</th>
                <th className="pb-1 text-right">完了率</th>
                <th className="pb-1 text-right">距離</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d, i) => (
                <tr
                  key={d.driver_id}
                  className="cursor-pointer border-b border-border/30 hover:bg-muted/40"
                  onClick={() => setSelected(d)}
                >
                  <td className="py-1.5 font-medium">
                    {i < 3 ? (
                      <Badge variant={i === 0 ? "default" : "secondary"} className="text-[10px]">
                        {i + 1}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{i + 1}</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <span className="font-medium">{d.name}</span>
                    {d.area_assignment && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        ({d.area_assignment})
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-right">{d.delivered}</td>
                  <td className="py-1.5 text-right text-destructive">{d.absent}</td>
                  <td className="py-1.5 text-right font-medium">
                    {d.completion_rate != null ? `${d.completion_rate}%` : "—"}
                  </td>
                  <td className="py-1.5 text-right text-xs text-muted-foreground">
                    {d.total_distance != null ? `${d.total_distance.toFixed(1)}km` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-md">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  {selected.name}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg border p-3">
                    <p className="text-2xl font-bold">{selected.delivered}</p>
                    <p className="text-xs text-muted-foreground">配達完了</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-2xl font-bold text-destructive">{selected.absent}</p>
                    <p className="text-xs text-muted-foreground">不在</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-2xl font-bold">{selected.total}</p>
                    <p className="text-xs text-muted-foreground">合計</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <TrendingUp className="h-4 w-4" />
                      完了率
                    </span>
                    <span className="font-bold">
                      {selected.completion_rate != null ? `${selected.completion_rate}%` : "—"}
                    </span>
                  </div>
                  {selected.completion_rate != null && (
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-green-500"
                        style={{ width: `${Math.min(selected.completion_rate, 100)}%` }}
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">チーム平均</span>
                    <span className="text-xs text-muted-foreground">
                      {avgCompletion.toFixed(1)}%
                    </span>
                  </div>
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <XCircle className="h-4 w-4" />
                      不在率
                    </span>
                    <span className={selected.absent > 5 ? "font-bold text-destructive" : ""}>
                      {selected.total > 0
                        ? `${((selected.absent / selected.total) * 100).toFixed(1)}%`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      走行距離
                    </span>
                    <span>
                      {selected.total_distance != null
                        ? `${selected.total_distance.toFixed(1)} km`
                        : "—"}
                    </span>
                  </div>
                  {selected.total_time_est != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">予定時間</span>
                      <span>{Math.round(selected.total_time_est)} 分</span>
                    </div>
                  )}
                  {selected.area_assignment && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">担当エリア</span>
                      <Badge variant="outline">{selected.area_assignment}</Badge>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
