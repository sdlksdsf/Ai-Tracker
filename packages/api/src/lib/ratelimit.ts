import type { FastifyRequest } from 'fastify';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { env } from '../config/env.js';
import { getRedisClient } from './redis.js';
import { logger } from './logger.js';

/**
 * Rate limiting (Section 8 — Security & Performance).
 *
 *   general  100 req/min per user
 *   AI        10 req/min per user  (recipe + meal-plan generation)
 *   scan       5 req/min per user  (the most expensive endpoint we have)
 *   auth      10 req/min per IP    (brute-force protection)
 *
 * Counters live in Redis when it is available so the limits hold across
 * replicas; otherwise @fastify/rate-limit falls back to its in-memory store,
 * which is correct for a single process (local dev, CI).
 */

/** Identify the caller: authenticated user id first, then IP. */
export function rateLimitKeyGenerator(request: FastifyRequest): string {
  const user = (request as FastifyRequest & { user?: { id: string } }).user;
  if (user?.id) return `u:${user.id}`;

  const forwarded = request.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
    request.ip ||
    'unknown';

  return `ip:${ip}`;
}

/**
 * @fastify/rate-limit builds its own Redis store when handed a client, so we
 * just pass the shared connection through. `undefined` means "use the
 * in-memory store", which is the right behaviour for a single local process.
 */
function redisStore(): unknown {
  try {
    return getRedisClient() ?? undefined;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Rate-limit Redis unavailable — using the in-memory store');
    return undefined;
  }
}

/** Shared 429 body so the mobile client can render a consistent message. */
export const rateLimitErrorResponse = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    error: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

/** @fastify/rate-limit calls this as `(request, context) => object`. */
export function rateLimitErrorFormatter(
  request: FastifyRequest,
  context: { statusCode?: number; message?: string; after?: string; max?: number },
): object {
  const limit = typeof context.max === 'number' ? context.max : null;
  return {
    statusCode: context.statusCode ?? 429,
    error: 'rate_limited',
    message: context.message ?? 'Too many requests. Please slow down.',
    requestId: request.id,
    ...(limit !== null ? { limit } : {}),
    ...(context.after ? { retryAfter: context.after } : {}),
  };
}

/** Global limiter — 100/min, applied to every route unless overridden. */
/**
 * Paths that must never be throttled, whatever the global setting.
 *
 * A liveness probe that gets a 429 takes a healthy container out of rotation,
 * and a rejected Stripe webhook silently desyncs billing. `/metrics` is
 * explicitly *not* exempt: it is cheap to serve but worth throttling.
 */
export function isOperationallyExempt(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (path === '/health' || path === '/health/live' || path === '/health/ready') return true;
  if (path === '/metrics') return false;
  if (path.endsWith('/subscription/webhook')) return true;
  if (path.startsWith('/docs')) return true;
  return false;
}

/**
 * The allow-list the limiter actually runs with.
 *
 * Takes the flag as a parameter so it can be tested without re-importing the
 * memoised `env`, and *composes* the two exemptions rather than choosing between
 * them. The plugin used to spread its own allow-list after
 * `generalRateLimitOptions()`, which replaced the `() => true` that
 * `RATE_LIMIT_DISABLED` installs — so the flag logged "rate limiting is OFF.
 * Never set this in production." and then limited at full strength anyway. That
 * is how a test-only flag ended up 429ing the integration suite's pantry-quota
 * seed once Redis made the counter shared and persistent across the run.
 */
export function resolveAllowList(disabled: boolean = env.RATE_LIMIT_DISABLED): (url: string) => boolean {
  return (url: string) => disabled || isOperationallyExempt(url);
}

export function generalRateLimitOptions(): RateLimitPluginOptions {
  const store = safeStore();
  return {
    global: true,
    max: env.RATE_LIMIT_GENERAL_MAX,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKeyGenerator,
    // Deliberately not set here. The allow-list is composed once by
    // `resolveAllowList()` and passed by the plugin — having two places assign
    // the same option is what let a spread silently discard RATE_LIMIT_DISABLED.
    redis: store ?? undefined,
    errorResponseBuilder: rateLimitErrorFormatter,
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  };
}

/** Per-route limiters. Spread into a route's `{ config: { rateLimit } }`. */
export const rateLimits = {
  /** AI-backed generation: recipes and meal plans. */
  ai: (max = env.RATE_LIMIT_AI_MAX): RateLimitPluginOptions => withStore({
    max,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKeyGenerator,
    errorResponseBuilder: rateLimitErrorFormatter,
  }),

  /** Fridge scans — image upload + vision model, our most expensive call. */
  scan: (max = env.RATE_LIMIT_SCAN_MAX): RateLimitPluginOptions => withStore({
    max,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKeyGenerator,
    errorResponseBuilder: rateLimitErrorFormatter,
  }),

  /** Login/register/reset — keyed by IP so one abusive host cannot lock out users. */
  auth: (max = env.RATE_LIMIT_AUTH_MAX): RateLimitPluginOptions => withStore({
    max,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => `auth:${request.ip}`,
    errorResponseBuilder: rateLimitErrorFormatter,
  }),

  /** Password reset requests — deliberately strict. */
  passwordReset: (): RateLimitPluginOptions => withStore({
    max: 3,
    timeWindow: '1 hour',
    keyGenerator: (request: FastifyRequest) => `reset:${request.ip}`,
    errorResponseBuilder: rateLimitErrorFormatter,
  }),

  /** Webhooks come from a trusted provider, so they are not user-rate-limited. */
  none: (): RateLimitPluginOptions => ({ allowList: () => true }),
};

function withStore(options: RateLimitPluginOptions): RateLimitPluginOptions {
  // RATE_LIMIT_DISABLED must disable the per-route limiters too, not just the
  // global one. Otherwise a test or load run that sets the flag still gets 429s
  // from /auth (10/min per IP) and every request from one host after the tenth.
  if (env.RATE_LIMIT_DISABLED) return { ...options, allowList: () => true };

  const redis = safeStore();
  return { ...options, redis: redis ?? undefined };
}

let storeResolved = false;
let cachedStore: RateLimitPluginOptions['redis'];

/** Resolve the shared Redis client once, at first limiter construction. */
function safeStore(): RateLimitPluginOptions['redis'] {
  if (storeResolved) return cachedStore;
  storeResolved = true;
  try {
    cachedStore = redisStore();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Rate-limit Redis store unavailable — using the in-memory store');
    cachedStore = undefined;
  }
  return cachedStore;
}
