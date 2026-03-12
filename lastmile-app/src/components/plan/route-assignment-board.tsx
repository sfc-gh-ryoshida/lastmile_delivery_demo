"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { safeFetch } from "@/lib/fetcher";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Users,
  Package,
  ArrowRight,
  Loader2,
  CheckCircle,
  Weight,
  AlertTriangle,
} from "lucide-react";
import type { Driver } from "@/types";

interface PkgRow {
  package_id: string;
  address: string;
  weight: number;
  time_window: string | null;
  driver_id: string | null;
  driver_name: string | null;
  status: string | null;
}

interface Props {
  date: string;
  drivers: Driver[];
}

export function RouteAssignmentBoard({ date, drivers }: Props) {
  const { data: packages, mutate } = useSWR<PkgRow[]>(
    `/api/plan/packages?date=${date}`,
    safeFetch
  );

  const [selectedPkgs, setSelectedPkgs] = useState<Set<string>>(new Set());
  const [targetDriver, setTargetDriver] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [lastResult, setLastResult] = useState<{ success: number; failed: number } | null>(null);

  const driverGroups = useMemo(() => {
    if (!packages) return new Map<string | null, PkgRow[]>();
    const map = new Map<string | null, PkgRow[]>();
    for (const p of packages) {
      const key = p.driver_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [packages]);

  const unassigned = driverGroups.get(null) || [];

  const togglePkg = (pkgId: string) => {
    setSelectedPkgs((prev) => {
      const next = new Set(prev);
      if (next.has(pkgId)) next.delete(pkgId);
      else next.add(pkgId);
      return next;
    });
  };

  const handleAssign = async () => {
    if (!targetDriver || selectedPkgs.size === 0) return;
    setAssigning(true);
    setLastResult(null);
    try {
      const moves = [...selectedPkgs].map((pkg_id) => ({
        package_id: pkg_id,
        from_driver_id: null,
        to_driver_id: targetDriver,
      }));
      const res = await fetch("/api/plan/routes/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, moves }),
      });
      const data = await res.json();
      setLastResult({ success: data.success, failed: data.failed });
      setSelectedPkgs(new Set());
      mutate();
    } catch {
      setLastResult({ success: 0, failed: selectedPkgs.size });
    } finally {
      setAssigning(false);
    }
  };

  const driverCapacity = (driverId: string) => {
    const d = drivers.find((dr) => dr.driver_id === driverId);
    const pkgs = driverGroups.get(driverId) || [];
    const totalWeight = pkgs.reduce((s, p) => s + (Number(p.weight) || 0), 0);
    return {
      count: pkgs.length,
      weight: totalWeight,
      maxWeight: Number(d?.vehicle_capacity) || 200,
      pct: d ? Math.round((totalWeight / (Number(d.vehicle_capacity) || 200)) * 100) : 0,
    };
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="h-4 w-4" />
          ドライバー割当ボード
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {unassigned.length > 0 && (
          <div className="rounded border border-yellow-500/30 bg-yellow-500/5 p-2">
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium">
              <AlertTriangle className="h-3 w-3 text-yellow-500" />
              未割当 ({unassigned.length}件)
            </div>
            <div className="max-h-[100px] space-y-0.5 overflow-y-auto">
              {unassigned.map((p) => (
                <button
                  key={p.package_id}
                  onClick={() => togglePkg(p.package_id)}
                  className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-[10px] transition-colors ${
                    selectedPkgs.has(p.package_id) ? "bg-primary/20 text-primary" : "hover:bg-accent"
                  }`}
                >
                  <span className="truncate font-mono">{p.package_id}</span>
                  <span className="text-muted-foreground">{p.weight}kg</span>
                </button>
              ))}
            </div>
            {selectedPkgs.size > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  {selectedPkgs.size}件選択中
                </Badge>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <select
                  className="h-7 rounded border bg-background px-2 text-xs"
                  value={targetDriver || ""}
                  onChange={(e) => setTargetDriver(e.target.value || null)}
                >
                  <option value="">割当先を選択</option>
                  {drivers.map((d) => (
                    <option key={d.driver_id} value={d.driver_id}>
                      {d.name} ({driverCapacity(d.driver_id).count}件)
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  onClick={handleAssign}
                  disabled={!targetDriver || assigning}
                  className="h-7 gap-1 text-xs"
                >
                  {assigning ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                  割当
                </Button>
              </div>
            )}
          </div>
        )}

        {lastResult && (
          <div className="flex items-center gap-2 text-xs">
            <CheckCircle className="h-3 w-3 text-green-500" />
            <span>{lastResult.success}件割当成功</span>
            {lastResult.failed > 0 && (
              <span className="text-destructive">{lastResult.failed}件失敗</span>
            )}
          </div>
        )}

        <div className="max-h-[250px] space-y-1.5 overflow-y-auto">
          {drivers.map((d) => {
            const cap = driverCapacity(d.driver_id);
            return (
              <div key={d.driver_id} className="rounded border p-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{d.name}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      <Package className="mr-0.5 h-2.5 w-2.5" />
                      {cap.count}件
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Weight className="h-3 w-3" />
                    <span>{Number(cap.weight || 0).toFixed(1)}/{cap.maxWeight}kg</span>
                  </div>
                </div>
                <Progress
                  value={cap.pct}
                  className={`mt-1 h-1.5 ${cap.pct > 90 ? "[&>div]:bg-red-500" : ""}`}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
