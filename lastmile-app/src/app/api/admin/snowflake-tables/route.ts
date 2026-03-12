import { NextResponse } from "next/server";
import { query } from "@/lib/snowflake";

interface TableRow {
  TABLE_NAME: string;
  ROW_COUNT: number;
  TABLE_SCHEMA: string;
}

export async function GET() {
  try {
    const rows = await query<TableRow>(
      `SELECT TABLE_NAME, ROW_COUNT, TABLE_SCHEMA
       FROM LASTMILE_DB.INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA IN ('ANALYTICS', 'ML')
         AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_SCHEMA, TABLE_NAME`
    );
    return NextResponse.json(
      rows.map((r) => ({
        table_name: `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`,
        row_count: String(r.ROW_COUNT ?? 0),
      }))
    );
  } catch (error) {
    console.error("Snowflake table list error:", error);
    return NextResponse.json({ error: "Failed to list Snowflake tables" }, { status: 500 });
  }
}
