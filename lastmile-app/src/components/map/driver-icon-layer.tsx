"use client";

import { useMemo } from "react";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { DriverLocation } from "@/types";

interface DriverLocationWithName extends DriverLocation {
  name?: string;
}

function statusColor(speed: number): [number, number, number] {
  if (speed <= 0) return [255, 60, 60];
  if (speed < 10) return [255, 200, 0];
  return [0, 200, 120];
}

export function useDriverIconLayer(data: DriverLocationWithName[]) {
  const scatter = useMemo(
    () =>
      new ScatterplotLayer<DriverLocationWithName>({
        id: "driver-scatter",
        data,
        getPosition: (d) => [d.lng, d.lat],
        getFillColor: (d) => statusColor(d.speed),
        getRadius: 40,
        radiusMinPixels: 6,
        radiusMaxPixels: 20,
        pickable: true,
        opacity: 0.9,
      }),
    [data]
  );

  const labels = useMemo(
    () =>
      new TextLayer<DriverLocationWithName>({
        id: "driver-labels",
        data,
        getPosition: (d) => [d.lng, d.lat],
        getText: (d) => d.name || d.driver_id,
        getSize: 12,
        getColor: [255, 255, 255, 220],
        getAngle: 0,
        getTextAnchor: "middle" as const,
        getAlignmentBaseline: "bottom" as const,
        getPixelOffset: [0, -16],
        fontFamily: "Noto Sans JP, sans-serif",
      }),
    [data]
  );

  return [scatter, labels];
}
