"use client";

import { useMemo } from "react";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { WeatherForecast } from "@/types";

function precipColor(precip: number): [number, number, number, number] {
  if (precip >= 5) return [0, 50, 255, 160];
  if (precip >= 2) return [30, 100, 255, 130];
  if (precip >= 0.5) return [80, 160, 255, 100];
  return [150, 210, 255, 60];
}

export function useWeatherLayer(data: WeatherForecast[]) {
  return useMemo(
    () =>
      new H3HexagonLayer<WeatherForecast>({
        id: "h3-weather",
        data: data.filter((d) => d.PRECIPITATION > 0),
        getHexagon: (d) => d.H3_INDEX,
        getFillColor: (d) => precipColor(d.PRECIPITATION),
        getElevation: (d) => d.PRECIPITATION * 50,
        extruded: true,
        elevationScale: 1,
        pickable: true,
        opacity: 0.5,
      }),
    [data]
  );
}
