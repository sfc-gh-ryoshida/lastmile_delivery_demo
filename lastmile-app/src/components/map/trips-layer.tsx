"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { TripsLayer } from "@deck.gl/geo-layers";

const DRIVER_COLORS: [number, number, number][] = [
  [59, 130, 246],
  [34, 197, 94],
  [249, 115, 22],
  [168, 85, 247],
  [236, 72, 153],
  [20, 184, 166],
  [234, 179, 8],
  [239, 68, 68],
  [99, 102, 241],
  [6, 182, 212],
  [132, 204, 22],
  [244, 63, 94],
];

export interface TrailData {
  driver_id: string;
  path: [number, number, number][];
  timestamps: number[];
}

interface TripFeature {
  driver_id: string;
  path: [number, number, number][];
  timestamps: number[];
  color: [number, number, number];
}

export function useTripsLayer(
  data: TrailData[],
  playing: boolean,
  speed: number,
  selectedDriverId?: string | null
): { layer: TripsLayer<TripFeature> | null; progress: number; timeLabel: string; setCurrentTime: (t: number | ((p: number) => number)) => void; duration: number; isAllDrivers: boolean } {
  const [currentTime, setCurrentTime] = useState(0);
  const animFrameRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);

  const { features, minTs, maxTs } = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    const colorMap = new Map<string, number>();
    let ci = 0;

    const feats: TripFeature[] = [];
    for (const d of data) {
      if (selectedDriverId && d.driver_id !== selectedDriverId) continue;
      if (d.timestamps.length < 2) continue;
      const tMin = d.timestamps[0];
      const tMax = d.timestamps[d.timestamps.length - 1];
      if (tMin < mn) mn = tMin;
      if (tMax > mx) mx = tMax;
      if (!colorMap.has(d.driver_id)) colorMap.set(d.driver_id, ci++);
      feats.push({
        driver_id: d.driver_id,
        path: d.path,
        timestamps: d.timestamps,
        color: DRIVER_COLORS[colorMap.get(d.driver_id)! % DRIVER_COLORS.length],
      });
    }
    return { features: feats, minTs: mn === Infinity ? 0 : mn, maxTs: mx === -Infinity ? 0 : mx };
  }, [data, selectedDriverId]);

  useEffect(() => {
    if (!playing || maxTs <= minTs) return;
    const duration = maxTs - minTs;

    const animate = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setCurrentTime((prev) => {
        const next = prev + dt * speed;
        return next > duration ? 0 : next;
      });
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      lastTsRef.current = 0;
    };
  }, [playing, speed, minTs, maxTs]);

  const layer = useMemo(() => {
    if (features.length === 0) return null;
    const allDrivers = !selectedDriverId;
    return new TripsLayer<TripFeature>({
      id: "driver-trips",
      data: features,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: (d) => d.color,
      currentTime: minTs + currentTime,
      trailLength: allDrivers ? 60 : 120,
      widthMinPixels: allDrivers ? 2 : 4,
      opacity: allDrivers ? 0.6 : 0.85,
      jointRounded: true,
      capRounded: true,
    });
  }, [features, currentTime, minTs]);

  const progress = maxTs > minTs ? currentTime / (maxTs - minTs) : 0;
  const timeLabel = maxTs > minTs
    ? new Date((minTs + currentTime) * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    : "";

  return { layer, progress, timeLabel, setCurrentTime, duration: maxTs - minTs, isAllDrivers: !selectedDriverId };
}
