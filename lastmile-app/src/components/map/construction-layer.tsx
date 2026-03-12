"use client";

import { useMemo } from "react";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { RoadConstruction } from "@/types";

export function useConstructionLayer(data: RoadConstruction[]) {
  const hexLayer = useMemo(
    () =>
      new H3HexagonLayer<RoadConstruction>({
        id: "h3-construction",
        data,
        getHexagon: (d) => d.h3_index,
        getFillColor: [255, 193, 7, 120],
        getElevation: 50,
        extruded: true,
        elevationScale: 1,
        pickable: true,
        opacity: 0.6,
        getLineColor: [255, 193, 7, 200],
        lineWidthMinPixels: 1,
      }),
    [data]
  );

  const pointLayer = useMemo(
    () =>
      new ScatterplotLayer<RoadConstruction>({
        id: "construction-points",
        data,
        getPosition: (d) => [d.center_lng, d.center_lat],
        getRadius: (d) => d.radius_m,
        getFillColor: [255, 152, 0, 160],
        getLineColor: [255, 87, 34, 220],
        lineWidthMinPixels: 2,
        stroked: true,
        pickable: true,
        radiusMinPixels: 6,
        radiusMaxPixels: 60,
        radiusScale: 1,
      }),
    [data]
  );

  const labelLayer = useMemo(
    () =>
      new TextLayer<RoadConstruction>({
        id: "construction-labels",
        data,
        getPosition: (d) => [d.center_lng, d.center_lat],
        getText: (d) => `🚧 ${d.restriction_type === "road_closure" ? "通行止" : "車線規制"}`,
        getSize: 13,
        getColor: [255, 255, 255, 230],
        getAngle: 0,
        getTextAnchor: "middle" as const,
        getAlignmentBaseline: "bottom" as const,
        getPixelOffset: [0, -20],
        fontFamily: "Noto Sans JP, sans-serif",
        fontWeight: 700,
        outlineColor: [0, 0, 0, 180],
        outlineWidth: 2,
      }),
    [data]
  );

  return [hexLayer, pointLayer, labelLayer];
}
