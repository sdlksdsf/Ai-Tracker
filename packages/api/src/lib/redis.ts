import Redis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Redis client + cache helpers.
 *
 * Redis is optional in development: when it is unreachable (or `ENABLE_REDIS`
 * is false) every helper degrades to a bounded in-memory LRU so the API keeps
 * working — just without a shared cache. Production sets `ENABLE_REDIS=true`.
 */

export interface CacheDriver {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  delPattern(pattern: string): Promise<void>;
  incr(key: string, ttlSeconds?: number): Promise<number>;
  ping(): Promise<boolean>;
  quit(): Promise<void>;
  readonly isConnected: boolean;
}

// ---------------------------------------------------------------------------
// In-memory fallback (single process, LRU-bounded)
// ---------------------------------------------------------------------------

class MemoryCache implements CacheDriver {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly maxEntries = 2_000;
  readonly isConnected = false;

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    // Refresh recency for LRU.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delPattern(pattern: string): Promise<void> {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    for (const key of this.store.keys()) if (re.test(key)) this.store.delete(key);
  }

  async incr(key: string, ttlSeconds = 60): Promise<number> {
    const current = (await this.get<number>(key)) ?? 0;
    const next = current + 1;
    const existing = this.store.get(key);
    const expiresAt = existing && existing.expiresAt > Date.now() ? existing.expiresAt : Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value: next, expiresAt });
    return next;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async quit(): Promise<void> {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Redis-backed driver
// ---------------------------------------------------------------------------

class RedisCache implements CacheDriver {
  isConnected = false;
  constructor(private readonly client: Redis) {
    client.on('ready', () => {
      this.isConnected = true;
      logger.info('Redis connection ready');
    });
    client.on('end', () => {
      this.isConnected = false;
    });
    client.on('error', (err: Error) => {
      this.isConnected = false;
      logger.warn({ err: err.message }, 'Redis error — cache calls will no-op');
    });
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isConnected) return null;
    try {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      logger.warn({ err, key }, 'cache.get failed');
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    if (!this.isConnected) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds)));
    } catch (err) {
      logger.warn({ err, key }, 'cache.set failed');
    }
  }

  async del(key: string): Promise<void> {
    if (!this.isConnected) return;
    try {
      await this.client.del(key);
    } catch (err) {
      logger.warn({ err, key }, 'cache.del failed');
    }
  }

  /** SCAN-based pattern delete (never uses KEYS in production). */
  async delPattern(pattern: string): Promise<void> {
    if (!this.isConnected) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length) await this.client.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      logger.warn({ err, pattern }, 'cache.delPattern failed');
    }
  }

  async incr(key: string, ttlSeconds = 60): Promise<number> {
    if (!this.isConnected) return 1;
    try {
      const value = await this.client.incr(key);
      if (value === 1) await this.client.expire(key, ttlSeconds);
      return value;
    } catch (err) {
      logger.warn({ err, key }, 'cache.incr failed');
      return 1;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async quit(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory / singleton
// ---------------------------------------------------------------------------

function buildRedisOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    reconnectOnError: (err) => err.message.includes('READONLY'),
  };
}

let driver: CacheDriver | null = null;
let redisClient: Redis | null = null;

/** Lazily create (and memoise) the cache driver. */
export function getCache(): CacheDriver {
  if (driver) return driver;

  if (!env.ENABLE_REDIS) {
    logger.info('Redis disabled by configuration — using in-memory cache');
    driver = new MemoryCache();
    return driver;
  }

  try {
    redisClient = new Redis(env.REDIS_URL, buildRedisOptions());
    driver = new RedisCache(redisClient);
  } catch (err) {
    logger.warn({ err }, 'Could not create Redis client — falling back to in-memory cache');
    driver = new MemoryCache();
  }
  return driver;
}

/** The underlying ioredis client (needed by BullMQ). Null when Redis is off. */
export function getRedisClient(): Redis | null {
  getCache();
  return redisClient;
}

/** Replace the driver — used by tests. */
export function setCache(next: CacheDriver | null): void {
  driver = next;
  if (next === null) redisClient = null;
}

export async function closeCache(): Promise<void> {
  if (driver) await driver.quit();
  driver = null;
  redisClient = null;
}

export const cache = {
  get: <T>(key: string) => getCache().get<T>(key),
  set: <T>(key: string, value: T, ttl?: number) => getCache().set(key, value, ttl),
  del: (key: string) => getCache().del(key),
  delPattern: (pattern: string) => getCache().delPattern(pattern),
  incr: (key: string, ttl?: number) => getCache().incr(key, ttl),
  ping: () => getCache().ping(),
};

/**
 * Read-through cache helper.
 *
 * ```ts
 * const data = await cached(`nutrition:${hash}`, 30 * 86400, () => fetchEdamam(ingr));
 * ```
 */
export async function cached<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== null && hit !== undefined) return hit;
  const value = await factory();
  // Never cache null/undefined — a miss should stay a miss.
  if (value !== null && value !== undefined) await cache.set(key, value, ttlSeconds);
  return value;
}

/** Namespaced cache keys. */
export const CacheKeys = {
  pantry: (userId: string) => `pantry:${userId}`,
  pantryList: (userId: string) => `pantry:list:${userId}:*`,
  recipeSearch: (hash: string) => `recipe:search:${hash}`,
  recipeGeneration: (hash: string) => `recipe:gen:${hash}`,
  recipeDetail: (id: string) => `recipe:detail:${id}`,
  nutrition: (hash: string) => `nutrition:${hash}`,
  groceryPrices: (query: string) => `prices:${query}`,
  krogerToken: () => `kroger:oauth-token`,
  session: (userId: string) => `session:${userId}`,
  scanDedupe: (hash: string) => `scan:dedupe:${hash}`,
  scanStatus: (scanId: string) => `scan:status:${scanId}`,
  mealPlan: (planId: string) => `mealplan:${planId}`,
  weekOverview: (userId: string, weekStart: string) => `week:${userId}:${weekStart}`,
  groceryList: (listId: string) => `grocery:list:${listId}`,
  wasteStats: (userId: string, period = 'week') => `waste:stats:${userId}:${period}`,
  dashboard: (userId: string, view: string) => `dashboard:${userId}:${view}`,
  userProfile: (userId: string) => `user:profile:${userId}`,
  achievements: (userId: string) => `achievements:${userId}`,
  rateLimit: (scope: string, id: string) => `rl:${scope}:${id}`,
  usage: (userId: string, bucket: string) => `usage:${userId}:${bucket}`,

  // Notification sweeps run hourly but must deliver at most once per local day,
  // so each trigger records a `userId:localDay` marker here.
  expiryDigest: (userId: string) => `notif:expiry:${userId}`,
  mealReminder: (userId: string) => `notif:meal:${userId}`,
  smartSuggestion: (userId: string) => `notif:suggest:${userId}`,
  weeklyReport: (userId: string) => `notif:weekly:${userId}`,
} as const;
