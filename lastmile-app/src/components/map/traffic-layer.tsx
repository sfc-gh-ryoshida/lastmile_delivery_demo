"use client";

import { useMemo } from "react";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { TrafficRealtime } from "@/types";

function congestionColor(level: number): [number, number, number, number] {
  if (level >= 4) return [200, 0, 0, 180];
  if (level >= 3) return [255, 100, 0, 150];
  if (level >= 2) return [255, 200, 0, 120];
  return [0, 180, 0, 80];
}

export function useTrafficLayer(data: TrafficRealtime[]) {
  return useMemo(
    () =>
      new H3HexagonLayer<TrafficRealtime>({
        id: "h3-traffic",
        data,
        getHexagon: (d) => d.h3_index,
        getFillColor: (d) => congestionColor(d.congestion_level),
        extruded: false,
        pickable: true,
        opacity: 0.5,
      }),
    [data]
  );
}
