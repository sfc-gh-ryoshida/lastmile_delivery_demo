"use client";

import dynamic from "next/dynamic";
import type { Layer } from "@deck.gl/core";
import type { ReactNode } from "react";

const DeckMapInner = dynamic(
  () => import("@/components/map/deck-map").then((mod) => mod.DeckMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-muted">
        <p className="text-sm text-muted-foreground">マップ読み込み中...</p>
      </div>
    ),
  }
);

interface DeckMapLazyProps {
  layers?: Layer[];
  children?: ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onClick?: (info: any, event: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTooltip?: (info: any) => string | { html: string; style?: Record<string, string> } | null;
}

export function DeckMapLazy({ layers = [], children, onClick, getTooltip }: DeckMapLazyProps) {
  return (
    <DeckMapInner layers={layers} onClick={onClick} getTooltip={getTooltip}>
      {children}
    </DeckMapInner>
  );
}
