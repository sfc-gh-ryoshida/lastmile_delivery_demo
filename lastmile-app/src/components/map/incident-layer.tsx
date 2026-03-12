"use client";

import { useMemo } from "react";
import { H3HexagonLayer } from "@deck.gl/geo-layers";

interface ImpactCell {
  h3_index: string;
  ring: number;
  impact_weight?: number;
  congestion_level?: number | null;
  has_construction?: boolean;
}

function cellColor(cell: ImpactCell): [number, number, number, number] {
  const w = cell.impact_weight ?? 1.0;

  if (cell.ring === 0) return [255, 0, 0, 210];

  if (w >= 1.8) return [255, 20, 20, 190];
  if (w >= 1.4) return [255, 60, 0, 170];
  if (w >= 1.1) return [255, 120, 0, 140];
  return [255, 180, 50, 90];
}

export function useIncidentLayer(data: ImpactCell[]) {
  return useMemo(
    () =>
      new H3HexagonLayer<ImpactCell>({
        id: "h3-incident",
        data,
        getHexagon: (d) => d.h3_index,
        getFillColor: (d) => cellColor(d),
        getElevation: (d) => {
          const w = d.impact_weight ?? 1.0;
          const ringBase = (3 - d.ring) * 80;
          return ringBase * w;
        },
        extruded: true,
        elevationScale: 1,
        pickable: true,
        opacity: 0.6,
        updateTriggers: {
          getFillColor: [data],
          getElevation: [data],
        },
      }),
    [data]
  );
}
