"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Loader2,
  UserX,
  ArrowRight,
  Save,
  PackageX,
} from "lucide-react";

interface Reassignment {
  package_id: string;
  new_driver_id: string;
  new_driver_name: string;
  new_trip_number: number;
  new_stop_order: number;
}

interface WithdrawResult {
  withdraw_driver_id: string;
  date: string;
  reason: string;
  withdrawn_packages: number;
  reassignments: Reassignment[];
  unassigned_packages: string[];
  confirmed: boolean;
}

interface Props {
  date: string;
  driverId: string | null;
  driverName: string | null;
}

export function DriverWithdrawPanel({ date, driverId, driverName }: Props) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!driverId) return null;

  const handlePreview = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/monitor/driver-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          withdraw_driver_id: driverId,
          reason: "緊急離脱",
          confirm: false,
        }),
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
      const res = await fetch("/api/monitor/driver-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          withdraw_driver_id: driverId,
          reason: "緊急離脱",
          confirm: true,
        }),
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

  const grouped = result
    ? result.reassignments.reduce<Record<string, Reassignment[]>>((acc, r) => {
        const key = r.new_driver_name;
        if (!acc[key]) acc[key] = [];
        acc[key].push(r);
        return acc;
      }, {})
    : {};

  return (
    <Card className="border-red-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <UserX className="h-4 w-4 text-red-500" />
          緊急離脱
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {driverName || driverId}
          </Badge>
          <Button
            size="sm"
            variant="destructive"
            onClick={handlePreview}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <UserX className="h-3 w-3" />
            )}
            {loading ? "算出中..." : "離脱シミュレーション"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          このドライバーの未配達荷物を他ドライバーに自動再割当。
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
              <Badge variant="destructive" className="text-[10px]">
                {result.withdrawn_packages}件を再割当
              </Badge>
              {result.unassigned_packages.length > 0 && (
                <Badge variant="outline" className="text-[10px] border-red-500 text-red-500">
                  <PackageX className="h-2.5 w-2.5 mr-1" />
                  {result.unassigned_packages.length}件割当不可
                </Badge>
              )}
              {result.confirmed && (
                <Badge className="text-[10px] bg-green-600">確定済</Badge>
              )}
            </div>

            <div className="max-h-[200px] space-y-1.5 overflow-y-auto">
              {Object.entries(grouped).map(([driverName, pkgs]) => (
                <div key={driverName} className="rounded bg-muted/30 p-1.5">
                  <div className="flex items-center gap-2 text-[10px] font-semibold mb-0.5">
                    <ArrowRight className="h-2.5 w-2.5" />
                    {driverName}
                    <Badge variant="outline" className="text-[9px]">
                      {pkgs.length}件
                    </Badge>
                  </div>
                  {pkgs.map((r) => (
                    <div key={r.package_id} className="text-[9px] font-mono text-muted-foreground pl-4">
                      {r.package_id} → {r.new_trip_number}便 #{r.new_stop_order}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {!result.confirmed && result.reassignments.length > 0 && (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleConfirm}
                disabled={confirming}
                className="w-full gap-1.5"
              >
                {confirming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                {confirming ? "確定中..." : "再割当を確定"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
