"use client";

import { useState, useCallback } from "react";
import useSWR from "swr";
import { safeFetch } from "@/lib/fetcher";
import { DeckMapLazy as DeckMap } from "@/components/map/deck-map-lazy";
import { useDriverIconLayer } from "@/components/map/driver-icon-layer";
import { useTrafficLayer } from "@/components/map/traffic-layer";
import { useIncidentLayer } from "@/components/map/incident-layer";
import { useRouteLayer } from "@/components/map/route-layer";
import { useTripsLayer, type TrailData } from "@/components/map/trips-layer";
import { DriverStatusList } from "@/components/monitor/driver-status-list";
import { AlertPanel } from "@/components/monitor/alert-panel";
import { ProgressBar } from "@/components/monitor/progress-bar";
import { IncidentPanel } from "@/components/monitor/incident-panel";
import { DwellPanel } from "@/components/monitor/dwell-panel";
import { RouteReadjustPanel } from "@/components/monitor/route-readjust-panel";
import { NextTripPanel } from "@/components/monitor/next-trip-panel";
import { DriverWithdrawPanel } from "@/components/monitor/driver-withdraw-panel";
import { MapClickDialog } from "@/components/monitor/map-click-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { MapPin, X, Route, Play, Pause, RotateCcw, Activity } from "lucide-react";
import { useDate } from "@/context/date-context";
import { ResizableSplit } from "@/components/shared/resizable-split";
import type { DriverProgress, DriverLocation, TrafficRealtime, AnomalyAlert } from "@/types";

interface RouteData {
  driver_id: string;
  name: string;
  color: [number, number, number];
  path: [number, number][];
  delivered: number;
  total: number;
  round?: number;
  latest_completed_at?: string | null;
}

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

interface IncidentResult {
  center: { lat: number; lng: number; k: number; h3_index?: string };
  h3_analysis?: {
    resolution: number;
    hex_edge_km: number;
    total_impact_cells: number;
    impact_area_km2: number;
    rings: { ring: number; cells: number; radius_m: number }[];
  };
  impact_cells: { h3_index: string; ring: number; impact_weight?: number; congestion_level?: number | null; has_construction?: boolean }[];
  affected_drivers: {
    driver_id: string;
    name: string;
    driver_h3?: string;
    distance_ring: number;
    affected_packages: number;
    total_packages?: number;
    delivered?: number;
    remaining?: number;
    packages_in_zone?: number;
    driver_in_zone?: boolean;
    impact_reasons?: string[];
    impact_detail?: string;
    recommended_action?: string;
    route_blocked_pct?: number;
  }[];
  summary?: {
    total_affected_drivers: number;
    drivers_in_zone: number;
    drivers_with_packages: number;
    total_affected_packages: number;
  };
  road_context?: {
    congested_cells: number;
    construction_cells: number;
    avg_impact_weight: number;
    max_impact_weight: number;
  };
}

interface SelectedDriver {
  driver_id: string;
  name: string;
  lat: number;
  lng: number;
  speed: number;
  delivered?: number;
  total_packages?: number;
}

