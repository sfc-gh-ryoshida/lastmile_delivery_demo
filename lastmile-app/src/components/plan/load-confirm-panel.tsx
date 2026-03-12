"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Package, Loader2, CheckCircle, AlertTriangle } from "lucide-react";

interface Props {
  date: string;
  driverId: string;
  driverName: string;
  tripNumber: number;
  packageCount: number;
}

export function LoadConfirmButton({ date, driverId, driverName, tripNumber, packageCount }: Props) {
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plan/routes/load-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, driver_id: driverId, trip_number: tripNumber }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setConfirmed(true);
        setLoadedCount(data.loaded_count);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (confirmed) {
    return (
      <div className="flex items-center gap-2 text-xs text-green-600">
        <CheckCircle className="h-3 w-3" />
        <span>{loadedCount}件 積込完了</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={handleConfirm}
        disabled={loading}
        className="gap-1 text-[10px] h-6"
      >
        {loading ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <Package className="h-2.5 w-2.5" />
        )}
        {tripNumber}便 積込完了
      </Button>
      {error && (
        <span className="text-[10px] text-destructive">{error}</span>
      )}
    </div>
  );
}

interface AttendanceDriver {
  driver_id: string;
  name: string;
  is_active: boolean;
  depot_name: string;
}

export function DriverAttendancePanel({ date }: { date: string }) {
  const [drivers, setDrivers] = useState<AttendanceDriver[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Map<string, boolean>>(new Map());

  const fetchDrivers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plan/driver-attendance");
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setDrivers(data.drivers);
        setChanges(new Map());
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (driverId: string, currentActive: boolean) => {
    setChanges((prev) => {
      const next = new Map(prev);
      const original = drivers?.find((d) => d.driver_id === driverId)?.is_active;
      const newVal = !currentActive;
      if (newVal === original) {
        next.delete(driverId);
      } else {
        next.set(driverId, newVal);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updates = [...changes.entries()].map(([driver_id, is_active]) => ({
        driver_id,
        is_active,
      }));
      const res = await fetch("/api/plan/driver-attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, updates }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        await fetchDrivers();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const getEffectiveActive = (d: AttendanceDriver) => {
    return changes.has(d.driver_id) ? changes.get(d.driver_id)! : d.is_active;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Package className="h-4 w-4" />
          ドライバー出勤管理
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!drivers ? (
          <Button size="sm" variant="outline" onClick={fetchDrivers} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            {loading ? "読込中..." : "出勤状況を表示"}
          </Button>
        ) : (
          <>
            <div className="max-h-[300px] space-y-1 overflow-y-auto">
              {drivers.map((d) => {
                const active = getEffectiveActive(d);
                const changed = changes.has(d.driver_id);
                return (
                  <div
                    key={d.driver_id}
                    className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs cursor-pointer hover:bg-muted/30 ${
                      changed ? "bg-blue-500/10" : ""
                    }`}
                    onClick={() => handleToggle(d.driver_id, active)}
                  >
                    <Badge
                      variant={active ? "default" : "destructive"}
                      className="text-[9px] w-10 justify-center"
                    >
                      {active ? "出勤" : "欠勤"}
                    </Badge>
                    <span className="font-mono text-[10px] w-16">{d.driver_id}</span>
                    <span className="flex-1">{d.name}</span>
                    <span className="text-[10px] text-muted-foreground">{d.depot_name}</span>
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {error}
              </div>
            )}

            {changes.size > 0 && (
              <Button size="sm" onClick={handleSave} disabled={saving} className="w-full gap-1.5">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                {saving ? "保存中..." : `${changes.size}件の変更を保存`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
