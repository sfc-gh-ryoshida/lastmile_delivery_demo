"use client";

import { useState, useCallback } from "react";
import useSWR from "swr";
import { safeFetch } from "@/lib/fetcher";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Database, Table, RefreshCw, Snowflake, Wand2, CheckCircle2, Trash2, BarChart3, Loader2, CalendarDays } from "lucide-react";
import { useDate } from "@/context/date-context";

interface TableInfo {
  table_name: string;
  row_count: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
}

interface QueryResult {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
}

type DbSource = "postgres" | "snowflake";

interface SyncStep {
  step: string;
  ok: boolean;
  message: string;
  ms: number;
}

interface DayStatus {
  date: string;
  packages: number;
  drivers: number;
  breakdown: Record<string, number>;
}

function DemoDataPanel({ date: globalDate }: { date: string }) {
  const [localDate, setLocalDate] = useState(globalDate);
  const date = localDate;
  const [status, setStatus] = useState<DayStatus | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [syncSteps, setSyncSteps] = useState<SyncStep[] | null>(null);

  const fetchStatus = useCallback(async (d: string) => {
    try {
      const res = await fetch("/api/admin/demo-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", date: d }),
      });
      const data = await res.json();
      setStatus(data);
    } catch { setStatus(null); }
  }, []);

  const runAction = useCallback(async (action: string, d: string) => {
    setLoading(action);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/demo-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, date: d }),
      });
      const data = await res.json();
      setMessage(data.message || data.error || "Done");
      if (data.packages !== undefined) setStatus(data);
      else await fetchStatus(d);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLoading(null);
    }
  }, [fetchStatus]);

  const bd = status?.breakdown;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-muted-foreground">Demo Data</h2>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => fetchStatus(date)}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <CalendarDays className="h-3 w-3 text-muted-foreground shrink-0" />
        <Input
          type="date"
          value={localDate}
          onChange={(e) => { setLocalDate(e.target.value); setStatus(null); setMessage(null); setSyncSteps(null); }}
          className="h-7 text-[11px] font-mono px-2"
        />
      </div>
      {localDate !== globalDate && (
        <div className="flex items-center gap-1">
          <Badge variant="secondary" className="text-[9px] flex-1 justify-center cursor-pointer" onClick={() => { setLocalDate(globalDate); setStatus(null); setMessage(null); setSyncSteps(null); }}>
            Global: {globalDate} に戻す
          </Badge>
        </div>
      )}

      {status && (
        <div className="rounded-md border p-2 space-y-1 text-[10px]">
          <div className="flex justify-between"><span>荷物</span><span className="font-mono">{status.packages}</span></div>
          <div className="flex justify-between"><span>ドライバー</span><span className="font-mono">{status.drivers}</span></div>
          {bd && Object.entries(bd).filter(([, v]) => v > 0).map(([k, v]) => (
            <div key={k} className="flex justify-between text-muted-foreground">
              <span>{k}</span><span className="font-mono">{v}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-1">
        <Button
          variant="outline" size="sm" className="h-7 gap-1 text-[10px] justify-start"
          disabled={!!loading}
          onClick={() => fetchStatus(date)}
        >
          {loading === "status" ? <Loader2 className="h-3 w-3 animate-spin" /> : <BarChart3 className="h-3 w-3" />}
          ステータス確認
        </Button>
        <Button
          variant="outline" size="sm" className="h-7 gap-1 text-[10px] justify-start"
          disabled={!!loading}
          onClick={() => runAction("generate", date)}
        >
          {loading === "generate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          デモデータ生成
        </Button>
        <Button
          variant="outline" size="sm" className="h-7 gap-1 text-[10px] justify-start"
          disabled={!!loading}
          onClick={() => runAction("close", date)}
        >
          {loading === "close" ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          全件配達済みに
        </Button>
        <Button
          variant="destructive" size="sm" className="h-7 gap-1 text-[10px] justify-start"
          disabled={!!loading}
          onClick={() => { if (confirm(`${date} のデータを全削除しますか？`)) runAction("reset", date); }}
        >
          {loading === "reset" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          データリセット
        </Button>
      </div>

      <div className="border-t pt-2 mt-2">
        <p className="text-[9px] text-muted-foreground mb-1">Snowflake 同期 (ETL + ML + コスト行列)</p>
        <Button
          variant="outline" size="sm" className="h-7 gap-1 text-[10px] justify-start w-full"
          disabled={!!loading}
          onClick={async () => {
            setLoading("sf-sync");
            setMessage(null);
            setSyncSteps(null);
            try {
              const res = await fetch("/api/admin/sf-sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ date }),
              });
              const data = await res.json();
              setSyncSteps(data.steps || []);
              setMessage(data.ok ? `SF同期完了 (${(data.totalMs / 1000).toFixed(0)}s)` : "一部失敗あり");
            } catch (e) { setMessage(String(e)); }
            finally { setLoading(null); }
          }}
        >
          {loading === "sf-sync" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Snowflake className="h-3 w-3" />}
          SF同期実行
        </Button>
      </div>

      {syncSteps && (
        <div className="rounded-md border p-2 space-y-0.5 text-[9px] max-h-40 overflow-y-auto">
          {syncSteps.map((s, i) => (
            <div key={i} className={`flex items-start gap-1 ${s.ok ? "" : "text-destructive"}`}>
              <span>{s.ok ? "✓" : "✗"}</span>
              <span className="flex-1 break-all">{s.step}</span>
              <span className="font-mono shrink-0">{(s.ms / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}

      {message && (
        <p className="text-[10px] text-muted-foreground break-all">{message}</p>
      )}
    </div>
  );
}

export default function AdminPage() {
  const { date } = useDate();
  const [source, setSource] = useState<DbSource>("postgres");
  const { data: pgTables, mutate: mutatePg } = useSWR<TableInfo[]>(
    "/api/admin/tables",
    safeFetch
  );
  const { data: sfTables, mutate: mutateSf } = useSWR<TableInfo[]>(
    "/api/admin/snowflake-tables",
    safeFetch
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);

  const tables = source === "postgres" ? pgTables : sfTables;

  const queryTable = async (table: string) => {
    setSelected(table);
    setLoading(true);
    try {
      const endpoint =
        source === "postgres"
          ? "/api/admin/query"
          : "/api/admin/snowflake-query";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table, limit: 50 }),
      });
      const data = await res.json();
      setResult(data);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const switchSource = (s: DbSource) => {
    setSource(s);
    setSelected(null);
    setResult(null);
  };

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 overflow-y-auto border-r bg-card p-4">
        <DemoDataPanel date={date} />
        <div className="my-3 border-t" />
        <div className="mb-3 flex gap-1">
          <Button
            variant={source === "postgres" ? "default" : "outline"}
            size="sm"
            className="h-7 flex-1 gap-1 text-xs"
            onClick={() => switchSource("postgres")}
          >
            <Database className="h-3 w-3" />
            Postgres
          </Button>
          <Button
            variant={source === "snowflake" ? "default" : "outline"}
            size="sm"
            className="h-7 flex-1 gap-1 text-xs"
            onClick={() => switchSource("snowflake")}
          >
            <Snowflake className="h-3 w-3" />
            Snowflake
          </Button>
        </div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-muted-foreground">
            {source === "postgres" ? "Postgres Tables" : "Snowflake Tables"}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => (source === "postgres" ? mutatePg() : mutateSf())}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
        <div className="space-y-1">
          {tables?.map((t) => (
            <button
              key={t.table_name}
              onClick={() => queryTable(t.table_name)}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors ${
                selected === t.table_name
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <Table className="h-3 w-3 shrink-0" />
                <span className="truncate">{t.table_name}</span>
              </span>
              <Badge variant="secondary" className="ml-1 shrink-0 text-[10px]">
                {parseInt(t.row_count).toLocaleString()}
              </Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!selected && !loading && (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md space-y-4 text-center">
              <Database className="mx-auto h-12 w-12 text-muted-foreground/40" />
              <div className="space-y-1">
                <p className="text-sm font-medium">データブラウザ</p>
                <p className="text-xs text-muted-foreground">
                  左のサイドバーからテーブルを選択すると、カラム情報とサンプルデータ（最大50行）を確認できます。
                </p>
              </div>
              <div className="space-y-2 rounded-lg border p-3 text-left">
                <p className="text-xs font-medium">使い方</p>
                <ul className="space-y-1 text-[11px] text-muted-foreground">
                  <li>1. 上部の <strong>Postgres</strong> / <strong>Snowflake</strong> ボタンでデータソースを切替</li>
                  <li>2. テーブル一覧からテーブル名をクリック</li>
                  <li>3. カラム定義とサンプルデータが右側に表示されます</li>
                </ul>
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  <p><strong>Postgres</strong>: リアルタイム配送データ（荷物、ドライバー、配達状況など）</p>
                  <p><strong>Snowflake</strong>: 分析・ML用データ（KPI、需要予測、リスクスコアなど）</p>
                </div>
              </div>
            </div>
          </div>
        )}
        {loading && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">読み込み中...</p>
          </div>
        )}
        {result && !loading && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Table className="h-4 w-4" />
                {selected}
                <Badge variant="outline" className="ml-2 text-xs">
                  {result.total.toLocaleString()} 行
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {source === "postgres" ? "Postgres" : "Snowflake"}
                </Badge>
              </CardTitle>
              <div className="flex flex-wrap gap-1 pt-1">
                {result.columns.map((c) => (
                  <Badge key={c.column_name} variant="secondary" className="text-[10px]">
                    {c.column_name}: {c.data_type}
                  </Badge>
                ))}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      {result.columns.map((c) => (
                        <th key={c.column_name} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                          {c.column_name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="border-b hover:bg-muted/30">
                        {result.columns.map((c) => (
                          <td key={c.column_name} className="whitespace-nowrap px-3 py-1.5 font-mono">
                            {String(row[c.column_name] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
