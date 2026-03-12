"use client";

import { useMemo } from "react";
import { H3HexagonLayer } from "@deck.gl/geo-layers";

export interface BuildingDensity {
  H3_INDEX: string;
  APARTMENT_COUNT: number;
  AVG_FLOORS: number;
  HAS_BOX_PCT: number;
  TOTAL_DELIVERIES: number;
  ABSENT_COUNT: number;
  LATE_RATE: number;
}

function densityColor(d: BuildingDensity): [number, number, number, number] {
  const score = d.APARTMENT_COUNT * (1 + d.LATE_RATE);
  if (score >= 8) return [168, 85, 247, 160];
  if (score >= 4) return [168, 85, 247, 120];
  if (score >= 2) return [168, 85, 247, 80];
  return [168, 85, 247, 50];
}

export function useBuildingDensityLayer(data: BuildingDensity[]) {
  return useMemo(
    () =>
      new H3HexagonLayer<BuildingDensity>({
        id: "h3-building-density",
        data,
        getHexagon: (d) => d.H3_INDEX,
        getFillColor: (d) => densityColor(d),
        getElevation: (d) => d.APARTMENT_COUNT * 40 + d.LATE_RATE * 200,
        extruded: true,
        elevationScale: 1,
        pickable: true,
        opacity: 0.6,
      }),
    [data]
  );
}
