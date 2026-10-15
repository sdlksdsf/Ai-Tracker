import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { generalRateLimitOptions, resolveAllowList } from '../lib/ratelimit.js';
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

  // Built once, outside the request path.
  const allowList = resolveAllowList();

  await app.register(rateLimit, {
    ...generalRateLimitOptions(),
    // A Redis hiccup must not take the whole API down.
    skipOnError: true,
    hook: 'onRequest',
    // The single place the allow-list is set. It used to be assigned here *and*
    // inside generalRateLimitOptions(), and this spread won — which is why
    // RATE_LIMIT_DISABLED logged a warning and then limited anyway.
    allowList: (request) => allowList(request.url),
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
