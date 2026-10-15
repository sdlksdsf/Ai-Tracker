import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app.js';
import { checkDatabase, closeDatabase, getDb, setDb } from '../../../src/db/index.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { closeCache } from '../../../src/lib/redis.js';
import { closeQueues } from '../../../src/lib/queue.js';
import { resetEnvCache, loadEnv } from '../../../src/config/env.js';
import { logger } from '../../../src/lib/logger.js';

/**
 * Integration-test harness.
 *
 * Boots the **real** Fastify app — the same plugin graph the server uses — and
 * drives it with `app.inject()`, so there are no sockets, no port races and no
 * need for supertest.
 *
 * These tests need PostgreSQL. When it is not reachable the whole suite is
 * SKIPPED, loudly, rather than passing vacuously: a green run that exercised
 * nothing is worse than a red one, because it is believed.
 *
 *   local:  npm run db:up && npm run test:e2e
 *   CI:     Postgres 16 + Redis 7 service containers (see .github/workflows/ci.yml)
 */

/**
 * The subset of a light-my-request response the suites use.
 *
 * Declared structurally rather than imported, because `FastifyInstance['inject']`
 * is overloaded and its no-argument form returns a thenable *chain*, which makes
 * `ReturnType<...>` resolve to the wrong member.
 */
export interface TestResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
  json(): unknown;
}

export interface Harness {
  app: FastifyInstance;
  /** Convenience wrappers around `app.inject`. */
  get(url: string, token?: string): Promise<TestResponse>;
  post(url: string, body?: unknown, token?: string): Promise<TestResponse>;
  patch(url: string, body?: unknown, token?: string): Promise<TestResponse>;
  put(url: string, body?: unknown, token?: string): Promise<TestResponse>;
  delete(url: string, token?: string): Promise<TestResponse>;
}

/**
 * What `app.inject` accepts as a body.
 *
 * Typed structurally: `Parameters<FastifyInstance['inject']>[0]` resolves against
 * the *last* overload, which is the no-argument form, so it yields an empty tuple
 * rather than the options object.
 */
type InjectPayload = string | Buffer | Record<string, unknown> | unknown[] | FormData;

/**
 * Is a database actually available?
 *
 * Checked once per process and cached: probing on every file would add a second
 * of connection timeout per suite when the answer is "no".
 */
let dbAvailableCache: boolean | null = null;

export async function isDatabaseAvailable(): Promise<boolean> {
  if (dbAvailableCache !== null) return dbAvailableCache;

  try {
    const result = await checkDatabase();
    dbAvailableCache = result.ok;
    if (!result.ok) {
      logger.warn({ error: result.error }, 'No database — integration suite will be skipped');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Database probe failed — integration suite will be skipped');
    dbAvailableCache = false;
  }

  return dbAvailableCache;
}

/** Configure the process environment for a deterministic test run. */
export function applyTestEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    // Force the built-in deterministic engine: no API keys, no network, no
    // flaky assertions on model output.
    AI_MODE: 'mock',
    STORAGE_DRIVER: 'local',
    LOCAL_UPLOAD_DIR: './uploads-test',
    ENABLE_SWAGGER: 'false',
    ENABLE_CRONS: 'false',
    ENABLE_PUSH: 'false',
    ENABLE_ANALYTICS: 'false',
    RATE_LIMIT_DISABLED: 'true',
    DATABASE_MIGRATE_ON_BOOT: 'false',
    JWT_SECRET: 'test-access-secret-0123456789abcdef0123456789abcdef',
    JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789abcdef',
    SEED_DEMO_USER: 'false',
    ...overrides,
  });

  // env is memoised on first import; force it to re-read the values above.
  resetEnvCache();
  loadEnv();
}

