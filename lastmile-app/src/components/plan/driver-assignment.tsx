"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
import type { Driver } from "@/types";

interface Props {
  drivers: Driver[];
}

function skillBadge(level: number) {
  if (level >= 4) return <Badge className="bg-green-600 text-white text-[10px]">S{level}</Badge>;
  if (level >= 3) return <Badge variant="secondary" className="text-[10px]">S{level}</Badge>;
  return <Badge variant="outline" className="text-[10px]">S{level}</Badge>;
}

export function DriverAssignment({ drivers }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="h-4 w-4" />
          ドライバー配置 ({drivers.length}名)
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-[200px] overflow-y-auto p-3 space-y-1.5">
        {drivers.map((d) => (
          <div
            key={d.driver_id}
            className="flex items-center justify-between rounded border p-2 text-sm"
          >
            <div>
              <span className="font-medium">{d.name}</span>
              <span className="ml-2 text-[10px] text-muted-foreground">
                {d.vehicle_type} / {d.area_assignment || "未設定"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {skillBadge(d.skill_level)}
              <span className="text-xs text-muted-foreground">
                {d.vehicle_capacity}kg
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
