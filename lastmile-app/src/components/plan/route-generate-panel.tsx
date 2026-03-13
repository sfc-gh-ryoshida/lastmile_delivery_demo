"use client";

import { useState, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { MlBadge } from "@/components/shared/ml-badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Zap,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Truck,
  Weight,
  Box,
  Clock,
  GripVertical,
  ArrowUpDown,
  Save,
  ChevronDown,
  Building2,
  Briefcase,
  Home,
  ShieldAlert,
  RotateCcw,
  Package,
  MapPin,
  Info,
  CircleAlert,
  CheckSquare,
  Square,
} from "lucide-react";
import { LoadConfirmButton } from "@/components/plan/load-confirm-panel";

interface RoutePackage {
  package_id: string;
  stop_order: number;
  address: string;
  weight: number;
  volume: number;
  time_window: string | null;
  is_redelivery: boolean;
  recipient_type: string;
  delivery_method: string;
  risk_score: number | null;
  lat: number;
  lng: number;
  eta: string;
}

interface TripAssignment {
  trip: number;
  packages: RoutePackage[];
  total_weight: number;
  total_volume: number;
  total_packages: number;
  departure_time: string;
  return_time: string;
  route: { lat: number; lng: number }[];
  quality_score?: number;
  quality_flags?: string[];
}

interface RouteAssignment {
  driver_id: string;
  driver_name: string;
  shift_start: string;
  shift_end: string;
  depot?: { lat: number; lng: number; name: string };
  trips: TripAssignment[];
  total_packages: number;
  total_weight: number;
  total_volume: number;
  capacity_pct: number;
  volume_pct: number;
  route: { lat: number; lng: number }[];
  quality_score?: number;
  quality_flags?: string[];
  needs_review?: boolean;
}

interface OptimizationSummary {
  cost_matrix_pairs: number;
  risk_applied_count: number;
  absence_applied_count: number;
  construction_penalty_count: number;
  time_window_count: number;
  redelivery_count: number;
  recipient_breakdown: {
    apartment: number;
    office: number;
    house: number;
    other: number;
  };
  avg_risk_score: number | null;
  morning_pool: number;
  afternoon_pool: number;
  evening_pool: number;
  flex_pool: number;
  drop_off_count: number;
  face_to_face_count: number;
}

interface GenerateResult {
  date: string;
  total_packages: number;
  assigned_packages: number;
  unassigned_packages: number;
  drivers_used: number;
  review_needed_count?: number;
  assignments: RouteAssignment[];
  optimization_summary?: OptimizationSummary;
}

type Phase = "idle" | "generated" | "confirmed";

interface Props {
  date: string;
  onGenerated?: (result: GenerateResult) => void;
  onRouteUpdated?: (result: GenerateResult) => void;
  onConfirmed?: (result: GenerateResult) => void;
  onDriverSelect?: (driverId: string | null) => void;
  selectedDriverId?: string | null;
  onTripSelect?: (trip: number | null) => void;
  selectedTrip?: number | null;
}

const RECIPIENT_ICON: Record<string, typeof Building2> = {
  apartment: Building2,
  office: Briefcase,
  house: Home,
};

const RECIPIENT_LABEL: Record<string, string> = {
  apartment: "集合",
  office: "事務所",
  house: "戸建",
};

function riskColor(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 0.7) return "text-red-400";
  if (score >= 0.4) return "text-amber-400";
  return "text-green-400";
}

function riskBadge(score: number | null) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  if (score >= 0.7)
    return <Badge variant="destructive" className="h-4 px-1 text-[8px]">{pct}%</Badge>;
  if (score >= 0.4)
    return <Badge className="h-4 bg-amber-500 px-1 text-[8px] text-white">{pct}%</Badge>;
  return <Badge className="h-4 bg-green-600 px-1 text-[8px] text-white">{pct}%</Badge>;
}

