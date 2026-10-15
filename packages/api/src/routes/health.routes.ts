import type { FastifyInstance } from 'fastify';
import { API_BASE_PATH } from '@platematch/shared';
import { env } from '../config/env.js';
import { checkDatabase } from '../db/index.js';
import { cache, getRedisClient } from '../lib/redis.js';
import { isRedisBacked, QUEUE_NAMES } from '../lib/queue.js';
import { describeAiConfiguration } from '../services/ai/index.js';
import { storageDriverName } from '../lib/storage.js';

/**
 * Operational endpoints. Unauthenticated on purpose so a load balancer or
 * container orchestrator can probe them.
 *
 *   GET /health        → summary (200 even when a dependency is degraded)
 *   GET /health/live   → 200 if the process is up
 *   GET /health/ready  → 200 only when Postgres + cache are usable
 *   GET /api/v1/ai/status → which models are wired up (safe to expose)
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', {
    schema: {
      tags: ['health'],
      summary: 'Service summary',
      security: [],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            version: { type: 'string' },
            uptime_s: { type: 'integer' },
            timestamp: { type: 'string' },
            checks: {
              type: 'object',
              properties: {
                database: { type: 'string' },
                cache: { type: 'string' },
                queue: { type: 'string' },
                storage: { type: 'string' },
                ai: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const [database, cacheState] = await Promise.all([probeDatabase(), probeCache()]);
    const ai = describeAiConfiguration();

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      version: env.APP_VERSION,
      uptime_s: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: {
        database,
        cache: cacheState,
        queue: isRedisBacked() ? 'redis' : 'in-process',
        storage: storageDriverName(),
        ai: ai.mode,
      },
    };
  });

  app.get('/health/live', {
    schema: { tags: ['health'], summary: 'Liveness probe', security: [] },
  }, async (_request, reply) => reply.send({ status: 'alive', uptime_s: Math.round(process.uptime()) }));

  app.get('/health/ready', {
    schema: {
      tags: ['health'],
      summary: 'Readiness probe — 503 until Postgres and the cache answer',
      security: [],
    },
  }, async (_request, reply) => {
    const [database, cacheState] = await Promise.all([probeDatabase(), probeCache()]);
    const ready = database === 'ok' && cacheState !== 'down';

    return reply.status(ready ? 200 : 503).send({
      ready,
      database,
      cache: cacheState,
      queues: Object.values(QUEUE_NAMES),
    });
  });

  app.get(`${API_BASE_PATH}/ai/status`, {
    schema: {
      tags: ['health'],
      summary: 'Which AI providers and models this deployment will use',
      description:
        'Safe to expose: returns model names and capability flags only, never API keys. ' +
        'Useful for confirming that a deployment falls back to the built-in engine.',
      security: [],
    },
  }, async () => describeAiConfiguration());
}

async function probeDatabase(): Promise<'ok' | 'down'> {
  try {
    const result = await checkDatabase();
    return result.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

async function probeCache(): Promise<'redis' | 'memory' | 'down'> {
  try {
    if (getRedisClient()) {
      await cache.set('health:probe', '1', 5);
      return (await cache.get<string>('health:probe')) === '1' ? 'redis' : 'memory';
    }
    return 'memory';
  } catch {
    return 'down';
  }
}
