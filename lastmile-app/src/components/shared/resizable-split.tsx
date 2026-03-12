"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

interface ResizableSplitProps {
  left: ReactNode;
  right: ReactNode;
  defaultRightWidth?: number;
  minRightWidth?: number;
  maxRightWidth?: number;
}

export function ResizableSplit({
  left,
  right,
  defaultRightWidth = 420,
  minRightWidth = 320,
  maxRightWidth = 700,
}: ResizableSplitProps) {
  const [rightWidth, setRightWidth] = useState(defaultRightWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = rightWidth;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [rightWidth]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - e.clientX;
      const next = Math.max(minRightWidth, Math.min(maxRightWidth, startWidth.current + delta));
      setRightWidth(next);
    },
    [minRightWidth, maxRightWidth]
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1">{left}</div>
      <div
        className="group relative z-10 flex w-1.5 cursor-col-resize items-center justify-center bg-border/50 transition-colors hover:bg-primary/30 active:bg-primary/50"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="h-8 w-0.5 rounded-full bg-muted-foreground/30 transition-colors group-hover:bg-primary/60" />
      </div>
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: rightWidth, minWidth: minRightWidth, maxWidth: maxRightWidth }}
      >
        {right}
      </div>
    </div>
  );
}