function qualityBadge(score: number | undefined) {
  if (score == null) return null;
  if (score >= 85)
    return <Badge className="h-4 px-1.5 text-[9px] bg-green-600 text-white">{score}点</Badge>;
  if (score >= 70)
    return <Badge className="h-4 px-1.5 text-[9px] bg-amber-500 text-white">{score}点</Badge>;
  return <Badge variant="destructive" className="h-4 px-1.5 text-[9px]">{score}点</Badge>;
}

export function RouteGeneratePanel({
  date,
  onGenerated,
  onRouteUpdated,
  onConfirmed,
  onDriverSelect,
  selectedDriverId,
  onTripSelect,
  selectedTrip,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [showSummary, setShowSummary] = useState(true);
  const [dragState, setDragState] = useState<{
    driverId: string;
    tripIdx: number;
    fromIdx: number;
  } | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [selectedDriverIds, setSelectedDriverIds] = useState<Set<string>>(new Set());
  const [showLoadingOrder, setShowLoadingOrder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/plan/routes/confirmed?date=${date}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || !data.confirmed || !data.assignments?.length) return;
        setResult(data as GenerateResult);
        setPhase("confirmed");
        onGenerated?.(data);
        onConfirmed?.(data);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [date]);

  const requestGenerate = () => {
    setShowConfirmDialog(true);
  };

  const handleGenerate = async () => {
    setShowConfirmDialog(false);
    setLoading(true);
    setError(null);
    setResult(null);
    setPhase("idle");
    try {
      const res = await fetch("/api/plan/routes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, mode: "auto" }),
      });
      const data = await res.json();
      if (data.error && !data.assignments) {
        setError(data.error);
      } else {
        setResult(data);
        setPhase("generated");
        onGenerated?.(data);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!result) return;
    setConfirming(true);
    try {
      const moves = result.assignments.flatMap((a) =>
        a.trips.flatMap((t) =>
          t.packages.map((p) => ({
            package_id: p.package_id,
            to_driver_id: a.driver_id,
            stop_order: p.stop_order,
            trip: t.trip,
          }))
        )
      );
      const route_geometries = result.assignments.flatMap((a) =>
        a.trips.map((t) => ({
          route_id: `R-${a.driver_id}-${date}-T${t.trip}`,
          geometry: t.route.map((pt) => [pt.lng, pt.lat] as [number, number]),
        }))
      );
      const res = await fetch("/api/plan/routes/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, moves, route_geometries }),
      });
      if (res.ok) {
        setPhase("confirmed");
        onConfirmed?.(result);
      }
    } catch {
      setError("確定に失敗しました");
    } finally {
      setConfirming(false);
    }
  };

  const handleDragStart = useCallback(
    (driverId: string, tripIdx: number, pkgIdx: number) => {
      setDragState({ driverId, tripIdx, fromIdx: pkgIdx });
    },
    []
  );

  const handleDrop = useCallback(
    (driverId: string, tripIdx: number, toIdx: number) => {
      if (!dragState || !result) return;
      if (dragState.driverId !== driverId || dragState.tripIdx !== tripIdx) {
        setDragState(null);
        return;
      }

      const updated = { ...result };
      const assignment = updated.assignments.find((a) => a.driver_id === driverId);
      if (!assignment) return;

      const trip = assignment.trips[tripIdx];
      if (!trip) return;

      const pkgs = [...trip.packages];
      const [moved] = pkgs.splice(dragState.fromIdx, 1);
      pkgs.splice(toIdx, 0, moved);
      const reordered = pkgs.map((p, i) => ({ ...p, stop_order: i + 1 }));
      trip.packages = reordered;

      const depot = assignment.depot ?? { lat: 35.6495, lng: 139.7914 };
      trip.route = [
        { lat: depot.lat, lng: depot.lng },
        ...reordered.map((p) => ({ lat: p.lat, lng: p.lng })),
        { lat: depot.lat, lng: depot.lng },
      ];

      assignment.route = assignment.trips.flatMap((t) => t.route);

      setResult({ ...updated });
      setDragState(null);
      onRouteUpdated?.({ ...updated });
    },
    [dragState, result, onRouteUpdated]
  );

  const handleDriverClick = (driverId: string) => {
    const newId = selectedDriverId === driverId ? null : driverId;
    onDriverSelect?.(newId);
    setExpandedDriver(expandedDriver === driverId ? null : driverId);
    if (newId === null) onTripSelect?.(null);
  };

  const handleDriverCheck = (e: React.MouseEvent, driverId: string) => {
    e.stopPropagation();
    setSelectedDriverIds((prev) => {
      const next = new Set(prev);
      if (next.has(driverId)) next.delete(driverId);
      else next.add(driverId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (!result) return;
    if (selectedDriverIds.size === result.assignments.length) {
      setSelectedDriverIds(new Set());
    } else {
      setSelectedDriverIds(new Set(result.assignments.map((a) => a.driver_id)));
    }
  };

  const handleTripClick = (driverId: string, tripNum: number) => {
    if (selectedDriverId !== driverId) {
      onDriverSelect?.(driverId);
      setExpandedDriver(driverId);
    }
    onTripSelect?.(selectedTrip === tripNum ? null : tripNum);
  };

  const summary = result?.optimization_summary;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4 text-yellow-500" />
          ルート自動生成
          <MlBadge model="H3コスト行列+リスクスコア" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          {phase !== "confirmed" && (
            <Button
              size="sm"
              onClick={requestGenerate}
              disabled={loading || confirming}
              className="gap-1.5"
              variant={phase === "generated" ? "outline" : "default"}
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : phase === "generated" ? (
                <RotateCcw className="h-3 w-3" />
              ) : (
                <Zap className="h-3 w-3" />
              )}
              {loading
                ? "生成中..."
                : phase === "generated"
                  ? "再生成"
                  : "ルート生成"}
            </Button>
          )}
          {phase === "generated" && (
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={confirming}
              className="gap-1.5"
            >
              {confirming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              {confirming ? "確定中..." : "ルート確定"}
            </Button>
          )}
          {phase === "confirmed" && (
            <Badge variant="default" className="gap-1 bg-green-600">
              <CheckCircle className="h-3 w-3" />
              確定済み
            </Badge>
          )}
        </div>

        {phase === "generated" && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <ArrowUpDown className="h-3 w-3" />
            停車順はドラッグで変更可能。確定前に調整してください。
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 text-green-500" />
                <span className="font-medium">
                  {result.assigned_packages}/{result.total_packages} 件を{" "}
                  {result.drivers_used} 名に配分
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {(result.review_needed_count ?? 0) > 0 && (
                  <Badge variant="destructive" className="gap-0.5 text-[10px]">
                    <CircleAlert className="h-3 w-3" />
                    要確認 {result.review_needed_count}名
                  </Badge>
                )}
                {result.unassigned_packages > 0 && (
                  <Badge variant="outline" className="text-[10px] text-orange-400 border-orange-400/50">
                    未割当 {result.unassigned_packages}件
                  </Badge>
                )}
              </div>
            </div>

            {summary && (
              <div className="space-y-1">
                <button
                  className="flex w-full items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSummary(!showSummary)}
                >
                  <Info className="h-3 w-3" />
                  <span className="font-medium">最適化の根拠</span>
                  <ChevronDown className={`ml-auto h-3 w-3 transition-transform ${showSummary ? "rotate-180" : ""}`} />
                </button>
                {showSummary && (
                  <div className="rounded border bg-muted/30 p-2 space-y-1.5">
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <MapPin className="h-3 w-3" />
                        H3コスト行列
                      </div>
                      <div className="text-right font-medium">
                        {summary.cost_matrix_pairs > 0
                          ? <span className="text-green-400">{summary.cost_matrix_pairs.toLocaleString()}ペア</span>
                          : <span className="text-amber-400">未使用 (Haversine)</span>}
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <ShieldAlert className="h-3 w-3" />
                        リスクスコア反映
                      </div>
                      <div className="text-right font-medium">
                        {summary.risk_applied_count}件
                        {summary.avg_risk_score != null && (
                          <span className={`ml-1 ${riskColor(summary.avg_risk_score)}`}>
                            (平均{(Number(summary.avg_risk_score) * 100).toFixed(0)}%)
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <AlertTriangle className="h-3 w-3" />
                        工事ペナルティ
                      </div>
                      <div className="text-right font-medium">
                        {summary.construction_penalty_count > 0
                          ? <span className="text-amber-400">{summary.construction_penalty_count}件</span>
                          : "0件"}
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        時間指定
                      </div>
                      <div className="text-right font-medium">{summary.time_window_count}件</div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <RotateCcw className="h-3 w-3" />
                        再配達
                      </div>
                      <div className="text-right font-medium">{summary.redelivery_count}件</div>
                    </div>
                    <div className="border-t pt-1.5">
                      <div className="mb-1 text-[9px] text-muted-foreground font-medium">配送先タイプ内訳</div>
                      <div className="flex gap-3 text-[10px]">
                        <span className="flex items-center gap-0.5">
                          <Building2 className="h-3 w-3 text-blue-400" />
                          集合 {summary.recipient_breakdown.apartment}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Briefcase className="h-3 w-3 text-purple-400" />
                          事務所 {summary.recipient_breakdown.office}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Home className="h-3 w-3 text-green-400" />
                          戸建 {summary.recipient_breakdown.house}
                        </span>
                      </div>
                    </div>
                    <div className="border-t pt-1.5">
                      <div className="mb-1 text-[9px] text-muted-foreground font-medium">時間帯別プール</div>
                      <div className="flex gap-2 text-[10px]">
                        <Badge variant="secondary" className="text-[9px] gap-1">
                          午前 {summary.morning_pool}
                        </Badge>
                        <Badge variant="secondary" className="text-[9px] gap-1">
                          午後 {summary.afternoon_pool}
                        </Badge>
                        <Badge variant="secondary" className="text-[9px] gap-1">
                          夜間 {summary.evening_pool}
                        </Badge>
                        <Badge variant="secondary" className="text-[9px] gap-1">
                          指定なし {summary.flex_pool}
                        </Badge>
                      </div>
                    </div>
                    <div className="border-t pt-1.5">
                      <div className="mb-1 text-[9px] text-muted-foreground font-medium">配送方法</div>
                      <div className="flex gap-3 text-[10px]">
                        <span className="flex items-center gap-0.5">
                          <Badge className="h-3.5 px-1 text-[8px] bg-cyan-600 text-white">置配</Badge>
                          {summary.drop_off_count}件
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Badge variant="outline" className="h-3.5 px-1 text-[8px]">対面</Badge>
                          {summary.face_to_face_count}件
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="max-h-[500px] space-y-1.5 overflow-y-auto">
              {phase === "generated" && (
                <div className="flex items-center justify-between border-b pb-1.5 mb-1">
                  <button
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={handleSelectAll}
                  >
                    {selectedDriverIds.size === result.assignments.length ? (
                      <CheckSquare className="h-3 w-3 text-primary" />
                    ) : (
                      <Square className="h-3 w-3" />
                    )}
                    全ドライバー選択
                  </button>
                  {selectedDriverIds.size > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {selectedDriverIds.size}名選択中
                    </span>
                  )}
                </div>
              )}
              {result.assignments.map((a) => {
                const isSelected = selectedDriverId === a.driver_id;
                const isExpanded = expandedDriver === a.driver_id;
                const isChecked = selectedDriverIds.has(a.driver_id);
                const lastTrip = a.trips[a.trips.length - 1];
                const estimatedReturn = lastTrip?.return_time ?? "—";

                return (
                  <div
                    key={a.driver_id}
                    className={`rounded border transition-all ${
                      a.needs_review
                        ? "border-destructive/40 bg-destructive/5"
                        : isSelected
                          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                          : "hover:border-muted-foreground/30"
                    }`}
                  >
                    <button
                      className="flex w-full items-center justify-between p-2 text-left text-xs"
                      onClick={() => handleDriverClick(a.driver_id)}
                    >
                      <div className="flex items-center gap-1.5">
                        {phase === "generated" && (
                          <span onClick={(e) => handleDriverCheck(e, a.driver_id)}>
                            {isChecked ? (
                              <CheckSquare className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <Square className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </span>
                        )}
                        <Truck className="h-3 w-3 text-muted-foreground" />
                        <span className="font-medium">{a.driver_name}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {a.total_packages}件
                        </Badge>
                        {qualityBadge(a.quality_score)}
                        {a.needs_review && (
                          <CircleAlert className="h-3 w-3 text-destructive" />
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Weight className="h-3 w-3" />
                          {Number(a.total_weight).toFixed(1)}kg
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Box className="h-3 w-3" />
                          {Number(a.total_volume).toFixed(2)}m³
                        </div>
                        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                      </div>
                    </button>

                    <div className="px-2 pb-1.5">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <div className="mb-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>重量</span>
                            <span>{a.capacity_pct}%</span>
                          </div>
                          <Progress value={a.capacity_pct} className="h-1.5" />
                        </div>
                        <div className="flex-1">
                          <div className="mb-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>体積</span>
                            <span>{a.volume_pct}%</span>
                          </div>
                          <Progress value={a.volume_pct} className="h-1.5" />
                        </div>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {a.shift_start}〜{a.shift_end}
                        </span>
                        <span>
                          帰着予定 <span className="font-medium text-foreground">{estimatedReturn}</span>
                        </span>
                      </div>
                      {!isExpanded && a.trips.length > 0 && (
                        <div className="mt-1 flex gap-1.5 text-[10px]">
                          {a.trips.map((t) => (
                            <Badge
                              key={t.trip}
                              variant={selectedTrip === t.trip && isSelected ? "default" : "outline"}
                              className={`text-[9px] gap-0.5 cursor-pointer transition-colors ${
                                selectedTrip === t.trip && isSelected ? "ring-1 ring-primary" : "hover:bg-accent"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleTripClick(a.driver_id, t.trip);
                              }}
                            >
                              {t.trip}便 {t.total_packages}件
                              <span className="text-muted-foreground">
                                {t.departure_time}→{t.return_time}
                              </span>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    {isExpanded &&
                      a.trips.map((trip, tripIdx) => {
                        const tripRiskPkgs = trip.packages.filter((p) => p.risk_score != null && p.risk_score >= 0.4);
                        const tripRedelivery = trip.packages.filter((p) => p.is_redelivery).length;
                        const typeCounts = trip.packages.reduce<Record<string, number>>((acc, p) => {
                          acc[p.recipient_type] = (acc[p.recipient_type] || 0) + 1;
                          return acc;
                        }, {});

                        return (
                          <div key={trip.trip} className="border-t px-2 pb-2 pt-1.5">
                            <div
                              className={`mb-1.5 rounded p-1.5 cursor-pointer transition-colors ${
                                selectedTrip === trip.trip
                                  ? "bg-primary/15 ring-1 ring-primary/40"
                                  : "bg-muted/40 hover:bg-muted/60"
                              }`}
                              onClick={() => handleTripClick(a.driver_id, trip.trip)}
                            >
                              <div className="flex items-center justify-between text-[10px]">
                                <div className="flex items-center gap-1 font-medium">
                                  <Package className="h-3 w-3 text-muted-foreground" />
                                  {trip.trip}便目
                                  {trip.trip === 1 ? " ━━" : " ┄┄"}
                                  {qualityBadge(trip.quality_score)}
                                </div>
                                <span className="text-muted-foreground">
                                  {trip.departure_time}〜{trip.return_time}
                                </span>
                              </div>
                              <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] text-muted-foreground">
                                <div className="text-center">
                                  <div className="font-medium text-foreground">{trip.total_packages}</div>
                                  <div>件数</div>
                                </div>
                                <div className="text-center">
                                  <div className="font-medium text-foreground">{Number(trip.total_weight).toFixed(1)}kg</div>
                                  <div>重量</div>
                                </div>
                                <div className="text-center">
                                  <div className="font-medium text-foreground">{Number(trip.total_volume).toFixed(2)}m³</div>
                                  <div>体積</div>
                                </div>
                                <div className="text-center">
                                  <div className={`font-medium ${tripRiskPkgs.length > 0 ? "text-amber-400" : "text-foreground"}`}>
                                    {tripRiskPkgs.length}
                                  </div>
                                  <div>高リスク</div>
                                </div>
                              </div>
                              <div className="mt-1 flex gap-2 text-[9px]">
                                {Object.entries(typeCounts).map(([type, count]) => {
                                  const Icon = RECIPIENT_ICON[type] ?? MapPin;
                                  return (
                                    <span key={type} className="flex items-center gap-0.5 text-muted-foreground">
                                      <Icon className="h-2.5 w-2.5" />
                                      {RECIPIENT_LABEL[type] ?? type} {count}
                                    </span>
                                  );
                                })}
                                {tripRedelivery > 0 && (
                                  <span className="flex items-center gap-0.5 text-orange-400">
                                    <RotateCcw className="h-2.5 w-2.5" />
                                    再配達 {tripRedelivery}
                                  </span>
                                )}
                              </div>
                              {trip.quality_flags && trip.quality_flags.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {trip.quality_flags.map((flag, fi) => (
                                    <Badge key={fi} variant="outline" className="text-[8px] text-amber-400 border-amber-400/40">
                                      {flag}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              {phase === "confirmed" && (
                                <div className="mt-1.5">
                                  <LoadConfirmButton
                                    date={result!.date}
                                    driverId={a.driver_id}
                                    driverName={a.driver_name}
                                    tripNumber={trip.trip}
                                    packageCount={trip.total_packages}
                                  />
                                </div>
                              )}
                            </div>
                            <div className="max-h-[250px] overflow-y-auto">
                              {phase === "confirmed" && (
                                <div className="mb-1 flex items-center gap-1 px-1">
                                  <button
                                    onClick={() => setShowLoadingOrder(false)}
                                    className={`rounded px-1.5 py-0.5 text-[9px] ${!showLoadingOrder ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                                  >
                                    配達順
                                  </button>
                                  <button
                                    onClick={() => setShowLoadingOrder(true)}
                                    className={`rounded px-1.5 py-0.5 text-[9px] ${showLoadingOrder ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                                  >
                                    積込順
                                  </button>
                                </div>
                              )}
                              <div className="mb-1 grid grid-cols-[20px_20px_1fr_22px_28px_28px_40px_44px] gap-0.5 text-[9px] font-medium text-muted-foreground">
                                <span></span>
                                <span>{showLoadingOrder && phase === "confirmed" ? "積" : "#"}</span>
                                <span>住所</span>
                                <span className="text-center">配</span>
                                <span className="text-center">種別</span>
                                <span className="text-center">危険</span>
                                <span className="text-right">ETA</span>
                                <span className="text-right">時間帯</span>
                              </div>
                              {(showLoadingOrder && phase === "confirmed"
                                ? [...trip.packages].reverse().map((p, i) => ({ ...p, _loadingOrder: i + 1 }))
                                : trip.packages.map((p) => ({ ...p, _loadingOrder: 0 }))
                              ).map((p, pkgIdx) => {
                                const RecIcon = RECIPIENT_ICON[p.recipient_type] ?? MapPin;
                                return (
                                  <div
                                    key={p.package_id}
                                    draggable={phase === "generated"}
                                    onDragStart={() =>
                                      handleDragStart(a.driver_id, tripIdx, pkgIdx)
                                    }
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={() =>
                                      handleDrop(a.driver_id, tripIdx, pkgIdx)
                                    }
                                    className={`grid grid-cols-[20px_20px_1fr_22px_28px_28px_40px_44px] items-center gap-0.5 py-0.5 text-[10px] text-muted-foreground ${
                                      phase === "generated"
                                        ? "cursor-grab hover:bg-accent/50 active:cursor-grabbing"
                                        : ""
                                    }`}
                                  >
                                    <span className="flex items-center justify-center">
                                      {phase === "generated" && (
                                        <GripVertical className="h-3 w-3 text-muted-foreground/40" />
                                      )}
                                    </span>
                                    <span className="text-right font-mono">
                                      {showLoadingOrder && phase === "confirmed" ? p._loadingOrder : p.stop_order}
                                    </span>
                                    <span className="flex items-center gap-0.5 truncate">
                                      {p.is_redelivery && (
                                        <Badge
                                          variant="outline"
                                          className="h-3 shrink-0 px-0.5 text-[7px] text-orange-400 border-orange-400/50"
                                        >
                                          再
                                        </Badge>
                                      )}
                                      <span className="truncate">{p.address}</span>
                                    </span>
                                    <span className="flex justify-center">
                                      {p.delivery_method === "drop_off" ? (
                                        <Badge className="h-3 px-0.5 text-[7px] bg-cyan-600 text-white">置</Badge>
                                      ) : (
                                        <Badge variant="outline" className="h-3 px-0.5 text-[7px]">対</Badge>
                                      )}
                                    </span>
                                    <span className="flex justify-center">
                                      <RecIcon className="h-3 w-3" />
                                    </span>
                                    <span className="flex justify-center">
                                      {riskBadge(p.risk_score)}
                                    </span>
                                    <span className="text-right font-mono text-[9px]">
                                      {p.eta}
                                    </span>
                                    <span className="text-right text-[9px]">
                                      {p.time_window || "—"}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ルート生成の確認</DialogTitle>
            <DialogDescription>
              以下のロジック・優先度でルートを生成します。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            <div>
              <div className="font-semibold mb-1">1. 便の振り分け（タイムプール）</div>
              <ul className="ml-4 space-y-0.5 text-muted-foreground list-disc">
                <li>午前指定（〜13:00）＋ 時間指定なし → <span className="text-foreground font-medium">1便プール</span></li>
                <li>午後指定（14:00〜）＋ 夜間指定（17:00〜）→ <span className="text-foreground font-medium">2便プール</span></li>
              </ul>
            </div>

            <div>
              <div className="font-semibold mb-1">2. エリアクラスタリング</div>
              <ul className="ml-4 space-y-0.5 text-muted-foreground list-disc">
                <li>H3 Resolution 8（≈460m六角形）で荷物をグループ化</li>
                <li>件数・重量上限を超えるクラスタは地理的に分割</li>
                <li>大きいクラスタから優先的にドライバーへ割当</li>
              </ul>
            </div>

            <div>
              <div className="font-semibold mb-1">3. ドライバー割当（エリア親和性）</div>
              <ul className="ml-4 space-y-0.5 text-muted-foreground list-disc">
                <li>既存荷物との距離（エリア親和性）でスコアリング</li>
                <li>車両の重量・体積制約を厳守</li>
                <li>クラスタ単位で割当不可時は個別フォールバック</li>
              </ul>
            </div>

            <div>
              <div className="font-semibold mb-1">4. ルート順序（貪欲法 + 2-opt改善）</div>
              <ul className="ml-4 space-y-0.5 text-muted-foreground list-disc">
                <li>H3コスト行列（距離 × リスク × 渋滞）で最近傍を選択</li>
                <li>2-opt局所探索で辺交差を解消（最大10反復）</li>
                <li>時間指定の早着ペナルティ ×0.1 / 遅延ペナルティ ×2</li>
                <li>工事区域は高リスク扱い（0.8以上）</li>
              </ul>
            </div>

            <div>
              <div className="font-semibold mb-1">5. 配送方法の考慮</div>
              <ul className="ml-4 space-y-0.5 text-muted-foreground list-disc">
                <li>置き配 → 滞在1分、不在ペナルティなし</li>
                <li>対面 → 滞在5分、不在率40%超はペナルティ加算</li>
              </ul>
            </div>

            <div>
              <div className="font-semibold mb-1">6. シフト制約</div>
              <ul className="ml-4 space-y-0.5 text-muted-foreground list-disc">
                <li>帰着がシフト終了を超える場合、末尾の配送先を除外</li>
                <li>便間の拠点折返し時間: 20分</li>
              </ul>
            </div>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>
              キャンセル
            </DialogClose>
            <Button size="sm" onClick={handleGenerate} className="gap-1.5">
              <Zap className="h-3 w-3" />
              生成する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
