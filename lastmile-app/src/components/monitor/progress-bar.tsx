"use client";

import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Package, CheckCircle2 } from "lucide-react";

interface ProgressBarProps {
  delivered: number;
  total: number;
}

export function ProgressBar({ delivered, total }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((delivered / total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Package className="h-4 w-4" />
          全体進捗
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-bold">{pct}%</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3 w-3" />
            {delivered} / {total}
          </span>
        </div>
        <Progress value={pct} className="h-2" />
      </CardContent>
    </Card>
  );
}
