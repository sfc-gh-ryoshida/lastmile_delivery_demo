export class FetchError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function safeFetch<T>(url: string): Promise<T[]> {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[safeFetch] ${url} returned ${res.status}`);
    return [];
  }
  const data = await res.json();
  if (data?.error) {
    console.error(`[safeFetch] ${url}:`, data.error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

export async function safeFetchObj<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.error) return null;
  return data as T;
}

export interface FetchMeta {
  source: string;
  ms: number;
  rows: number;
}

export interface DataWithMeta<T> {
  data: T[];
  meta: FetchMeta;
}

export async function safeFetchWithMeta<T>(url: string): Promise<DataWithMeta<T>> {
  const res = await fetch(url);
  if (!res.ok) return { data: [], meta: { source: "?", ms: 0, rows: 0 } };
  const source = res.headers.get("X-Source") || "?";
  const ms = parseInt(res.headers.get("X-Query-Ms") || "0");
  const rowCount = parseInt(res.headers.get("X-Row-Count") || "0");
  const data = await res.json();
  if (data?.error) return { data: [], meta: { source, ms, rows: 0 } };
  const arr = Array.isArray(data) ? data : [];
  return { data: arr as T[], meta: { source, ms: ms || 0, rows: rowCount || arr.length } };
}
