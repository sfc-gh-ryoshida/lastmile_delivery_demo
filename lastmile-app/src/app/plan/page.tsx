"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import useSWR from "swr";
import { safeFetch, safeFetchWithMeta, type FetchMeta } from "@/lib/fetcher";
import { DeckMapLazy as DeckMap } from "@/components/map/deck-map-lazy";
import { useH3RiskLayer } from "@/components/map/h3-risk-layer";
import { useWeatherLayer } from "@/components/map/weather-layer";
import { useConstructionLayer } from "@/components/map/construction-layer";
import { useBuildingDensityLayer, type BuildingDensity } from "@/components/map/building-density-layer";
import { useRouteLayer } from "@/components/map/route-layer";
import { PackageTable, type PkgRow } from "@/components/plan/package-table";
import { DriverAssignment } from "@/components/plan/driver-assignment";
import { RouteGeneratePanel } from "@/components/plan/route-generate-panel";
import { RouteAssignmentBoard } from "@/components/plan/route-assignment-board";
import { WeatherPanel } from "@/components/plan/weather-panel";
import { ConstructionList } from "@/components/plan/construction-list";
import { DriverAttendancePanel } from "@/components/plan/load-confirm-panel";
import { MlBadge } from "@/components/shared/ml-badge";
import { useDate } from "@/context/date-context";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { CloudRain, Building2, ShieldAlert, Route, Construction, Database, Zap, Clock, Play, Pause, RotateCcw } from "lucide-react";
import { ResizableSplit } from "@/components/shared/resizable-split";
import { RiskLegend } from "@/components/plan/risk-legend";
import type { RiskScore, WeatherForecast, RoadConstruction, Driver } from "@/types";

type H3Resolution = 10 | 11;
type DataSource = "sf" | "pg";

const RISK_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
function nearestValidHour(h: number): number {
  let best = RISK_HOURS[0];
  let diff = Math.abs(h - best);
  for (const v of RISK_HOURS) {
    const d = Math.abs(h - v);
    if (d < diff) { diff = d; best = v; }
  }
  return best;
}

const DRIVER_COLORS: [number, number, number][] = [
  [59, 130, 246],
  [16, 185, 129],
  [245, 158, 11],
  [239, 68, 68],
  [168, 85, 247],
  [236, 72, 153],
  [20, 184, 166],
  [249, 115, 22],
  [99, 102, 241],
  [34, 197, 94],
  [244, 63, 94],
  [14, 165, 233],
];

interface RouteResult {
  driver_id: string;
  driver_name: string;
  route: { lat: number; lng: number }[];
  total_packages: number;
  trips?: { trip: number; route: { lat: number; lng: number }[]; total_packages: number; packages?: { stop_order: number; lat: number; lng: number }[] }[];
}

function PerfBadge({ label, meta }: { label: string; meta: FetchMeta | null }) {
  if (!meta || !meta.ms) return null;
  const color = meta.source === "pg" ? "text-green-400" : "text-blue-400";
  const msColor = meta.ms < 300 ? "text-green-300" : meta.ms < 1000 ? "text-yellow-300" : "text-red-300";
  return (
    <div className="flex items-center gap-1.5 rounded bg-black/70 px-2 py-0.5 text-[10px] font-mono text-zinc-300 backdrop-blur">
      <span className="text-zinc-500">{label}</span>
      <span className={color}>{meta.source === "pg" ? "ft_*" : "SF"}</span>
      <Zap className="h-2.5 w-2.5 text-yellow-400" />
      <span className={msColor}>{meta.ms.toLocaleString()}ms</span>
      <span className="text-zinc-500">{meta.rows.toLocaleString()}</span>
    </div>
  );
}

