import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import { getDb } from './index.js';

/**
 * Apply pending SQL migrations from `packages/api/drizzle`.
 *
 * This module is a library with no side effects on import. The CLI lives in
 * `migrate-cli.ts` (`npm run db:migrate`, `node dist/migrate.js`) because a
 * "was I invoked directly?" guard is unreliable once tsup bundles this file into
 * `dist/server.js`: `import.meta.url` then names the *bundle*, the guard passes,
 * and the CLI ran inside the API — racing the boot migration and closing the
 * shared pool under it.
 *
 * The API also calls `runMigrations()` on boot when `DATABASE_MIGRATE_ON_BOOT=true`,
 * so a fresh deploy is self-sufficient.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every place the committed SQL can live, depending on how the code runs.
 *
 * The folder used to be resolved only as `<this file>/../../drizzle`. That is
 * right for `src/db/migrate.ts` under tsx, but in the bundle `<this file>` is
 * `dist/server.js`, so it pointed at `packages/drizzle` — which does not exist —
 * and the server logged a warning and booted against an EMPTY schema.
 */
export function migrationFolderCandidates(): string[] {
  return [
    ...new Set([
      path.resolve(here, '../../drizzle'), // tsx:     packages/api/src/db → packages/api/drizzle
      path.resolve(here, '../drizzle'), // bundle:  packages/api/dist   → packages/api/drizzle
      path.resolve(process.cwd(), 'drizzle'), // started from packages/api (the Docker image)
      path.resolve(process.cwd(), 'packages/api/drizzle'), // started from the repo root (Render)
    ]),
  ];
}

const hasJournal = (folder: string): boolean => existsSync(path.join(folder, 'meta', '_journal.json'));

/** The first candidate that actually contains a drizzle journal, or null. */
export function resolveMigrationsFolder(): string | null {
  return migrationFolderCandidates().find(hasJournal) ?? null;
}

export interface MigrationResult {
  folder: string;
  /** Migrations applied by this run. */
  applied: number;
  /** Migrations recorded in the database after this run. */
  total: number;
}

/**
 * Apply every pending migration. Throws — never warns and carries on — when the
 * SQL cannot be found: a server that boots against an empty schema fails every
 * request with "relation does not exist", which is far harder to diagnose.
 */
export async function runMigrations(
  folder: string | null = resolveMigrationsFolder(),
): Promise<MigrationResult> {
  if (!folder || !hasJournal(folder)) {
    throw new Error(
      [
        'Database migrations folder not found. Looked in:',
        ...(folder ? [folder] : migrationFolderCandidates()).map((candidate) => `  - ${candidate}`),
        'The committed SQL lives in packages/api/drizzle and must be deployed next to dist/.',
      ].join('\n'),
    );
  }

  const db = getDb();
  const before = await countAppliedMigrations();
  const started = Date.now();
  logger.info({ folder }, 'Applying database migrations…');

  await migrate(db, { migrationsFolder: folder });

  const total = await countAppliedMigrations();
  const applied = Math.max(0, total - before);
  logger.info(
    { applied, total, ms: Date.now() - started },
    applied ? `Applied ${applied} database migration(s)` : 'Database schema is up to date',
  );
  return { folder, applied, total };
}

/** Rows in drizzle's bookkeeping table; 0 before the very first migration. */
async function countAppliedMigrations(): Promise<number> {
  try {
    const result = await getDb().execute(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    const row = (result as unknown as { rows?: Array<{ count?: number | string }> }).rows?.[0];
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
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
