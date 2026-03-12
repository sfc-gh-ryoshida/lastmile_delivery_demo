"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ClipboardCheck,
  Loader2,
  AlertTriangle,
  CheckCircle,
  Package,
  Truck,
  RotateCcw,
} from "lucide-react";

interface DriverSummary {
  driver_id: string;
  name: string;
  delivered: number;
  returned: number;
  trips_completed: number;
}

interface CloseResult {
  date: string;
  total_packages: number;
  delivered: number;
  returned: number;
  delivery_rate: number;
  status_breakdown: Record<string, number>;
  pre_close_breakdown: Record<string, number>;
  by_driver: DriverSummary[];
}

interface Props {
  date: string;
}

export function DailyClosePanel({ date }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CloseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const handleClose = async () => {
    if (!confirmed) {
      setConfirmed(true);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/review/daily-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
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
      setConfirmed(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ClipboardCheck className="h-4 w-4 text-violet-400" />
          日次締め
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[10px] text-muted-foreground">
          未配達の荷物を「持戻(returned)」に変更し、当日の配送実績を確定します。
        </p>

        {!result && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={confirmed ? "destructive" : "outline"}
              onClick={handleClose}
              disabled={loading}
              className="gap-1.5"
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ClipboardCheck className="h-3 w-3" />
              )}
              {loading ? "処理中..." : confirmed ? "本当に締め実行" : "日次締め実行"}
            </Button>
            {confirmed && !loading && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmed(false)}
                className="text-[10px]"
              >
                キャンセル
              </Button>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded bg-muted/30 p-2">
                <div className="text-lg font-bold">{result.total_packages}</div>
                <div className="text-[9px] text-muted-foreground">総荷物</div>
              </div>
              <div className="rounded bg-green-500/10 p-2">
                <div className="text-lg font-bold text-green-500">{result.delivered}</div>
                <div className="text-[9px] text-muted-foreground">配達完了</div>
              </div>
              <div className="rounded bg-orange-500/10 p-2">
                <div className="text-lg font-bold text-orange-500">{result.returned}</div>
                <div className="text-[9px] text-muted-foreground">持戻</div>
              </div>
              <div className="rounded bg-blue-500/10 p-2">
                <div className="text-lg font-bold text-blue-500">{result.delivery_rate}%</div>
                <div className="text-[9px] text-muted-foreground">配達率</div>
              </div>
            </div>

            {Object.keys(result.pre_close_breakdown).length > 0 && (
              <div className="text-[10px]">
                <div className="font-semibold mb-1 text-muted-foreground">締め前内訳</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(result.pre_close_breakdown).map(([status, count]) => (
                    <Badge key={status} variant="outline" className="text-[9px]">
                      {status}: {count}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] font-semibold mb-1 text-muted-foreground flex items-center gap-1">
                <Truck className="h-3 w-3" />
                ドライバー別実績
              </div>
              <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
                {result.by_driver.map((d) => (
                  <div
                    key={d.driver_id}
                    className="flex items-center gap-2 rounded px-2 py-1 text-[10px] hover:bg-muted/30"
                  >
                    <span className="font-medium w-20 truncate">{d.name}</span>
                    <div className="flex items-center gap-1">
                      <CheckCircle className="h-2.5 w-2.5 text-green-500" />
                      <span>{d.delivered}</span>
                    </div>
                    {d.returned > 0 && (
                      <div className="flex items-center gap-1 text-orange-500">
                        <RotateCcw className="h-2.5 w-2.5" />
                        <span>{d.returned}</span>
                      </div>
                    )}
                    <Badge variant="outline" className="text-[9px] ml-auto">
                      {d.trips_completed}便
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
