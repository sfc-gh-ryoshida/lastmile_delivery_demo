import { NextResponse } from "next/server";
import { query } from "@/lib/snowflake";

const ALLOWED_SCHEMAS = ["ANALYTICS", "ML"];

export async function POST(request: Request) {
  try {
    const { table, limit = 50 } = await request.json();
    if (!table || typeof table !== "string") {
      return NextResponse.json({ error: "table required" }, { status: 400 });
    }

    const parts = table.split(".");
    if (parts.length !== 2 || !ALLOWED_SCHEMAS.includes(parts[0].toUpperCase())) {
      return NextResponse.json({ error: "invalid table" }, { status: 400 });
    }

    const schema = parts[0].toUpperCase();
    const tbl = parts[1].toUpperCase().replace(/[^A-Z0-9_]/g, "");
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const colRows = await query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE
       FROM LASTMILE_DB.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [schema, tbl]
    );

    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM LASTMILE_DB.${schema}.${tbl} LIMIT ${safeLimit}`
    );

    const countRows = await query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM LASTMILE_DB.${schema}.${tbl}`
    );

    return NextResponse.json({
      columns: colRows.map((c) => ({
        column_name: c.COLUMN_NAME,
        data_type: c.DATA_TYPE,
      })),
      rows,
      total: countRows[0]?.C ?? rows.length,
    });
  } catch (error) {
    console.error("Snowflake query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
