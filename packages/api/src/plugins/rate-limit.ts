import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { generalRateLimitOptions } from '../lib/ratelimit.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Global rate limiter (Section 8).
 *
 * Registered globally at 100 req/min. Individual routes override it with
 * `config: { rateLimit: rateLimits.ai() }` — AI generation is capped at
 * 10 req/min and fridge scans at 5 req/min, because those are the calls that
 * cost real money upstream.
 *
 * Health checks and Stripe webhooks are on the allow-list: a liveness probe
 * must never be throttled, and a rejected webhook would silently desync billing.
 */
async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  if (env.RATE_LIMIT_DISABLED) {
    logger.warn('RATE_LIMIT_DISABLED=true — rate limiting is OFF. Never set this in production.');
  }

  await app.register(rateLimit, {
    ...generalRateLimitOptions(),
    // A Redis hiccup must not take the whole API down.
    skipOnError: true,
    hook: 'onRequest',
    allowList: (request) => {
      const url = request.url.split('?')[0] ?? '';
      if (url === '/health' || url === '/health/live' || url === '/health/ready') return true;
      if (url === '/metrics') return false;
      if (url.endsWith('/subscription/webhook')) return true;
      if (url.startsWith('/docs')) return true;
      return false;
    },
    onExceeding: (request, key) => {
      request.log.debug({ key, url: request.url }, 'Rate limit approaching');
    },
    onExceeded: (request, key) => {
      request.log.warn({ key, url: request.url, ip: request.ip }, 'Rate limit exceeded');
    },
    onBanReach: (request, key) => {
      request.log.error({ key, url: request.url, ip: request.ip }, 'Client banned by rate limiter');
    },
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit', fastify: '5.x' });
