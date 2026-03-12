"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MlBadge } from "@/components/shared/ml-badge";
import {
  RefreshCw,
  Loader2,
  CheckCircle,
  AlertTriangle,
  MapPin,
  Clock,
  ShieldAlert,
  Save,
} from "lucide-react";

interface ReadjustStop {
  package_id: string;
  new_stop_order: number;
  status: string;
  time_window: string | null;
  risk_score: number | null;
  sla_violation: {
    time_window: string;
    estimated_eta: string;
    delay_minutes: number;
  } | null;
}

interface ReadjustResult {
  driver_id: string;
  date: string;
  total_remaining: number;
  reordered: number;
  skipped_high_risk: number;
  confirmed: boolean;
  sla_violations: {
    package_id: string;
    time_window: string;
    estimated_eta: string;
    delay_minutes: number;
  }[];
  new_sequence: ReadjustStop[];
}

interface Props {
  date: string;
  driverId: string | null;
  driverName: string | null;
}

export function RouteReadjustPanel({ date, driverId, driverName }: Props) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ReadjustResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!driverId) return null;

  const handleReadjust = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/monitor/routes/readjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, driver_id: driverId, skip_absent: true }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch("/api/monitor/routes/readjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, driver_id: driverId, skip_absent: true, confirm: true }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Card className="border-orange-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <RefreshCw className="h-4 w-4 text-orange-500" />
          ルート再調整
          <MlBadge model="リスクスコア" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {driverName || driverId}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={handleReadjust}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {loading ? "再計算中..." : "残ルート再最適化"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          現在位置から最短距離で再配列。不在・高リスク配送先は後回し。
        </p>

        {error && (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3 text-green-500" />
                <span>残{result.total_remaining}件を再配列</span>
              </div>
              {result.skipped_high_risk > 0 && (
                <div className="flex items-center gap-1 text-orange-500">
                  <ShieldAlert className="h-3 w-3" />
                  <span>{result.skipped_high_risk}件を後回し</span>
                </div>
              )}
              {result.confirmed && (
                <Badge className="text-[10px] bg-green-600">確定済</Badge>
              )}
            </div>

            {result.sla_violations.length > 0 && (
              <div className="rounded border border-orange-500/50 bg-orange-500/10 p-2 text-[10px]">
                <div className="font-semibold text-orange-600 mb-1">
                  SLA違反 {result.sla_violations.length}件
                </div>
                {result.sla_violations.slice(0, 3).map((v) => (
                  <div key={v.package_id} className="flex items-center gap-2 text-orange-600">
                    <span className="font-mono">{v.package_id}</span>
                    <span>{v.time_window} → ETA {v.estimated_eta}</span>
                    <span>(+{v.delay_minutes}分)</span>
                  </div>
                ))}
              </div>
            )}

            <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
              {result.new_sequence.map((s) => (
                <div
                  key={s.package_id}
                  className="flex items-center gap-2 rounded px-2 py-1 text-[10px] hover:bg-muted/30"
                >
                  <span className="w-5 text-right font-mono font-bold">
                    {s.new_stop_order}
                  </span>
                  <MapPin className="h-2.5 w-2.5 text-muted-foreground" />
                  <span className="flex-1 truncate font-mono">{s.package_id}</span>
                  {s.time_window && (
                    <Badge variant="outline" className="gap-0.5 text-[9px]">
                      <Clock className="h-2 w-2" />
                      {s.time_window}
                    </Badge>
                  )}
                  {s.status === "absent" && (
                    <Badge variant="destructive" className="text-[9px]">
                      不在
                    </Badge>
                  )}
                  {s.risk_score !== null && s.risk_score > 0.5 && (
                    <Badge
                      variant="outline"
                      className="text-[9px]"
                      style={{
                        borderColor: s.risk_score > 0.7 ? "#ef4444" : "#f59e0b",
                        color: s.risk_score > 0.7 ? "#ef4444" : "#f59e0b",
                      }}
                    >
                      {(s.risk_score * 100).toFixed(0)}%
                    </Badge>
                  )}
                  {s.sla_violation && (
                    <Badge variant="outline" className="text-[9px] border-orange-500 text-orange-500">
                      遅延
                    </Badge>
                  )}
                </div>
              ))}
            </div>

            {!result.confirmed && (
              <Button
                size="sm"
                onClick={handleConfirm}
                disabled={confirming}
                className="w-full gap-1.5"
              >
                {confirming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                {confirming ? "確定中..." : "この順序で確定"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
