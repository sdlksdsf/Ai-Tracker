#!/usr/bin/env node
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { checkDatabase, closeDatabase } from './index.js';
import { ensureExtensions, runMigrations } from './migrate.js';

/**
 * Migration CLI.
 *
 *   npm run db:migrate                     (source, via tsx)
 *   node packages/api/dist/migrate.js      (production bundle)
 *
 * Exits 0 when the schema is current and 1 with the reason otherwise, so it can
 * gate a deploy (e.g. as Render's pre-deploy command on a paid instance).
 *
 * This is its own entrypoint on purpose — see the note at the top of migrate.ts.
 */
async function main(): Promise<void> {
  const reachable = await checkDatabase();
  if (!reachable.ok) {
    throw new Error(`Cannot reach PostgreSQL (${reachable.error ?? 'unknown error'}) — check DATABASE_URL`);
  }

  await ensureExtensions();
  const result = await runMigrations();
  logger.info({ ...result, env: env.NODE_ENV }, 'Migration run complete');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Migration run failed');
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
