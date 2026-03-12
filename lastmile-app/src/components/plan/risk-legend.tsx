"use client";

const LEVELS = [
  { label: "遅配率 ≥30%", color: "rgb(255, 0, 0)" },
  { label: "遅配率 20–30%", color: "rgb(255, 140, 0)" },
  { label: "遅配率 10–20%", color: "rgb(255, 215, 0)" },
  { label: "遅配率 <10%", color: "transparent", note: "非表示" },
] as const;

export function RiskLegend() {
  return (
    <div className="rounded-lg bg-zinc-900/90 p-2.5 text-[10px] shadow-lg backdrop-blur">
      <p className="mb-1.5 font-semibold text-zinc-300">遅配リスク（予測遅配率）</p>
      <div className="flex flex-col gap-1">
        {LEVELS.map((l) => (
          <div key={l.label} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm border border-zinc-600"
              style={{ backgroundColor: l.color, opacity: 0.8 }}
            />
            <span className="text-zinc-300">{l.label}</span>
            {"note" in l && (
              <span className="text-zinc-500">({l.note})</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
