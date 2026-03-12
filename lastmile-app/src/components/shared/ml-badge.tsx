"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { BrainCircuit } from "lucide-react";

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "Cortex ML 予測": "Snowflake Cortex ML の時系列予測モデル。過去の配送実績データから需要を予測します。",
  "XGBoost 不在予測": "XGBoost による不在確率予測。曜日・時間帯・地域の過去傾向から不在リスクを推定します。",
  "リスクスコア": "天候・交通・工事情報を組み合わせた複合リスクスコア。配送遅延リスクを0-1で算出します。",
  "異常検知": "ドライバーの配達ペースを監視し、通常パターンから逸脱した場合にアラートを生成します。",
};

interface Props {
  model: string;
  className?: string;
}

export function MlBadge({ model, className }: Props) {
  const desc = MODEL_DESCRIPTIONS[model];
  const badge = (
    <Badge variant="outline" className={`gap-1 border-violet-500/40 text-violet-400 text-[10px] cursor-help ${className ?? ""}`}>
      <BrainCircuit className="h-3 w-3" />
      {model}
    </Badge>
  );

  if (!desc) return badge;

  return (
    <Tooltip>
      <TooltipTrigger>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-[260px]">{desc}</TooltipContent>
    </Tooltip>
  );
}