export default function PlanPage() {
  const { date } = useDate();
  const [hour, setHour] = useState(() => Math.min(Math.max(new Date().getHours(), 6), 21));
  const [playing, setPlaying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setHour((h) => {
          if (h >= 21) { setPlaying(false); return 21; }
          return h + 1;
        });
      }, 1500);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing]);
  const [showRisk, setShowRisk] = useState(false);
  const [showWeather, setShowWeather] = useState(false);
  const [showBuilding, setShowBuilding] = useState(false);
  const [showConstruction, setShowConstruction] = useState(false);
  const [riskResolution, setRiskResolution] = useState<H3Resolution>(11);
  const [buildingResolution, setBuildingResolution] = useState<H3Resolution>(11);
  const [riskSource, setRiskSource] = useState<DataSource>("sf");
  const [buildingSource, setBuildingSource] = useState<DataSource>("sf");
  const [highlightedConstructionId, setHighlightedConstructionId] = useState<number | null>(null);
  const [routeData, setRouteData] = useState<{ driver_id: string; name: string; color: [number, number, number]; path: [number, number][]; delivered: number; total: number; stops?: { lng: number; lat: number; stopOrder: number; color: [number, number, number]; driverId: string; trip?: number }[]; tripRoutes?: { driver_id: string; trip: number; color: [number, number, number]; path: [number, number][]; stops: { lng: number; lat: number; stopOrder: number; color: [number, number, number]; driverId: string; trip: number }[] }[] }[]>([]);
  const [showRoutes, setShowRoutes] = useState(true);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<number | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getTooltip = useCallback((info: any) => {
    if (!info.object) return null;
    const obj = info.object;
    if (info.layer?.id === "h3-building-density") {
      const b = obj as BuildingDensity;
      return {
        html: `
          <div style="font-size:12px;line-height:1.6;min-width:160px">
            <div style="font-weight:600;margin-bottom:4px">🏢 マンション密集エリア</div>
            <div style="display:flex;justify-content:space-between"><span>棟数</span><span>${b.APARTMENT_COUNT}棟</span></div>
            <div style="display:flex;justify-content:space-between"><span>平均階数</span><span>${b.AVG_FLOORS}階</span></div>
            <div style="display:flex;justify-content:space-between"><span>宅配ボックス</span><span>${(b.HAS_BOX_PCT * 100).toFixed(0)}%</span></div>
            <div style="border-top:1px solid rgba(255,255,255,0.15);margin:4px 0"></div>
            <div style="display:flex;justify-content:space-between"><span>配送数</span><span>${b.TOTAL_DELIVERIES}件</span></div>
            <div style="display:flex;justify-content:space-between"><span>不在率</span><span style="color:${b.LATE_RATE >= 0.2 ? '#f87171' : '#a1a1aa'}">${(b.LATE_RATE * 100).toFixed(1)}%</span></div>
          </div>`,
        style: {
          backgroundColor: "rgba(24,24,27,0.95)",
          color: "#e4e4e7",
          borderRadius: "8px",
          padding: "8px 12px",
          border: "1px solid rgba(255,255,255,0.1)",
        },
      };
    }
    const d = obj as RiskScore;
    if (!d.RISK_SCORE && d.RISK_SCORE !== 0) return null;
    const f = d.RISK_FACTORS || {} as Record<string, unknown>;
    const rate = (v: unknown) => typeof v === "number" ? (v * 100).toFixed(1) + "%" : "–";
    const mult = (v: unknown) => typeof v === "number" ? "×" + v.toFixed(2) : "–";
    return {
      html: `
        <div style="font-size:12px;line-height:1.6;min-width:180px">
          <div style="font-weight:600;margin-bottom:4px">予測遅配率: ${(d.RISK_SCORE * 100).toFixed(1)}%</div>
          <div style="display:flex;justify-content:space-between"><span>ベース不在率</span><span>${rate(f.base_absent_rate)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>天候影響</span><span>+${rate(f.weather_effect)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>建物係数</span><span>${mult(f.building_mult)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>エリア係数</span><span>${mult(f.poi_mult)}</span></div>
        </div>`,
      style: {
        backgroundColor: "rgba(24,24,27,0.95)",
        color: "#e4e4e7",
        borderRadius: "8px",
        padding: "8px 12px",
        border: "1px solid rgba(255,255,255,0.1)",
      },
    };
  }, []);

  const { data: packages } = useSWR<PkgRow[]>(
    `/api/plan/packages?date=${date}`,
    safeFetch
  );
  const { data: drivers } = useSWR<Driver[]>(
    "/api/plan/drivers",
    safeFetch
  );
  const { data: riskResult } = useSWR(
    `/api/plan/risk-map?date=${date}&hour=all&resolution=${riskResolution}&source=${riskSource}`,
    safeFetchWithMeta<RiskScore>
  );
  const allRisk = riskResult?.data;
  const riskMeta = riskResult?.meta ?? null;
  const risk = useMemo(() => {
    if (!allRisk) return [];
    const nearest = nearestValidHour(hour);
    return allRisk.filter((r) => r.HOUR === nearest);
  }, [allRisk, hour]);

  const { data: weather } = useSWR<WeatherForecast[]>(
    `/api/plan/weather?date=${date}`,
    safeFetch
  );
  const { data: construction } = useSWR<RoadConstruction[]>(
    `/api/plan/construction?date=${date}`,
    safeFetch
  );
  const { data: buildingResult } = useSWR(
    showBuilding ? `/api/plan/building-density?resolution=${buildingResolution}&source=${buildingSource}` : null,
    safeFetchWithMeta<BuildingDensity>
  );
  const buildingData = buildingResult?.data;
  const buildingMeta = buildingResult?.meta ?? null;

  const currentWeather = (weather || []).filter((w) => {
    const h = new Date(w.DATETIME).getHours();
    return h >= hour && h < hour + 3;
  });

  const riskLayer = useH3RiskLayer(showRisk ? (risk || []) : []);
  const weatherLayer = useWeatherLayer(showWeather ? currentWeather : []);
  const constructionLayers = useConstructionLayer(showConstruction ? (construction || []) : []);
  const buildingLayer = useBuildingDensityLayer(showBuilding ? (buildingData || []) : []);
  const routeLayers = useRouteLayer(showRoutes ? routeData : [], selectedDriverId, selectedTrip);

  const buildRouteData = useCallback((result: { assignments: RouteResult[] }) => {
    return result.assignments.map((a, i) => {
      const color = DRIVER_COLORS[i % DRIVER_COLORS.length];
      const stops = (a.trips ?? []).flatMap((t) =>
        (t.packages ?? []).map((p) => ({
          lng: p.lng,
          lat: p.lat,
          stopOrder: p.stop_order,
          color,
          driverId: a.driver_id,
          trip: t.trip ?? 1,
        }))
      );
      const tripRoutes = (a.trips ?? []).map((t) => ({
        driver_id: a.driver_id,
        trip: t.trip ?? 1,
        color,
        path: t.route.map((p) => [p.lng, p.lat] as [number, number]),
        stops: (t.packages ?? []).map((p) => ({
          lng: p.lng,
          lat: p.lat,
          stopOrder: p.stop_order,
          color,
          driverId: a.driver_id,
          trip: t.trip ?? 1,
        })),
      }));
      return {
        driver_id: a.driver_id,
        name: a.driver_name,
        color,
        path: a.route.map((p) => [p.lng, p.lat] as [number, number]),
        delivered: 0,
        total: a.total_packages,
        stops,
        tripRoutes,
      };
    });
  }, []);

  const handleRouteGenerated = useCallback((result: { assignments: RouteResult[] }) => {
    setRouteData(buildRouteData(result));
    setSelectedTrip(null);
  }, [buildRouteData]);

  const handleRouteUpdated = useCallback((result: { assignments: RouteResult[] }) => {
    setRouteData(buildRouteData(result));
  }, [buildRouteData]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMapClick = useCallback((info: any) => {
    if (info.layer?.id === "construction-points" && info.object) {
      const cId = info.object.construction_id;
      setHighlightedConstructionId(cId);
      setTimeout(() => {
        const el = document.getElementById(`construction-${cId}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
    }
  }, []);

  const layers = [riskLayer, buildingLayer, ...constructionLayers, weatherLayer, ...routeLayers];

  const mapSection = (
    <div className="relative h-full">
      <DeckMap layers={layers} getTooltip={getTooltip} onClick={handleMapClick} />
      <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 pointer-events-auto">
        <div className="flex items-center gap-2 rounded-xl bg-background/90 px-4 py-2 shadow-lg backdrop-blur border">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { if (hour >= 21) setHour(6); setPlaying((p) => !p); }}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { setPlaying(false); setHour(6); }}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-sm font-semibold w-12 text-center">{String(hour).padStart(2, "0")}:00</span>
          <Slider
            className="w-48"
            min={6}
            max={21}
            step={1}
            value={[hour]}
            onValueChange={([v]) => { setPlaying(false); setHour(v); }}
          />
          <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500 transition-all"
              style={{ width: `${((hour - 6) / 15) * 100}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">リスク・天気連動</span>
        </div>
      </div>
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-1 pointer-events-auto">
        <MlBadge model="リスクスコア" />
        <div className="flex items-center gap-1">
          <Badge
            variant={showRisk ? "default" : "outline"}
            className="cursor-pointer gap-1 text-[10px]"
            onClick={() => setShowRisk((v) => !v)}
          >
            <ShieldAlert className="h-3 w-3" />
            リスク
          </Badge>
          {showRisk && (
            <>
              <Badge
                variant="secondary"
                className="cursor-pointer text-[10px]"
                onClick={() => setRiskResolution((v) => (v === 11 ? 10 : 11))}
              >
                R{riskResolution}
              </Badge>
              <Badge
                variant={riskSource === "pg" ? "default" : "secondary"}
                className="cursor-pointer gap-0.5 text-[10px]"
                onClick={() => setRiskSource((v) => (v === "sf" ? "pg" : "sf"))}
              >
                <Database className="h-2.5 w-2.5" />
                {riskSource === "pg" ? "PG" : "SF"}
              </Badge>
            </>
          )}
        </div>
        <Badge
          variant={showWeather ? "default" : "outline"}
          className="cursor-pointer gap-1 text-[10px]"
          onClick={() => setShowWeather((v) => !v)}
        >
          <CloudRain className="h-3 w-3" />
          天気
        </Badge>
        <div className="flex items-center gap-1">
          <Badge
            variant={showBuilding ? "default" : "outline"}
            className="cursor-pointer gap-1 text-[10px]"
            onClick={() => setShowBuilding((v) => !v)}
          >
            <Building2 className="h-3 w-3" />
            マンション密集
          </Badge>
          {showBuilding && (
            <>
              <Badge
                variant="secondary"
                className="cursor-pointer text-[10px]"
                onClick={() => setBuildingResolution((v) => (v === 11 ? 10 : 11))}
              >
                R{buildingResolution}
              </Badge>
              <Badge
                variant={buildingSource === "pg" ? "default" : "secondary"}
                className="cursor-pointer gap-0.5 text-[10px]"
                onClick={() => setBuildingSource((v) => (v === "sf" ? "pg" : "sf"))}
              >
                <Database className="h-2.5 w-2.5" />
                {buildingSource === "pg" ? "PG" : "SF"}
              </Badge>
            </>
          )}
        </div>
        <Badge
          variant={showConstruction ? "default" : "outline"}
          className="cursor-pointer gap-1 text-[10px]"
          onClick={() => setShowConstruction((v) => !v)}
        >
          <Construction className="h-3 w-3" />
          工事
        </Badge>
        {routeData.length > 0 && (
          <Badge
            variant={showRoutes ? "default" : "outline"}
            className="cursor-pointer gap-1 text-[10px]"
            onClick={() => setShowRoutes((v) => !v)}
          >
            <Route className="h-3 w-3" />
            ルート ({routeData.length}名)
          </Badge>
        )}
      </div>
      <div className="absolute bottom-4 left-3 z-10 flex flex-col gap-1">
        <RiskLegend />
        {showRisk && <PerfBadge label="リスク" meta={riskMeta} />}
        {showBuilding && <PerfBadge label="密集" meta={buildingMeta} />}
      </div>
    </div>
  );

  const sidebar = (
    <div className="flex h-full flex-col overflow-y-auto bg-card p-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">計画</h2>
        </div>
        <WeatherPanel data={weather || []} selectedHour={hour} />
        <RouteGeneratePanel
          date={date}
          onGenerated={handleRouteGenerated}
          onRouteUpdated={handleRouteUpdated}
          onDriverSelect={setSelectedDriverId}
          selectedDriverId={selectedDriverId}
          onTripSelect={setSelectedTrip}
          selectedTrip={selectedTrip}
        />
        <DriverAttendancePanel date={date} />
        <RouteAssignmentBoard date={date} drivers={drivers || []} />
        <DriverAssignment drivers={drivers || []} />
        <ConstructionList
          data={construction || []}
          highlightedId={highlightedConstructionId}
          onClearHighlight={() => setHighlightedConstructionId(null)}
        />
        <PackageTable data={packages || []} />
      </div>
    </div>
  );

  return (
    <ResizableSplit
      left={mapSection}
      right={sidebar}
      defaultRightWidth={440}
    />
  );
}
