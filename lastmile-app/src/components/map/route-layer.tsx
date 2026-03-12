"use client";

import { useMemo } from "react";
import { PathLayer, TextLayer } from "@deck.gl/layers";
import { PathStyleExtension } from "@deck.gl/extensions";

interface StopPoint {
  lng: number;
  lat: number;
  stopOrder: number;
  color: [number, number, number];
  driverId: string;
  trip?: number;
}

interface TripRoute {
  driver_id: string;
  trip: number;
  color: [number, number, number];
  path: [number, number][];
  stops: StopPoint[];
}

interface RouteData {
  driver_id: string;
  name: string;
  color: [number, number, number];
  path: [number, number][];
  delivered: number;
  total: number;
  round?: number;
  latest_completed_at?: string | null;
  stops?: StopPoint[];
  tripRoutes?: TripRoute[];
}

const dashExt = new PathStyleExtension({ dash: true });

export function useRouteLayer(
  data: RouteData[],
  selectedDriverId?: string | null,
  selectedTrip?: number | null
) {
  return useMemo(() => {
    const filtered = selectedDriverId
      ? data.filter((d) => d.driver_id === selectedDriverId)
      : data;

    const now = Date.now();
    const timestamps = filtered
      .map((d) => (d.latest_completed_at ? new Date(d.latest_completed_at).getTime() : 0))
      .filter((t) => t > 0);
    const minTs = timestamps.length > 0 ? Math.min(...timestamps) : now;
    const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : now;
    const range = maxTs - minTs || 1;

    const layers: (PathLayer | TextLayer)[] = [];

    const hasTripRoutes = filtered.some((d) => d.tripRoutes && d.tripRoutes.length > 0);

    if (hasTripRoutes && selectedDriverId) {
      const allTripRoutes = filtered.flatMap((d) => d.tripRoutes ?? []);
      const tripFiltered = selectedTrip
        ? allTripRoutes.filter((t) => t.trip === selectedTrip)
        : allTripRoutes;

      layers.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new PathLayer<TripRoute>({
          id: "trip-routes",
          data: tripFiltered,
          getPath: (d: TripRoute) => d.path,
          getColor: (d: TripRoute) => {
            const alpha = selectedTrip != null && d.trip !== selectedTrip ? 80 : 220;
            return [...d.color, alpha] as [number, number, number, number];
          },
          getWidth: (d: TripRoute) => (selectedTrip === d.trip || !selectedTrip ? 5 : 3),
          widthMinPixels: 2,
          widthMaxPixels: 10,
          pickable: true,
          jointRounded: true,
          capRounded: true,
          getDashArray: (d: TripRoute) => (d.trip === 1 ? [0, 0] : [8, 4]),
          dashJustified: true,
          extensions: [dashExt],
          updateTriggers: {
            getColor: [selectedTrip],
            getWidth: [selectedTrip],
            getDashArray: [],
          },
        } as any)
      );

      const tripStops = tripFiltered.flatMap((t) => t.stops);
      layers.push(
        new TextLayer<StopPoint>({
          id: "route-stop-numbers",
          data: tripStops,
          getPosition: (d) => [d.lng, d.lat],
          getText: (d) => String(d.stopOrder),
          getSize: 14,
          getColor: [255, 255, 255, 240],
          getTextAnchor: "middle" as const,
          getAlignmentBaseline: "center" as const,
          fontFamily: "monospace",
          fontWeight: 700,
          outlineColor: [0, 0, 0, 200],
          outlineWidth: 3,
          sizeScale: 1,
          billboard: true,
          updateTriggers: { getData: [selectedTrip, selectedDriverId] },
        })
      );
    } else {
      layers.push(
        new PathLayer<RouteData>({
          id: "delivery-routes",
          data: filtered,
          getPath: (d) => d.path,
          getColor: (d) => {
            const ts = d.latest_completed_at ? new Date(d.latest_completed_at).getTime() : maxTs;
            const recency = (ts - minTs) / range;
            const alpha = Math.round(60 + recency * 195);
            return [...d.color, alpha] as [number, number, number, number];
          },
          getWidth: () => (selectedDriverId ? 5 : 3),
          widthMinPixels: selectedDriverId ? 3 : 2,
          widthMaxPixels: selectedDriverId ? 10 : 6,
          pickable: true,
          jointRounded: true,
          capRounded: true,
          updateTriggers: {
            getColor: [selectedDriverId, data.length],
            getWidth: [selectedDriverId],
          },
        })
      );

      const allStops = filtered.flatMap((d) => d.stops ?? []);
      layers.push(
        new TextLayer<StopPoint>({
          id: "route-stop-numbers",
          data: allStops,
          getPosition: (d) => [d.lng, d.lat],
          getText: (d) => String(d.stopOrder),
          getSize: 14,
          getColor: [255, 255, 255, 240],
          getTextAnchor: "middle" as const,
          getAlignmentBaseline: "center" as const,
          fontFamily: "monospace",
          fontWeight: 700,
          outlineColor: [0, 0, 0, 200],
          outlineWidth: 3,
          sizeScale: 1,
          billboard: true,
          updateTriggers: { getData: [data, selectedDriverId] },
        })
      );
    }

    return layers;
  }, [data, selectedDriverId, selectedTrip]);
}
