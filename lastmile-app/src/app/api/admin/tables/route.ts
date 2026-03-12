import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

export async function GET() {
  try {
    const rows = await pgQuery<{ table_name: string; row_count: string }>(
      `SELECT
         c.relname AS table_name,
         c.reltuples::bigint::text AS row_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
       ORDER BY c.relname`
    );
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching tables:", error);
    return NextResponse.json({ error: "Failed to fetch tables" }, { status: 500 });
  }
}