/** Boot the app once, applying migrations. Call from `beforeAll`. */
export async function startHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  applyTestEnv(overrides);

  if (!(await isDatabaseAvailable())) {
    throw new Error('startHarness called without a reachable database — guard with isDatabaseAvailable()');
  }

  await runMigrations();
  getDb();

  const app = await buildApp({ skipDocs: true });
  await app.ready();

  const payloadOf = (body: unknown): InjectPayload | undefined =>
    body === undefined ? undefined : (body as InjectPayload);

  // The light-my-request Response is a superset of TestResponse; the cast is at
  // this one boundary so every suite gets the narrow, predictable type.
  const asTest = (promise: Promise<unknown>): Promise<TestResponse> => promise as Promise<TestResponse>;

  return {
    app,
    get: (url, token) => asTest(app.inject({ method: 'GET', url, headers: authHeaders(token) })),
    post: (url, body, token) => asTest(app.inject({ method: 'POST', url, headers: authHeaders(token), payload: payloadOf(body) })),
    patch: (url, body, token) => asTest(app.inject({ method: 'PATCH', url, headers: authHeaders(token), payload: payloadOf(body) })),
    put: (url, body, token) => asTest(app.inject({ method: 'PUT', url, headers: authHeaders(token), payload: payloadOf(body) })),
    delete: (url, token) => asTest(app.inject({ method: 'DELETE', url, headers: authHeaders(token) })),
  };
}

/** Tear everything down. Call from `afterAll`. */
export async function stopHarness(harness: Harness | null): Promise<void> {
  try {
    await harness?.app.close();
  } catch {
    /* already closed */
  }
  await closeQueues().catch(() => undefined);
  await closeCache().catch(() => undefined);
  setDb(null);
  await closeDatabase().catch(() => undefined);
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let userCounter = 0;

/** A unique email per test user, so parallel files cannot collide. */
export function uniqueEmail(prefix = 'user'): string {
  userCounter += 1;
  return `${prefix}-${Date.now()}-${userCounter}-${process.pid}@test.platematch.app`;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Register a user through the public API and return their session.
 *
 * Going through `/auth/register` rather than inserting a row means the auth
 * integration itself is under test in every suite that needs a user.
 */
export async function createTestUser(harness: Harness, options: { fullName?: string; password?: string } = {}): Promise<TestUser> {
  const email = uniqueEmail();
  const password = options.password ?? 'TestPassw0rd!';

  const response = await harness.post('/api/v1/auth/register', {
    email,
    password,
    full_name: options.fullName ?? 'Test User',
    timezone: 'UTC',
    locale: 'en',
  });

  if (response.statusCode !== 201) {
    throw new Error(`Registration failed (${response.statusCode}): ${response.body}`);
  }

  const body = response.json() as { data: { user: { id: string }; access_token: string; refresh_token: string } };

  return {
    id: body.data.user.id,
    email,
    password,
    accessToken: body.data.access_token,
    refreshToken: body.data.refresh_token,
  };
}

/** Add pantry items directly, for tests that need a populated fridge. */
export async function seedPantry(
  harness: Harness,
  token: string,
  items: Array<{ name: string; quantity?: number; unit?: string; expiresInDays?: number; category?: string }>,
): Promise<string[]> {
  const ids: string[] = [];

  for (const item of items) {
    const expiry = new Date(Date.now() + (item.expiresInDays ?? 5) * 86_400_000).toISOString().slice(0, 10);

    // eslint-disable-next-line no-await-in-loop
    const response = await harness.post(
      '/api/v1/pantry',
      {
        ingredient_name: item.name,
        quantity: item.quantity ?? 1,
        unit: item.unit ?? 'pieces',
        category: item.category ?? 'other',
        expiry_date: expiry,
        location: 'fridge',
        added_via: 'manual',
      },
      token,
    );

    if (response.statusCode !== 201) {
      throw new Error(`Pantry seed failed for "${item.name}" (${response.statusCode}): ${response.body}`);
    }

    ids.push((response.json() as { data: { id: string } }).data.id);
  }

  return ids;
}

/** Unwrap the `{ data }` envelope, or throw with the body for a useful failure. */
export function data<T>(response: TestResponse): T {
  const payload = response.json() as { data?: T };
  if (payload.data === undefined) {
    throw new Error(`No "data" in response (${response.statusCode}): ${response.body}`);
  }
  return payload.data;
}

/** Delete every row belonging to a user, so a suite can re-run cleanly. */
export async function purgeUser(userId: string): Promise<void> {
  const { users } = await import('../../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  try {
    await getDb().delete(users).where(eq(users.id, userId));
  } catch {
    // A failed cleanup must not fail the test that already passed.
  }
}
