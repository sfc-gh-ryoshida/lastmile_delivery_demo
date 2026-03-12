import snowflake from "snowflake-sdk";
import fs from "fs";

snowflake.configure({ logLevel: "ERROR" });

let connection: snowflake.Connection | null = null;
let connectionCreatedAt = 0;
const CONNECTION_TTL_MS = 5 * 60 * 1000;
const SPCS_TOKEN_PATH = "/snowflake/session/token";

function isSpcs(): boolean {
  try {
    return fs.existsSync(SPCS_TOKEN_PATH);
  } catch {
    return false;
  }
}

function getConfig(): snowflake.ConnectionOptions {
  if (isSpcs()) {
    const token = fs.readFileSync(SPCS_TOKEN_PATH, "ascii");
    return {
      accessUrl: "https://" + process.env.SNOWFLAKE_HOST,
      account: process.env.SNOWFLAKE_ACCOUNT || "SFSEAPAC-FSI_JAPAN",
      authenticator: "OAUTH",
      token,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || "RYOSHIDA_WH",
      database: process.env.SNOWFLAKE_DATABASE || "LASTMILE_DB",
      schema: process.env.SNOWFLAKE_SCHEMA || "ANALYTICS",
    };
  }

  const account = process.env.SNOWFLAKE_ACCOUNT || "SFSEAPAC-FSI_JAPAN";
  const base = {
    account,
    accessUrl: "https://snb02945.snowflakecomputing.com",
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || "RYOSHIDA_WH",
    database: process.env.SNOWFLAKE_DATABASE || "LASTMILE_DB",
    schema: process.env.SNOWFLAKE_SCHEMA || "ANALYTICS",
  };

  const pat = process.env.SNOWFLAKE_PAT;
  if (pat) {
    return {
      ...base,
      username: process.env.SNOWFLAKE_USER || "FSI_JAPAN",
      token: pat,
      authenticator: "PROGRAMMATIC_ACCESS_TOKEN",
    };
  }

  return {
    ...base,
    username: process.env.SNOWFLAKE_USER || "FSI_JAPAN",
    authenticator: "EXTERNALBROWSER",
  };
}

async function getConnection(): Promise<snowflake.Connection> {
  const expired = Date.now() - connectionCreatedAt > CONNECTION_TTL_MS;

  if (isSpcs()) {
    const tokenAge = Date.now() - connectionCreatedAt;
    if (connection && tokenAge < 10 * 60 * 1000) {
      return connection;
    }
  } else if (connection && !expired) {
    return connection;
  }

  if (connection) {
    connection.destroy(() => {});
    connection = null;
  }

  const conn = snowflake.createConnection(getConfig());
  await conn.connectAsync(() => {});
  connection = conn;
  connectionCreatedAt = Date.now();
  return connection;
}

function isRetryableError(err: unknown): boolean {
  const error = err as { message?: string; code?: number };
  return !!(
    error.message?.includes("OAuth access token expired") ||
    error.message?.includes("terminated connection") ||
    error.code === 407002
  );
}

export async function query<T>(sql: string, binds?: snowflake.Binds, retries = 1): Promise<T[]> {
  try {
    const conn = await getConnection();
    return await new Promise<T[]>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds: binds || [],
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve((rows || []) as T[]);
        },
      });
    });
  } catch (err) {
    if (retries > 0 && isRetryableError(err)) {
      connection = null;
      return query(sql, binds, retries - 1);
    }
    throw err;
  }
}