export default function MonitorPage() {
  const { date } = useDate();
  const [incident, setIncident] = useState<IncidentResult | null>(null);
  const [incidentLoading, setIncidentLoading] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<SelectedDriver | null>(null);
  const [pendingClick, setPendingClick] = useState<{ lat: number; lng: number } | null>(null);
  const [showRoutes, setShowRoutes] = useState(true);
  const [showTraffic, setShowTraffic] = useState(true);
  const [routeDriverId, setRouteDriverId] = useState<string | null>(null);
  const [trailPlaying, setTrailPlaying] = useState(false);
  const [trailSpeed, setTrailSpeed] = useState(60);

  const { data: progress } = useSWR<DriverProgress[]>(
    `/api/monitor/progress?date=${date}`,
    safeFetch,
    { refreshInterval: 10000 }
  );
  const { data: locations } = useSWR<DriverLocation[]>(
    "/api/monitor/locations",
    safeFetch,
    { refreshInterval: 3000 }
  );
  const { data: traffic } = useSWR<TrafficRealtime[]>(
    "/api/monitor/traffic",
    safeFetch,
    { refreshInterval: 60000 }
  );
  const { data: alerts } = useSWR<AnomalyAlert[]>(
    `/api/monitor/alerts?date=${date}`,
    safeFetch,
    { refreshInterval: 30000 }
  );
  const { data: routes } = useSWR<RouteData[]>(
    `/api/monitor/routes?date=${date}`,
    safeFetch,
    { refreshInterval: 30000 }
  );
  const { data: trails } = useSWR<TrailData[]>(
    `/api/monitor/driver-trail?date=${date}`,
    safeFetch,
    { refreshInterval: 0 }
  );
  const { data: dwellData } = useSWR<DwellSummary[]>(
    `/api/monitor/dwell-time?date=${date}`,
    safeFetch,
    { refreshInterval: 30000 }
  );

  const driversWithNames = (locations || []).map((loc) => {
    const p = progress?.find((d) => d.driver_id === loc.driver_id);
    return { ...loc, name: p?.name || loc.driver_id };
  });

  const driverLayers = useDriverIconLayer(driversWithNames);
  const trafficLayer = useTrafficLayer(traffic || []);
  const incidentLayer = useIncidentLayer(incident?.impact_cells || []);
  const routeLayers = useRouteLayer(showRoutes ? (routes || []) : [], routeDriverId);
  const { layer: tripsLayer, progress: trailProgress, timeLabel, setCurrentTime, duration, isAllDrivers } = useTripsLayer(
    trails || [],
    trailPlaying,
    trailSpeed,
    routeDriverId
  );

  const totalPkg = progress?.reduce((s, d) => s + d.total_packages, 0) ?? 0;
  const totalDone = progress?.reduce((s, d) => s + d.delivered, 0) ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMapClick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (info: any) => {
      if (info.object && info.layer?.id === "driver-scatter") {
        const obj = info.object;
        const p = progress?.find((d) => d.driver_id === obj.driver_id);
        setSelectedDriver({
          driver_id: obj.driver_id,
          name: obj.name || obj.driver_id,
          lat: obj.lat,
          lng: obj.lng,
          speed: obj.speed,
          delivered: p?.delivered,
          total_packages: p?.total_packages,
        });
        setRouteDriverId(obj.driver_id);
        return;
      }

      if (!info.coordinate) return;
      const [lng, lat] = info.coordinate;
      setPendingClick({ lat, lng });
    },
    [progress]
  );

  const runIncidentSim = useCallback(
    async (coord: { lat: number; lng: number }) => {
      setPendingClick(null);
      setIncidentLoading(true);
      try {
        const res = await fetch(
          `/api/monitor/incident-sim?lat=${coord.lat}&lng=${coord.lng}&k=2`
        );
        const data = await res.json();
        if (data.impact_cells) {
          setIncident(data);
        }
      } catch (err) {
        console.error("Incident sim failed:", err);
      } finally {
        setIncidentLoading(false);
      }
    },
    []
  );

  const hideRoutesForAnim = trailPlaying && isAllDrivers;
  const layers = [
    ...(showTraffic ? [trafficLayer] : []),
    ...(hideRoutesForAnim ? [] : routeLayers),
    ...(tripsLayer ? [tripsLayer] : []),
    ...driverLayers,
    ...(incident ? [incidentLayer] : []),
  ];

  const sidebar = (
    <div className="flex h-full flex-col overflow-y-auto bg-card p-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">現場</h2>
          <Button
            variant={showTraffic ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => setShowTraffic(!showTraffic)}
          >
            <Activity className="h-3 w-3" />
            渋滞
          </Button>
          <Button
            variant={showRoutes ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => setShowRoutes(!showRoutes)}
          >
            <Route className="h-3 w-3" />
            ルート
          </Button>
        </div>
        {showRoutes && routes && routes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <Badge
              variant={routeDriverId === null ? "default" : "outline"}
              className="cursor-pointer text-[10px]"
              onClick={() => setRouteDriverId(null)}
            >
              全員
            </Badge>
            {[...new Map(routes.map((r) => [r.driver_id, r])).values()].map((r) => (
              <Badge
                key={r.driver_id}
                variant={routeDriverId === r.driver_id ? "default" : "outline"}
                className="cursor-pointer text-[10px]"
                style={
                  routeDriverId === r.driver_id
                    ? { backgroundColor: `rgb(${r.color.join(",")})` }
                    : { borderColor: `rgb(${r.color.join(",")})`, color: `rgb(${r.color.join(",")})` }
                }
                onClick={() => setRouteDriverId(routeDriverId === r.driver_id ? null : r.driver_id)}
              >
                {r.name}
              </Badge>
            ))}
          </div>
        )}

        {trails && trails.length > 0 && (
          <Card>
            <CardContent className="space-y-2 p-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setTrailPlaying(!trailPlaying)}
                >
                  {trailPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => { setCurrentTime(0); setTrailPlaying(false); }}
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
                <span className="text-xs font-mono font-medium">{timeLabel || "--:--"}</span>
                <div className="flex-1" />
                <span className="text-[10px] text-muted-foreground">{trailSpeed}x</span>
                <Slider
                  className="w-20"
                  min={10}
                  max={200}
                  step={10}
                  value={[trailSpeed]}
                  onValueChange={([v]) => setTrailSpeed(v)}
                />
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${trailProgress * 100}%` }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        <ProgressBar delivered={totalDone} total={totalPkg} />
        {selectedDriver && (
          <Card className="border-blue-500/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <MapPin className="h-4 w-4 text-blue-500" />
                {selectedDriver.name}
                <Button variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={() => { setSelectedDriver(null); setRouteDriverId(null); }}>
                  <X className="h-3 w-3" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-3 pt-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">ID:</span>
                <span className="font-mono">{selectedDriver.driver_id}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">速度:</span>
                <Badge variant={selectedDriver.speed > 0 ? "default" : "destructive"} className="text-[10px]">
                  {selectedDriver.speed.toFixed(1)} km/h
                </Badge>
              </div>
              {selectedDriver.total_packages !== undefined && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">配達:</span>
                  <span>{selectedDriver.delivered ?? 0} / {selectedDriver.total_packages} 件</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">位置:</span>
                <span className="font-mono text-[10px]">{selectedDriver.lat.toFixed(4)}, {selectedDriver.lng.toFixed(4)}</span>
              </div>
              {routes && (() => {
                const driverRoutes = routes.filter((r) => r.driver_id === selectedDriver.driver_id);
                if (driverRoutes.length <= 1) return null;
                return (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">ラウンド:</span>
                    <span>{driverRoutes.length} 回</span>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        )}
        {selectedDriver && (
          <RouteReadjustPanel
            date={date}
            driverId={selectedDriver.driver_id}
            driverName={selectedDriver.name}
          />
        )}
        {selectedDriver && (
          <NextTripPanel
            date={date}
            driverId={selectedDriver.driver_id}
            driverName={selectedDriver.name}
          />
        )}
        {selectedDriver && (
          <DriverWithdrawPanel
            date={date}
            driverId={selectedDriver.driver_id}
            driverName={selectedDriver.name}
          />
        )}
        <IncidentPanel
          active={!!incident}
          loading={incidentLoading}
          drivers={incident?.affected_drivers || []}
          h3Analysis={incident?.h3_analysis}
          summary={incident?.summary}
          roadContext={incident?.road_context}
          centerH3={incident?.center?.h3_index}
          onClear={() => setIncident(null)}
        />
        {!selectedDriver && (
          <Card className="border-dashed border-muted-foreground/30">
            <CardContent className="p-3 text-center text-xs text-muted-foreground">
              ドライバーを選択するとルート再生成・N便生成・離脱操作が利用できます
            </CardContent>
          </Card>
        )}
        <DriverStatusList
          drivers={progress || []}
          selectedDriverId={selectedDriver?.driver_id}
          onSelectDriver={(d) => {
            const loc = locations?.find((l) => l.driver_id === d.driver_id);
            setSelectedDriver({
              driver_id: d.driver_id,
              name: d.name,
              lat: loc?.lat ?? d.current_lat ?? 0,
              lng: loc?.lng ?? d.current_lng ?? 0,
              speed: loc?.speed ?? d.current_speed ?? 0,
              delivered: d.delivered,
              total_packages: d.total_packages,
            });
            setRouteDriverId(d.driver_id);
          }}
        />
        {dwellData && <DwellPanel data={dwellData} />}
        <AlertPanel alerts={alerts || []} />
      </div>
    </div>
  );

  return (
    <>
      <ResizableSplit
        left={<DeckMap layers={layers} onClick={handleMapClick} />}
        right={sidebar}
      />
      <MapClickDialog
        coordinate={pendingClick}
        onConfirm={runIncidentSim}
        onCancel={() => setPendingClick(null)}
      />
    </>
  );
}
