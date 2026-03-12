"use client";

import { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Construction } from "lucide-react";
import type { RoadConstruction } from "@/types";

interface Props {
  data: RoadConstruction[];
  highlightedId?: number | null;
  onClearHighlight?: () => void;
}

export function ConstructionList({ data, highlightedId, onClearHighlight }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (highlightedId != null) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onClearHighlight?.(), 5000);
    }
    return () => clearTimeout(timerRef.current);
  }, [highlightedId, onClearHighlight]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Construction className="h-4 w-4 text-yellow-500" />
          工事情報
          {data.length > 0 && (
            <Badge variant="secondary" className="ml-auto">{data.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-1.5">
        {data.length === 0 && (
          <p className="text-xs text-muted-foreground">工事情報なし</p>
        )}
        {data.map((c) => {
          const isHighlighted = highlightedId === c.construction_id;
          return (
            <div
              key={c.construction_id}
              id={`construction-${c.construction_id}`}
              className={`rounded border p-2 text-sm transition-all duration-300 ${
                isHighlighted
                  ? "border-yellow-400 bg-yellow-500/20 ring-1 ring-yellow-400/60"
                  : "border-yellow-600/30 bg-yellow-600/5"
              }`}
            >
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="text-[10px]">
                  {c.restriction_type}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  R{c.radius_m}m
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{c.description}</p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
