"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MlBadge } from "@/components/shared/ml-badge";
import {
  RotateCw,
  Loader2,
  CheckCircle,
  AlertTriangle,
  MapPin,
  Clock,
  PackageX,
  ArrowRight,
  Truck,
  Save,
} from "lucide-react";

interface NextTripStop {
  stop_order: number;
  package_id: string;
  address: string;
  time_window: string | null;
  is_redelivery: boolean;
  delivery_method: string;
  from_prev: boolean;
  risk_score: number | null;
  eta: string;
  lat: number;
  lng: number;
}

interface NextTripData {
  trip_number: number;
  total_packages: number;
  from_prev_failed: number;
  original_next: number;
  dropped: number;
  total_weight: number;
  total_volume: number;
  departure_time: string;
  return_time: string;
  stops: NextTripStop[];
  route: { lat: number; lng: number }[];
}

interface NextTripResult {
  driver_id: string;
  driver_name: string;
  date: string;
  current_trip: number;
  next_trip_number: number;
  confirmed: boolean;
  prev_trip_summary: {
    total: number;
    delivered: number;
    absent: number;
    failed: number;
  };
  message?: string;
  next_trip: NextTripData | null;
}

interface Props {
  date: string;
  driverId: string | null;
  driverName: string | null;
  onRouteGenerated?: (route: { lat: number; lng: number }[]) => void;
}

export function NextTripPanel({ date, driverId, driverName, onRouteGenerated }: Props) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<NextTripResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!driverId) return null;

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/monitor/routes/next-trip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, driver_id: driverId }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
        if (data.next_trip?.route && onRouteGenerated) {
          onRouteGenerated(data.next_trip.route);
        }
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
      const res = await fetch("/api/monitor/routes/next-trip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, driver_id: driverId, confirm: true }),
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
    <Card className="border-blue-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Truck className="h-4 w-4 text-blue-500" />
          次便再最適化
          <MlBadge model="H3コスト行列" />
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
            onClick={handleGenerate}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            {loading ? "生成中..." : "次便ルート生成"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          前便結果を反映して次便を再計画。不在・未配達は次便に組込み。
        </p>

        {error && (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <Card className="bg-muted/30">
              <CardContent className="p-2">
                <div className="text-[10px] font-semibold text-muted-foreground mb-1">
                  {result.current_trip}便結果
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <div className="flex items-center gap-1">
                    <CheckCircle className="h-3 w-3 text-green-500" />
                    <span>{result.prev_trip_summary.delivered}件</span>
                  </div>
                  {result.prev_trip_summary.absent > 0 && (
                    <div className="flex items-center gap-1 text-orange-500">
                      <PackageX className="h-3 w-3" />
                      <span>不在{result.prev_trip_summary.absent}</span>
                    </div>
                  )}
                  {result.prev_trip_summary.failed > 0 && (
                    <div className="flex items-center gap-1 text-red-500">
                      <AlertTriangle className="h-3 w-3" />
                      <span>未配達{result.prev_trip_summary.failed}</span>
                    </div>
                  )}
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">/ {result.prev_trip_summary.total}件</span>
                </div>
              </CardContent>
            </Card>

            {result.message && !result.next_trip && (
              <div className="text-xs text-muted-foreground">{result.message}</div>
            )}

            {result.next_trip && (
              <>
                <div className="flex items-center gap-3 text-xs">
                  <Badge variant="default" className="text-[10px]">
                    {result.next_trip.trip_number}便 {result.next_trip.total_packages}件
                  </Badge>
                  {result.next_trip.from_prev_failed > 0 && (
                    <Badge variant="outline" className="text-[10px] border-orange-500 text-orange-500">
                      前便から{result.next_trip.from_prev_failed}件
                    </Badge>
                  )}
                  {result.next_trip.dropped > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {result.next_trip.dropped}件除外
                    </span>
                  )}
                  {result.confirmed && (
                    <Badge className="text-[10px] bg-green-600">確定済</Badge>
                  )}
                </div>
                <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                  <span>出発 {result.next_trip.departure_time}</span>
                  <span>帰着 {result.next_trip.return_time}</span>
                  <span>{result.next_trip.total_weight.toFixed(1)}kg</span>
                </div>

                <div className="max-h-[250px] space-y-0.5 overflow-y-auto">
                  {result.next_trip.stops.map((s) => (
                    <div
                      key={s.package_id}
                      className={`flex items-center gap-2 rounded px-2 py-1 text-[10px] hover:bg-muted/30 ${
                        s.from_prev ? "bg-orange-500/5" : ""
                      }`}
                    >
                      <span className="w-5 text-right font-mono font-bold">
                        {s.stop_order}
                      </span>
                      <MapPin className="h-2.5 w-2.5 text-muted-foreground" />
                      <span className="flex-1 truncate font-mono">{s.package_id}</span>
                      {s.delivery_method === "drop_off" ? (
                        <Badge className="text-[9px] bg-cyan-600 text-white px-1">置</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] px-1">対</Badge>
                      )}
                      {s.from_prev && (
                        <Badge variant="outline" className="text-[9px] border-orange-500 text-orange-500">
                          再配達
                        </Badge>
                      )}
                      {s.time_window && (
                        <Badge variant="outline" className="gap-0.5 text-[9px]">
                          <Clock className="h-2 w-2" />
                          {s.time_window}
                        </Badge>
                      )}
                      <span className="font-mono text-[9px] text-muted-foreground">
                        {s.eta}
                      </span>
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
                    {confirming ? "確定中..." : `${result.next_trip.trip_number}便ルート確定`}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
