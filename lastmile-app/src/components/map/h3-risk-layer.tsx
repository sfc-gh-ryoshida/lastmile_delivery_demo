"use client";

import { useMemo } from "react";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { RiskScore } from "@/types";

function riskColor(score: number): [number, number, number, number] {
  if (score >= 0.3) return [255, 0, 0, 170];
  if (score >= 0.2) return [255, 140, 0, 150];
  if (score >= 0.1) return [255, 215, 0, 130];
  return [0, 0, 0, 0];
}

export function useH3RiskLayer(data: RiskScore[]) {
  return useMemo(
    () =>
      new H3HexagonLayer<RiskScore>({
        id: "h3-risk",
        data: data.filter((d) => d.RISK_SCORE >= 0.1),
        getHexagon: (d) => d.H3_INDEX,
        getFillColor: (d) => riskColor(d.RISK_SCORE),
        getElevation: (d) => d.RISK_SCORE * 300,
        extruded: true,
        elevationScale: 1,
        pickable: true,
        opacity: 0.7,
      }),
    [data]
  );
}

export function useH3AbsenceLayer(data: { H3_INDEX: string; ABSENCE_RATE: number }[]) {
  return useMemo(
    () =>
      new H3HexagonLayer({
        id: "h3-absence",
        data,
        getHexagon: (d) => d.H3_INDEX,
        getFillColor: (d) => {
          const r = d.ABSENCE_RATE;
          if (r >= 0.5) return [255, 0, 0, 160] as [number, number, number, number];
          if (r >= 0.3) return [255, 140, 0, 140] as [number, number, number, number];
          return [255, 215, 0, 100] as [number, number, number, number];
        },
        extruded: true,
        getElevation: (d) => d.ABSENCE_RATE * 300,
        elevationScale: 1,
        pickable: true,
        opacity: 0.6,
      }),
    [data]
  );
}
