import { Pool, types } from "pg";

// numeric / int8 arrive as strings by default; every value in mart fits a JS
// double, so parse at the driver level and keep the query layer cast-free.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

declare global {
  // eslint-disable-next-line no-var
  var __arenaPool: Pool | undefined;
}

function makePool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  const ssl = ca
    ? { ca, rejectUnauthorized: true } // verify-full: encrypt AND authenticate the server
    : process.env.DATABASE_SSL === "require"
      ? { rejectUnauthorized: false }
      : undefined;
  const pool = new Pool({
    connectionString,
    ssl,
    max: Number(process.env.PGPOOL_MAX ?? 3),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // The remote pooler (PgBouncer) drops idle server connections. Without this
  // handler, node-pg re-emits that as an `error` on an idle pooled client,
  // which becomes an uncaughtException and kills the process. Logging and
  // discarding is the documented stance — the client is removed from the pool.
  pool.on("error", (err) => {
    console.error("pg pool idle client error:", err.message);
  });
  return pool;
}

// Module-scoped pool, stashed on globalThis so dev hot-reload and warm
// serverless instances reuse connections instead of re-opening them.
export function getPool(): Pool {
  if (!global.__arenaPool) global.__arenaPool = makePool();
  return global.__arenaPool;
}

export async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

// Fixed competition scope (S1) applied server-side on every query.
export const COMPETITION_ID =
  process.env.ARENA_COMPETITION_ID ?? "cmr3n8tft01nilecm1u5jlny7";
