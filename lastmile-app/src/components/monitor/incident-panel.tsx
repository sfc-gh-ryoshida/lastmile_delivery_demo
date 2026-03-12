"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, X, Hexagon, MapPin, Package, ChevronDown, Lightbulb, Truck, TrafficCone, Construction } from "lucide-react";
import { MlBadge } from "@/components/shared/ml-badge";
import { useState } from "react";

interface AffectedDriver {
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
}

interface H3Analysis {
  resolution: number;
  hex_edge_km: number;
  total_impact_cells: number;
  impact_area_km2: number;
  rings: { ring: number; cells: number; radius_m: number }[];
}

interface IncidentSummary {
  total_affected_drivers: number;
  drivers_in_zone: number;
  drivers_with_packages: number;
  total_affected_packages: number;
}

interface RoadContext {
  congested_cells: number;
  construction_cells: number;
  avg_impact_weight: number;
  max_impact_weight: number;
}

interface Props {
  active: boolean;
  loading: boolean;
  drivers: AffectedDriver[];
  h3Analysis?: H3Analysis;
  summary?: IncidentSummary;
  roadContext?: RoadContext;
  centerH3?: string;
  onClear: () => void;
}

function impactBadge(ring: number, inZone?: boolean) {
  if (ring === 0) return <Badge variant="destructive" className="text-[10px]">直撃</Badge>;
  if (ring === 1) return <Badge className="bg-orange-600 text-white text-[10px]">隣接</Badge>;
  if (ring <= 2) return <Badge variant="secondary" className="text-[10px]">近接</Badge>;
  if (inZone === false && ring < 0) return <Badge variant="outline" className="text-[10px]">配達先影響</Badge>;
  return <Badge variant="outline" className="text-[10px]">影響圏</Badge>;
}

function reasonIcons(reasons: string[]) {
  const icons = [];
  if (reasons.includes("driver_at_epicenter") || reasons.includes("driver_adjacent") || reasons.includes("driver_nearby")) {
    icons.push(<Truck key="truck" className="h-3 w-3 text-red-400" />);
  }
  if (reasons.includes("packages_in_zone")) {
    icons.push(<Package key="pkg" className="h-3 w-3 text-orange-400" />);
  }
  return icons;
}

