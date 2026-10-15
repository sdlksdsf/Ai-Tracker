import { env, hasReasoningKeys, hasStripeKeys, hasVisionKeys, isProduction } from './config/env.js';
import { logger } from './lib/logger.js';
import { getDb, closeDatabase, checkDatabase } from './db/index.js';
import { runMigrations, ensureExtensions } from './db/migrate.js';
import { closeCache } from './lib/redis.js';
import { closeQueues } from './lib/queue.js';
import { flushTelemetry } from './plugins/telemetry.js';
import { startApp } from './app.js';
import { seedDemoData } from './db/seed.js';

/**
 * HTTP server entrypoint.
 *
 * Boot order:
 *   1. validate configuration (throws early with an actionable message)
 *   2. connect Postgres, ensure extensions, run migrations if enabled
 *   3. optionally seed the demo account
 *   4. build + listen
 *   5. install graceful shutdown handlers
 *
 * Nothing here is optional-on-failure except the seed: a database we cannot
 * reach must stop the process rather than serve 500s.
 */

async function main(): Promise<void> {
  // ---- 1. Database -------------------------------------------------------
  const dbCheck = await checkDatabase();
  if (!dbCheck.ok) {
    logger.fatal({ error: dbCheck.error, latencyMs: dbCheck.latencyMs }, 'Cannot reach PostgreSQL');
    process.exit(1);
  }
  logger.info(
    {
      latencyMs: dbCheck.latencyMs,
      vision: hasVisionKeys ? 'live' : 'built-in engine',
      reasoning: hasReasoningKeys ? 'live' : 'built-in engine',
      stripe: hasStripeKeys ? 'live' : 'simulated checkout',
    },
    'PostgreSQL connected',
  );

  await ensureExtensions().catch((err: unknown) => {
    // `CREATE EXTENSION` needs superuser on some managed providers; a missing
    // pgcrypto only breaks server-side default uuid generation, which we do
    // not rely on.
    logger.warn({ err: (err as Error).message }, 'Could not ensure extensions — continuing');
  });

  if (env.DATABASE_MIGRATE_ON_BOOT) {
    logger.info('Running migrations');
    await runMigrations();
  }

  // Warm the Drizzle instance so the first request is not paying for it.
  getDb();

  // ---- 2. Optional demo seed --------------------------------------------
  if (env.SEED_DEMO_USER) {
    await seedDemoData().catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, 'Demo seed failed — continuing without it');
    });
  }

  // ---- 3. HTTP server ----------------------------------------------------
  const app = await startApp();

  // ---- 4. Graceful shutdown ---------------------------------------------
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Stop accepting connections first, then drain what is in flight.
    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15_000);
    timer.unref();

    try {
      await app.close();
      await closeQueues();
      await closeCache();
      await closeDatabase();
      await flushTelemetry();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    app.reportError(reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    app.reportError(err);
    void shutdown('uncaughtException');
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start the API server');
  process.exit(1);
});
