"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Info, ShieldAlert, Lightbulb, ChevronDown } from "lucide-react";
import { MlBadge } from "@/components/shared/ml-badge";
import { useState } from "react";
import type { AnomalyAlert } from "@/types";

interface Props {
  alerts: AnomalyAlert[];
}

const severityConfig = {
  critical: {
    icon: ShieldAlert,
    color: "text-red-500",
    bg: "bg-red-500/10 border-red-500/30",
    badge: "destructive" as const,
    label: "緊急",
  },
  warning: {
    icon: AlertTriangle,
    color: "text-orange-500",
    bg: "bg-orange-500/10 border-orange-500/30",
    badge: "secondary" as const,
    label: "注意",
  },
  info: {
    icon: Info,
    color: "text-blue-500",
    bg: "bg-blue-500/10 border-blue-500/30",
    badge: "outline" as const,
    label: "情報",
  },
};

function AlertItem({ alert }: { alert: AnomalyAlert }) {
  const [expanded, setExpanded] = useState(false);
  const config = severityConfig[alert.SEVERITY] || severityConfig.warning;
  const Icon = config.icon;

  return (
    <div
      className={`cursor-pointer rounded-md border p-2.5 text-sm transition-colors ${config.bg}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${config.color}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant={config.badge} className="text-[10px] px-1.5 py-0">
              {config.label}
            </Badge>
            <span className="font-medium text-xs">{alert.ALERT_TYPE}</span>
            <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{alert.HOUR}時</span>
            <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          </div>
          <p className="mt-1 text-xs font-medium">{alert.DRIVER_NAME}</p>
          <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
            {alert.DESCRIPTION}
          </p>
          {expanded && (
            <div className="mt-2 rounded border border-dashed border-foreground/20 bg-background/50 p-2">
              <div className="flex items-start gap-1.5">
                <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <div>
                  <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">推奨アクション</p>
                  <p className="mt-0.5 text-xs leading-relaxed">{alert.RECOMMENDED_ACTION}</p>
                </div>
              </div>
              <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
                <span>異常スコア: <span className="font-mono">{alert.ANOMALY_SCORE.toFixed(2)}</span></span>
                <span>想定: <span className="font-mono">{alert.EXPECTED_PACE.toFixed(1)}</span>件/時</span>
                <span>実績: <span className="font-mono">{alert.ACTUAL_PACE.toFixed(1)}</span>件/時</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AlertPanel({ alerts }: Props) {
  const criticalCount = alerts.filter((a) => a.SEVERITY === "critical").length;
  const warningCount = alerts.filter((a) => a.SEVERITY === "warning").length;

  if (alerts.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4" />
            アラート
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">異常なし</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className={`h-4 w-4 ${criticalCount > 0 ? "text-red-500" : "text-orange-500"}`} />
          アラート
          <MlBadge model="リアルタイム異常検知" />
          <div className="ml-auto flex gap-1">
            {criticalCount > 0 && (
              <Badge variant="destructive" className="text-[10px]">{criticalCount} 緊急</Badge>
            )}
            {warningCount > 0 && (
              <Badge variant="secondary" className="text-[10px]">{warningCount} 注意</Badge>
            )}
          </div>
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">クリックで詳細・推奨アクションを表示</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {alerts.map((a) => (
          <AlertItem key={a.ALERT_ID} alert={a} />
        ))}
      </CardContent>
    </Card>
  );
}
