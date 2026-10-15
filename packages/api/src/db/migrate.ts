#!/usr/bin/env tsx
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { env, loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { closeDatabase, getDb } from './index.js';

/**
 * Apply pending SQL migrations from `packages/api/drizzle`.
 *
 *   npm run db:migrate
 *
 * The API also calls this on boot when `DATABASE_MIGRATE_ON_BOOT=true`, so a
 * fresh container deploy is self-sufficient.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** packages/api/src/db → packages/api/drizzle */
const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations(folder = migrationsFolder): Promise<void> {
  if (!existsSync(folder)) {
    logger.warn({ folder }, 'No migrations folder found — generate one with `npm run db:generate`');
    return;
  }

  const db = getDb();
  const started = Date.now();
  logger.info({ folder }, 'Applying database migrations…');
  await migrate(db, { migrationsFolder });
  logger.info({ ms: Date.now() - started }, 'Migrations applied');
}

/** Ensure Postgres extensions the schema relies on are present. */
export async function ensureExtensions(): Promise<void> {
  const db = getDb();
  const statements = ['CREATE EXTENSION IF NOT EXISTS "pgcrypto"', 'CREATE EXTENSION IF NOT EXISTS "citext"'];
  for (const statement of statements) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.execute(statement as unknown as Parameters<typeof db.execute>[0]);
    } catch (err) {
      // Some managed providers forbid CREATE EXTENSION — safe to ignore.
      logger.debug({ err: (err as Error).message, statement }, 'ensureExtensions skipped');
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  try {
    await ensureExtensions();
    await runMigrations();
    logger.info({ env: env.NODE_ENV }, 'Migration run complete');
    process.exitCode = 0;
  } catch (err) {
    logger.error({ err }, 'Migration run failed');
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

// Run only when executed directly (not when imported by the server bootstrap).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main();
}
