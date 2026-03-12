"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Package, Search } from "lucide-react";

export interface PkgRow {
  package_id: string;
  address: string;
  time_window: string | null;
  weight: number;
  is_redelivery: boolean;
  driver_name: string | null;
  status: string | null;
}

interface Props {
  data: PkgRow[];
}

function statusBadge(status: string | null) {
  if (!status) return <Badge variant="outline" className="text-[10px]">未割当</Badge>;
  switch (status) {
    case "pending":
      return <Badge variant="secondary" className="text-[10px]">pending</Badge>;
    case "delivered":
      return <Badge className="bg-green-600 text-white text-[10px]">配達済</Badge>;
    case "in_transit":
      return <Badge className="bg-blue-600 text-white text-[10px]">配送中</Badge>;
    case "absent":
      return <Badge variant="destructive" className="text-[10px]">不在</Badge>;
    case "assigned":
      return <Badge variant="secondary" className="text-[10px]">割当済</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
  }
}

const STATUS_FILTERS = [
  { key: "all", label: "全て" },
  { key: "pending", label: "未着手" },
  { key: "assigned", label: "割当済" },
  { key: "in_transit", label: "配送中" },
  { key: "delivered", label: "配達済" },
  { key: "absent", label: "不在" },
  { key: "unassigned", label: "未割当" },
] as const;

export function PackageTable({ data }: Props) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    let result = data;
    if (query) {
      const q = query.toLowerCase();
      result = result.filter(
        (p) =>
          p.address.toLowerCase().includes(q) ||
          p.package_id.toLowerCase().includes(q) ||
          (p.driver_name && p.driver_name.toLowerCase().includes(q))
      );
    }
    if (statusFilter !== "all") {
      if (statusFilter === "unassigned") {
        result = result.filter((p) => !p.status);
      } else {
        result = result.filter((p) => p.status === statusFilter);
      }
    }
    return result;
  }, [data, query, statusFilter]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Package className="h-4 w-4" />
          荷物一覧 ({filtered.length}/{data.length})
        </CardTitle>
        <div className="relative mt-2">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="住所・ID・担当で検索..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {STATUS_FILTERS.map((f) => (
            <Badge
              key={f.key}
              variant={statusFilter === f.key ? "default" : "outline"}
              className="cursor-pointer text-[10px]"
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent className="max-h-[300px] overflow-y-auto p-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="pb-1">住所</th>
              <th className="pb-1 text-right">TW</th>
              <th className="pb-1 text-right">kg</th>
              <th className="pb-1 text-right">担当</th>
              <th className="pb-1 text-right">状態</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 100).map((p) => (
              <tr key={p.package_id} className="border-b border-border/30">
                <td className="max-w-[140px] truncate py-1">
                  {p.address}
                  {p.is_redelivery && (
                    <Badge variant="destructive" className="ml-1 text-[8px]">再</Badge>
                  )}
                </td>
                <td className="py-1 text-right text-xs">{p.time_window || "—"}</td>
                <td className="py-1 text-right text-xs">{p.weight}</td>
                <td className="py-1 text-right text-xs">{p.driver_name || "—"}</td>
                <td className="py-1 text-right">{statusBadge(p.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 100 && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            他 {filtered.length - 100} 件
          </p>
        )}
      </CardContent>
    </Card>
  );
}
