"use client";

import { useState, useCallback, useEffect, useRef, ReactNode } from "react";
import Map from "react-map-gl/mapbox";
import DeckGL from "@deck.gl/react";
import type { Layer } from "@deck.gl/core";
import { Plus, Minus, Navigation } from "lucide-react";
import "mapbox-gl/dist/mapbox-gl.css";

const INITIAL_VIEW_STATE = {
  latitude: parseFloat(process.env.NEXT_PUBLIC_MAP_CENTER_LAT || "35.6495"),
  longitude: parseFloat(process.env.NEXT_PUBLIC_MAP_CENTER_LNG || "139.7914"),
  zoom: parseFloat(process.env.NEXT_PUBLIC_MAP_ZOOM || "13"),
  pitch: 40,
  bearing: 0,
};

interface DeckMapProps {
  layers?: Layer[];
  children?: ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onClick?: (info: any, event: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTooltip?: (info: any) => string | { html: string; style?: Record<string, string> } | null;
}

function checkWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    return !!gl;
  } catch {
    return false;
  }
}

export function DeckMap({ layers = [], children, onClick, getTooltip }: DeckMapProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [webglSupported, setWebglSupported] = useState<boolean | null>(null);
  const suppressClickRef = useRef(false);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  useEffect(() => {
    setWebglSupported(checkWebGL());
  }, []);

  useEffect(() => {
    const wrapper = document.getElementById("deckgl-wrapper");
    if (!wrapper) return;
    const navContainer = document.getElementById("map-nav-controls");
    if (!navContainer) return;

    const handler = (e: PointerEvent | MouseEvent) => {
      if (navContainer.contains(e.target as Node)) {
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 300);
      }
    };

    wrapper.addEventListener("pointerdown", handler, true);
    wrapper.addEventListener("click", handler, true);

    return () => {
      wrapper.removeEventListener("pointerdown", handler, true);
      wrapper.removeEventListener("click", handler, true);
    };
  }, [webglSupported]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleClick = useCallback((info: any, event: any) => {
    if (!onClick) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const srcEvt = (event?.srcEvent || info?.srcEvent) as MouseEvent | undefined;
    if (srcEvt) {
      const navEl = document.getElementById("map-nav-controls");
      if (navEl) {
        const rect = navEl.getBoundingClientRect();
        if (
          srcEvt.clientX >= rect.left &&
          srcEvt.clientX <= rect.right &&
          srcEvt.clientY >= rect.top &&
          srcEvt.clientY <= rect.bottom
        ) {
          return;
        }
      }
      const ctrls = document.querySelectorAll(".mapboxgl-ctrl, .maplibregl-ctrl");
      for (let i = 0; i < ctrls.length; i++) {
        const r = ctrls[i].getBoundingClientRect();
        if (
          srcEvt.clientX >= r.left &&
          srcEvt.clientX <= r.right &&
          srcEvt.clientY >= r.top &&
          srcEvt.clientY <= r.bottom
        ) {
          return;
        }
      }
    }
    onClick(info, event);
  }, [onClick]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onViewStateChange = useCallback(
    ({ viewState: vs }: any) => {
      setViewState(vs);
    },
    []
  );

  const handleZoomIn = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 300);
    setViewState((prev) => ({ ...prev, zoom: Math.min(prev.zoom + 1, 20) }));
  }, []);

  const handleZoomOut = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 300);
    setViewState((prev) => ({ ...prev, zoom: Math.max(prev.zoom - 1, 1) }));
  }, []);

  const handleResetBearing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 300);
    setViewState((prev) => ({ ...prev, bearing: 0, pitch: 0 }));
  }, []);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center bg-muted text-muted-foreground">
        <p className="text-sm">NEXT_PUBLIC_MAPBOX_TOKEN を .env.local に設定してください</p>
      </div>
    );
  }

  if (webglSupported === null) {
    return (
      <div className="flex h-full items-center justify-center bg-muted">
        <p className="text-sm text-muted-foreground">マップ読み込み中...</p>
      </div>
    );
  }

  if (!webglSupported) {
    return (
      <div className="flex h-full items-center justify-center bg-muted text-muted-foreground">
        <p className="text-sm">WebGL がサポートされていません。ブラウザを更新してください。</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <DeckGL
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        layers={layers}
        controller
        onClick={handleClick}
        getTooltip={getTooltip}
        onError={(error) => {
          console.warn("DeckGL error:", error);
        }}
      >
        <Map
          mapboxAccessToken={token}
          mapStyle="mapbox://styles/mapbox/dark-v11"
        />
      </DeckGL>
      <div
        id="map-nav-controls"
        className="pointer-events-none absolute top-2 right-2 z-50 flex flex-col gap-[1px]"
        onPointerDown={(e) => {
          e.stopPropagation();
          suppressClickRef.current = true;
          setTimeout(() => { suppressClickRef.current = false; }, 300);
        }}
      >
        <button
          className="pointer-events-auto flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-t bg-zinc-800/90 text-zinc-200 shadow hover:bg-zinc-700/90"
          onClick={handleZoomIn}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Zoom in"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          className="pointer-events-auto flex h-[30px] w-[30px] cursor-pointer items-center justify-center bg-zinc-800/90 text-zinc-200 shadow hover:bg-zinc-700/90"
          onClick={handleZoomOut}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Zoom out"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          className="pointer-events-auto flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-b bg-zinc-800/90 text-zinc-200 shadow hover:bg-zinc-700/90"
          onClick={handleResetBearing}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Reset bearing to north"
          style={{
            transform: `rotate(${-viewState.bearing}deg)`,
          }}
        >
          <Navigation className="h-3.5 w-3.5 fill-current" />
        </button>
      </div>
      {children}
    </div>
  );
}
