"use client";

import { useState, useMemo, useCallback } from "react";
import { DeckMapLazy as DeckMap } from "@/components/map/deck-map-lazy";
import { useH3AbsenceLayer } from "@/components/map/h3-risk-layer";
import { Badge } from "@/components/ui/badge";
import type { AbsencePattern } from "@/types";

interface Props {
  data: AbsencePattern[];
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const HOUR_OPTIONS = [
  { value: -1, label: "全時間" },
  { value: 10, label: "10時" },
  { value: 11, label: "11時" },
  { value: 14, label: "14時" },
  { value: 15, label: "15時" },
  { value: 17, label: "17時" },
];

export function AbsenceHeatmap({ data }: Props) {
  const [dow, setDow] = useState(-1);
  const [hour, setHour] = useState(-1);

  const filtered = useMemo(() => {
    let result = data;
    if (dow >= 0) result = result.filter((d) => d.DAY_OF_WEEK === dow);
    if (hour >= 0) result = result.filter((d) => d.HOUR === hour);
    return result;
  }, [data, dow, hour]);

  const layer = useH3AbsenceLayer(filtered);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getTooltip = useCallback((info: any) => {
    if (!info.object) return null;
    const d = info.object as AbsencePattern;
    if (d.ABSENCE_RATE == null) return null;
    return {
      html: `
        <div style="font-size:12px;line-height:1.6;min-width:140px">
          <div style="font-weight:600;margin-bottom:4px">不在率: ${(d.ABSENCE_RATE * 100).toFixed(1)}%</div>
          <div style="display:flex;justify-content:space-between"><span>曜日</span><span>${DOW_LABELS[d.DAY_OF_WEEK] ?? "–"}</span></div>
          <div style="display:flex;justify-content:space-between"><span>時間帯</span><span>${d.HOUR}時</span></div>
          <div style="display:flex;justify-content:space-between"><span>サンプル数</span><span>${d.SAMPLE_COUNT}件</span></div>
        </div>`,
      style: {
        backgroundColor: "rgba(24,24,27,0.95)",
        color: "#e4e4e7",
        borderRadius: "8px",
        padding: "8px 12px",
        border: "1px solid rgba(255,255,255,0.1)",
      },
    };
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">曜日:</span>
        <Badge
          variant={dow === -1 ? "default" : "outline"}
          className="cursor-pointer text-[10px]"
          onClick={() => setDow(-1)}
        >
          全て
        </Badge>
        {DOW_LABELS.map((label, i) => (
          <Badge
            key={i}
            variant={dow === i ? "default" : "outline"}
            className="cursor-pointer text-[10px]"
            onClick={() => setDow(i)}
          >
            {label}
          </Badge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">時間:</span>
        {HOUR_OPTIONS.map((opt) => (
          <Badge
            key={opt.value}
            variant={hour === opt.value ? "default" : "outline"}
            className="cursor-pointer text-[10px]"
            onClick={() => setHour(opt.value)}
          >
            {opt.label}
          </Badge>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {filtered.length} セル
        </span>
      </div>
      <div className="h-[350px] overflow-hidden rounded-md border">
        <DeckMap layers={[layer]} getTooltip={getTooltip} />
      </div>
    </div>
  );
}
