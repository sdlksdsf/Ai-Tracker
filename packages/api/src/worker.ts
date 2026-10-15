import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { checkDatabase, closeDatabase, getDb } from './db/index.js';
import { runMigrations, ensureExtensions } from './db/migrate.js';
import { closeCache, getRedisClient } from './lib/redis.js';
import { closeQueues, isRedisBacked } from './lib/queue.js';
import { flushTelemetry } from './plugins/telemetry.js';
import { registerWorkers } from './jobs/workers.js';
import { startCrons, stopCrons } from './jobs/crons.js';

/**
 * Background worker entrypoint.
 *
 * Runs the BullMQ job processors and the scheduled notification sweeps. Kept in
 * a separate process from the API so a long vision call or a bulk price refresh
 * can never delay an HTTP response, and so the two scale independently.
 *
 * `ENABLE_WORKER=false` lets a single-process deployment (docker-compose, a
 * small VPS) skip this entirely — `server.ts` registers the same processors
 * in-process when the queue falls back to memory.
 */

async function main(): Promise<void> {
  if (!env.ENABLE_WORKER) {
    logger.warn('ENABLE_WORKER=false — this worker will exit. Start it with ENABLE_WORKER=true.');
    process.exit(0);
  }

  // ---- Database ----------------------------------------------------------
  const dbCheck = await checkDatabase();
  if (!dbCheck.ok) {
    logger.fatal({ error: dbCheck.error }, 'Worker cannot reach PostgreSQL');
    process.exit(1);
  }
  getDb();
  logger.info({ latencyMs: dbCheck.latencyMs }, 'Worker: PostgreSQL connected');

  await ensureExtensions().catch(() => undefined);
  if (env.DATABASE_MIGRATE_ON_BOOT) {
    await runMigrations();
  }

  // ---- Redis -------------------------------------------------------------
  if (!getRedisClient()) {
    logger.warn(
      'Redis is not available — jobs will run in-process inside this worker. ' +
        'Set REDIS_URL and ENABLE_REDIS=true for a durable, multi-replica queue.',
    );
  } else {
    logger.info({ backed: isRedisBacked() }, 'Worker: Redis queue connected');
  }

  // ---- Workers + schedules ----------------------------------------------
  registerWorkers();
  await startCrons();

  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      redis: Boolean(getRedisClient()),
      crons: env.ENABLE_CRONS,
      version: env.APP_VERSION,
    },
    'PlateMatch worker started',
  );

  // ---- Graceful shutdown -------------------------------------------------
  let stopping = false;

  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Worker shutting down');

    const timer = setTimeout(() => {
      logger.error('Worker shutdown timed out — forcing exit');
      process.exit(1);
    }, 20_000);
    timer.unref();

    try {
      stopCrons();
      await closeQueues();
      await closeCache();
      await closeDatabase();
      await flushTelemetry();
      logger.info('Worker stopped cleanly');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error while stopping the worker');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // A rejected job promise must not kill the worker; BullMQ will retry it.
    logger.error({ err: reason }, 'Worker: unhandled rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Worker: uncaught exception');
    void stop('uncaughtException');
  });

  // Keep the process alive even when the queue is idle.
  setInterval(() => undefined, 60_000).unref();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start the PlateMatch worker');
  process.exit(1);
});
