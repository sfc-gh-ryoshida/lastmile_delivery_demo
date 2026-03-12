"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Building2, Home, Store, Briefcase, ChevronDown, Timer, AlertTriangle } from "lucide-react";

interface DwellSummary {
  driver_id: string;
  name: string;
  total_deliveries: number;
  avg_dwell: number;
  max_dwell: number;
  total_dwell_minutes: number;
  apartment_avg: number | null;
  office_avg: number | null;
  house_avg: number | null;
  long_dwell_count: number;
}

function formatDwell(sec: number | null) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}秒`;
  return `${Math.floor(sec / 60)}分${sec % 60}秒`;
}

function dwellBadge(avg: number | null) {
  if (avg == null) return null;
  if (avg >= 180) return <Badge variant="destructive" className="text-[9px]">長</Badge>;
  if (avg >= 90) return <Badge className="bg-amber-500 text-white text-[9px]">中</Badge>;
  return <Badge className="bg-green-600 text-white text-[9px]">短</Badge>;
}

export function DwellPanel({ data }: { data: DwellSummary[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const activeData = data.filter((d) => d.total_deliveries > 0);
  if (activeData.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4" />
          滞留時間
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-[300px] space-y-2 overflow-y-auto p-3">
        {activeData.map((d) => {
          const isExpanded = expandedId === d.driver_id;
          const longPct = d.total_deliveries > 0
            ? Math.round((d.long_dwell_count / d.total_deliveries) * 100)
            : 0;
          return (
            <div
              key={d.driver_id}
              className="rounded-md border transition-colors hover:bg-muted/50 cursor-pointer"
              onClick={() => setExpandedId(isExpanded ? null : d.driver_id)}
            >
              <div className="space-y-1 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{d.name}</span>
                  <div className="flex items-center gap-1">
                    {dwellBadge(d.avg_dwell)}
                    <span className="text-xs font-bold">{formatDwell(d.avg_dwell)}</span>
                    <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                  </div>
                </div>
                <div className="flex gap-2 text-[10px] text-muted-foreground">
                  {d.apartment_avg != null && (
                    <span className="flex items-center gap-0.5">
                      <Building2 className="h-3 w-3" />
                      {formatDwell(d.apartment_avg)}
                    </span>
                  )}
                  {d.office_avg != null && (
                    <span className="flex items-center gap-0.5">
                      <Briefcase className="h-3 w-3" />
                      {formatDwell(d.office_avg)}
                    </span>
                  )}
                  {d.house_avg != null && (
                    <span className="flex items-center gap-0.5">
                      <Home className="h-3 w-3" />
                      {formatDwell(d.house_avg)}
                    </span>
                  )}
                  {d.long_dwell_count > 0 && (
                    <span className="flex items-center gap-0.5">
                      <Store className="h-3 w-3 text-red-400" />
                      3分超 {d.long_dwell_count}件
                    </span>
                  )}
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-green-500 via-amber-500 to-red-500"
                    style={{ width: `${Math.min((d.avg_dwell / 300) * 100, 100)}%` }}
                  />
                </div>
              </div>
              {isExpanded && (
                <div className="border-t px-2 pb-2 pt-1.5 space-y-2">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Timer className="h-3 w-3" />
                      最大滞留
                    </div>
                    <div className="font-medium text-right">{formatDwell(d.max_dwell)}</div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      合計滞留
                    </div>
                    <div className="font-medium text-right">{d.total_dwell_minutes}分</div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Store className="h-3 w-3" />
                      配達件数
                    </div>
                    <div className="font-medium text-right">{d.total_deliveries} 件</div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <AlertTriangle className="h-3 w-3" />
                      3分超率
                    </div>
                    <div className={`font-medium text-right ${longPct >= 30 ? "text-destructive" : ""}`}>
                      {longPct}% ({d.long_dwell_count}件)
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-[9px] text-muted-foreground mb-0.5">場所別平均</div>
                    {d.apartment_avg != null && (
                      <div className="flex items-center gap-1 text-[10px]">
                        <Building2 className="h-3 w-3 text-muted-foreground" />
                        <span className="w-10 text-muted-foreground">集合</span>
                        <div className="flex-1 h-1 rounded-full bg-muted">
                          <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min((d.apartment_avg / 300) * 100, 100)}%` }} />
                        </div>
                        <span className="w-14 text-right font-medium">{formatDwell(d.apartment_avg)}</span>
                      </div>
                    )}
                    {d.office_avg != null && (
                      <div className="flex items-center gap-1 text-[10px]">
                        <Briefcase className="h-3 w-3 text-muted-foreground" />
                        <span className="w-10 text-muted-foreground">事務所</span>
                        <div className="flex-1 h-1 rounded-full bg-muted">
                          <div className="h-full rounded-full bg-purple-500" style={{ width: `${Math.min((d.office_avg / 300) * 100, 100)}%` }} />
                        </div>
                        <span className="w-14 text-right font-medium">{formatDwell(d.office_avg)}</span>
                      </div>
                    )}
                    {d.house_avg != null && (
                      <div className="flex items-center gap-1 text-[10px]">
                        <Home className="h-3 w-3 text-muted-foreground" />
                        <span className="w-10 text-muted-foreground">戸建</span>
                        <div className="flex-1 h-1 rounded-full bg-muted">
                          <div className="h-full rounded-full bg-green-500" style={{ width: `${Math.min((d.house_avg / 300) * 100, 100)}%` }} />
                        </div>
                        <span className="w-14 text-right font-medium">{formatDwell(d.house_avg)}</span>
                      </div>
                    )}
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
