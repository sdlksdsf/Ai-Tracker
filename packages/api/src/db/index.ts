import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema.js';

/**
 * Database access layer.
 *
 * A single `pg.Pool` is shared by the API and the worker. Connection pooling is
 * tuned for transaction-mode poolers (PgBouncer / Supavisor / Neon pooler).
 */

export type Database = NodePgDatabase<typeof schema>;

const { Pool, types } = pg;

// Return NUMERIC as a JS number instead of a string — every `decimal(..., { mode: 'number' })`
// column in the schema relies on this. Precision loss beyond 15 digits is not a
// concern for currency/nutrition values.
types.setTypeParser(types.builtins.NUMERIC, (value) => (value === null ? null : Number.parseFloat(value)));
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

let pool: pg.Pool | null = null;
let db: Database | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Required when connecting through PgBouncer/Supavisor in transaction mode.
    allowExitOnIdle: false,
    ssl: needsSsl(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    application_name: 'platematch-api',
  });

  pool.on('error', (err) => {
    logger.error({ err: err.message }, 'Unexpected error on idle database client');
  });

  return pool;
}

/** Managed Postgres hosts (Supabase, Neon, RDS) require TLS. */
function needsSsl(url: string): boolean {
  if (url.includes('localhost') || url.includes('127.0.0.1') || url.startsWith('unix:')) return false;
  return /[?&]sslmode=require/.test(url) || /supabase\.co|neon\.tech|rds\.amazonaws\.com|railway\.app|render\.com|fly\.dev/.test(url);
}

export function getDb(): Database {
  if (db) return db;
  db = drizzle(getPool(), { schema, logger: env.NODE_ENV === 'development' && env.LOG_LEVEL === 'debug' });
  return db;
}

/** Override the database instance — used by tests. */
export function setDb(next: Database | null): void {
  db = next;
}

/** Run a callback inside a transaction. */
export async function withTransaction<T>(fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

/** Verify connectivity (used by /health and boot). */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const client = await getPool().connect();
    try {
      await client.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - started };
    } finally {
      client.release();
    }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
    db = null;
  }
}

export { schema };
export * from './schema.js';