function DriverImpactCard({ driver }: { driver: AffectedDriver }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!driver.impact_detail;

  return (
    <div
      className={`cursor-pointer rounded-md border p-2.5 text-sm transition-colors ${
        driver.distance_ring === 0
          ? "bg-red-500/10 border-red-500/30"
          : driver.distance_ring === 1
            ? "bg-orange-500/10 border-orange-500/30"
            : "bg-yellow-500/10 border-yellow-500/30"
      }`}
      onClick={() => hasDetail && setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {driver.impact_reasons && reasonIcons(driver.impact_reasons)}
          <span className="font-medium text-xs">{driver.name}</span>
          {impactBadge(driver.distance_ring, driver.driver_in_zone)}
        </div>
        <div className="flex items-center gap-1.5">
          {driver.packages_in_zone !== undefined && driver.packages_in_zone > 0 && (
            <span className="text-[10px] text-muted-foreground">{driver.packages_in_zone}件影響</span>
          )}
          {driver.route_blocked_pct !== undefined && driver.route_blocked_pct > 0 && (
            <Badge variant="outline" className="text-[10px] font-mono">{driver.route_blocked_pct}%</Badge>
          )}
          {hasDetail && (
            <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          )}
        </div>
      </div>

      {driver.driver_h3 && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <Hexagon className="h-2.5 w-2.5" />
          <span className="font-mono">{driver.driver_h3.slice(-7)}</span>
          {driver.distance_ring >= 0 && (
            <span>（事故から{driver.distance_ring}リング ≈ {(driver.distance_ring * 174)}m）</span>
          )}
        </div>
      )}

      {expanded && driver.impact_detail && (
        <div className="mt-2 space-y-2">
          <p className="text-xs leading-relaxed text-foreground/80">{driver.impact_detail}</p>

          {driver.recommended_action && (
            <div className="rounded border border-dashed border-foreground/20 bg-background/50 p-2">
              <div className="flex items-start gap-1.5">
                <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <div>
                  <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">推奨アクション</p>
                  <p className="mt-0.5 text-xs leading-relaxed">{driver.recommended_action}</p>
                </div>
              </div>
            </div>
          )}

          {driver.total_packages !== undefined && (
            <div className="flex gap-3 text-[10px] text-muted-foreground">
              <span>担当: <span className="font-mono">{driver.total_packages}</span>件</span>
              <span>配達済: <span className="font-mono">{driver.delivered}</span>件</span>
              <span>残: <span className="font-mono">{driver.remaining}</span>件</span>
              <span>影響圏内: <span className="font-mono font-bold">{driver.packages_in_zone}</span>件</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function IncidentPanel({ active, loading, drivers, h3Analysis, summary, roadContext, centerH3, onClear }: Props) {
  if (!active) {
    return (
      <Card className="border-dashed border-yellow-500/30">
        <CardContent className="p-3">
          <p className="text-xs text-muted-foreground text-center">
            地図上をクリックで事故シミュレーション
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-yellow-500/50">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          事故影響シミュレーション
          <MlBadge model="H3空間インデックス" />
          <Button variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={onClear}>
            <X className="h-3 w-3" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-3">
        {loading && <p className="text-xs text-muted-foreground">H3メッシュで影響範囲を計算中...</p>}

        {!loading && h3Analysis && (
          <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 p-2.5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Hexagon className="h-3.5 w-3.5 text-cyan-500" />
              <span className="text-[10px] font-semibold text-cyan-600 dark:text-cyan-400">H3空間解析</span>
            </div>
            {centerH3 && (
              <p className="text-[10px] text-muted-foreground mb-1">
                <MapPin className="inline h-2.5 w-2.5 mr-0.5" />
                事故地点セル: <span className="font-mono">{centerH3.slice(-7)}</span>
                （解像度{h3Analysis.resolution} / 辺長{(h3Analysis.hex_edge_km * 1000).toFixed(0)}m）
              </p>
            )}
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded bg-background/50 p-1.5">
                <p className="text-sm font-bold">{h3Analysis.total_impact_cells}</p>
                <p className="text-[9px] text-muted-foreground">影響セル数</p>
              </div>
              <div className="rounded bg-background/50 p-1.5">
                <p className="text-sm font-bold">{h3Analysis.impact_area_km2}</p>
                <p className="text-[9px] text-muted-foreground">影響面積 km²</p>
              </div>
              <div className="rounded bg-background/50 p-1.5">
                <p className="text-sm font-bold">{summary?.total_affected_packages ?? 0}</p>
                <p className="text-[9px] text-muted-foreground">影響荷物数</p>
              </div>
            </div>
            <div className="mt-1.5 flex gap-1">
              {h3Analysis.rings.map((r) => (
                <div key={r.ring} className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
                  <div className={`h-2 w-2 rounded-sm ${
                    r.ring === 0 ? "bg-red-500" : r.ring === 1 ? "bg-orange-500" : "bg-yellow-500"
                  }`} />
                  <span>{r.ring === 0 ? "中心" : `${r.ring}リング`}</span>
                  <span className="font-mono">({r.cells})</span>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[9px] text-muted-foreground leading-relaxed">
              H3六角形メッシュにより、ドライバー位置と配達先を同一セル体系で空間マッチング。
              リング距離で影響度を定量化し、セル単位で迂回判定を高速実行。
            </p>
          </div>
        )}

        {!loading && roadContext && (roadContext.congested_cells > 0 || roadContext.construction_cells > 0) && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <TrafficCone className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">道路状況による影響加重</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 text-center">
              <div className="rounded bg-background/50 p-1.5">
                <p className="text-sm font-bold">{roadContext.congested_cells}</p>
                <p className="text-[9px] text-muted-foreground">渋滞セル</p>
              </div>
              <div className="rounded bg-background/50 p-1.5">
                <p className="text-sm font-bold">{roadContext.construction_cells}</p>
                <p className="text-[9px] text-muted-foreground">工事規制セル</p>
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-[9px] text-muted-foreground">
              <span>平均重み: <span className="font-mono font-bold">{roadContext.avg_impact_weight}</span></span>
              <span>最大重み: <span className="font-mono font-bold">{roadContext.max_impact_weight}</span></span>
            </div>
            <p className="mt-1 text-[9px] text-muted-foreground leading-relaxed">
              渋滞度（congestion_level）・通行速度比・工事規制をセル単位で加重。
              主要道路の交通集中セルでは影響が増幅されます。
            </p>
          </div>
        )}

        {!loading && summary && (
          <div className="flex gap-2 text-[10px]">
            {summary.drivers_in_zone > 0 && (
              <div className="flex items-center gap-1">
                <Truck className="h-3 w-3 text-red-400" />
                <span>影響圏内ドライバー: <span className="font-bold">{summary.drivers_in_zone}</span>名</span>
              </div>
            )}
            {summary.drivers_with_packages > 0 && (
              <div className="flex items-center gap-1">
                <Package className="h-3 w-3 text-orange-400" />
                <span>配達先影響: <span className="font-bold">{summary.drivers_with_packages}</span>名</span>
              </div>
            )}
          </div>
        )}

        {!loading && drivers.length === 0 && (
          <p className="text-xs text-muted-foreground">影響範囲内にドライバー・荷物なし</p>
        )}

        {!loading && (
          <p className="text-[10px] text-muted-foreground">クリックで影響理由・推奨アクションを表示</p>
        )}

        {drivers.map((d) => (
          <DriverImpactCard key={d.driver_id} driver={d} />
        ))}
      </CardContent>
    </Card>
  );
}
