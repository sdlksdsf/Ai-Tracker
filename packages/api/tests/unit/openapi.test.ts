import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The generated OpenAPI document.
 *
 * `@fastify/swagger` assembles the spec from an `onRoute` hook, so it only ever
 * sees routes registered *after* it exists. The docs plugin used to be
 * registered last, which produced a document containing three paths — its own
 * `openapi.json` route, the local upload wildcard and the service banner — and
 * none of the real endpoints. `/docs` still rendered and looked complete, and
 * the integration harness boots with `skipDocs: true`, so nothing complained.
 *
 * This builds the app exactly the way `server.ts` does and asserts the document
 * describes the API the README advertises. No database is needed: nothing
 * connects during `ready()`.
 */

interface Operation {
  tags?: string[];
  summary?: string;
  security?: unknown[];
  response?: Record<string, { properties?: Record<string, unknown> }>;
  responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { securitySchemes?: Record<string, unknown> };
}

let app: FastifyInstance | null = null;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    AI_MODE: 'mock',
    STORAGE_DRIVER: 'local',
    LOCAL_UPLOAD_DIR: './uploads-test',
    // The point of this suite: docs must be on.
    ENABLE_SWAGGER: 'true',
    ENABLE_REDIS: 'false',
    ENABLE_CRONS: 'false',
    ENABLE_PUSH: 'false',
    ENABLE_ANALYTICS: 'false',
    RATE_LIMIT_DISABLED: 'true',
    DATABASE_MIGRATE_ON_BOOT: 'false',
    // Syntactically valid, deliberately unreachable — nothing may connect here.
    DATABASE_URL: 'postgresql://platematch@127.0.0.1:1/none',
    JWT_SECRET: 'test-access-secret-0123456789abcdef0123456789abcdef',
    JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789abcdef',
  });

  // `env` is memoised on first import; force it to re-read the values above.
  const { resetEnvCache, loadEnv } = await import('../../src/config/env.js');
  resetEnvCache();
  loadEnv();

  const { buildApp } = await import('../../src/app.js');
  app = await buildApp({ skipDocs: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

/** Every resource group the spec's Section 4 requires, and the tag it uses. */
const RESOURCE_TAGS = [
  'health',
  'auth',
  'users',
  'scan',
  'pantry',
  'recipes',
  'meal-plans',
  'grocery-lists',
  'waste',
  'achievements',
  'notifications',
  'subscription',
  'dashboard',
];

/** Endpoints a client integrates against first; all must be documented. */
const REQUIRED_PATHS: Array<[string, string]> = [
  ['/api/v1/auth/register', 'post'],
  ['/api/v1/auth/login', 'post'],
  ['/api/v1/auth/refresh', 'post'],
  ['/api/v1/users/me', 'get'],
  ['/api/v1/users/me/preferences', 'put'],
  ['/api/v1/scan/fridge', 'post'],
  ['/api/v1/pantry', 'get'],
  ['/api/v1/recipes', 'get'],
  ['/api/v1/recipes/generate', 'post'],
  ['/api/v1/meal-plans', 'get'],
  ['/api/v1/meal-plans/generate', 'post'],
  ['/api/v1/meal-plans/week', 'get'],
  ['/api/v1/grocery-lists', 'get'],
  ['/api/v1/waste', 'get'],
  ['/api/v1/achievements/progress', 'get'],
  ['/api/v1/notifications/preferences', 'get'],
  ['/api/v1/subscription/status', 'get'],
  ['/api/v1/dashboard', 'get'],
];

describe('OpenAPI document', () => {
  it('is a 3.1 document that actually describes the API', () => {
    const doc = app!.swagger() as OpenApiDocument;

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('PlateMatch API');

    // Three paths was the broken number. The real API is an order of magnitude
    // larger, so assert a floor that a registration-order regression cannot hit.
    expect(Object.keys(doc.paths).length).toBeGreaterThan(80);
  });

  it('documents every resource group', () => {
    const doc = app!.swagger() as OpenApiDocument;

    const operationsPerTag = new Map<string, number>();
    for (const operations of Object.values(doc.paths)) {
      for (const operation of Object.values(operations)) {
        for (const tag of operation.tags ?? []) {
          operationsPerTag.set(tag, (operationsPerTag.get(tag) ?? 0) + 1);
        }
      }
    }

    for (const tag of RESOURCE_TAGS) {
      expect(operationsPerTag.get(tag) ?? 0, `no documented operations tagged "${tag}"`).toBeGreaterThan(0);
    }
  });

  it('documents the endpoints a client integrates against first', () => {
    const doc = app!.swagger() as OpenApiDocument;

    for (const [path, method] of REQUIRED_PATHS) {
      expect(doc.paths[path], `${path} is not documented`).toBeTruthy();
      expect(doc.paths[path]?.[method], `${method.toUpperCase()} ${path} is not documented`).toBeTruthy();
    }
  });

  it('declares bearer auth and the error envelope', () => {
    const doc = app!.swagger() as OpenApiDocument & {
      components?: { securitySchemes?: Record<string, { type: string; scheme: string }>; schemas?: Record<string, unknown> };
    };

    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.components?.schemas?.ApiError).toBeTruthy();
    expect(doc.components?.schemas?.PaginationMeta).toBeTruthy();
  });

  it('documents the { data, meta } envelope on paginated list endpoints', () => {
    const doc = app!.swagger() as OpenApiDocument;

    // These five each invented their own pagination shape before the envelope
    // was normalised; the document is where a client would notice.
    for (const path of ['/api/v1/recipes', '/api/v1/meal-plans', '/api/v1/grocery-lists', '/api/v1/recipes/favorites', '/api/v1/recipes/history']) {
      const operation = doc.paths[path]?.get;
      expect(operation, `GET ${path} is not documented`).toBeTruthy();

      const schema = operation?.response?.[200]?.properties ?? operation?.responses?.[200]?.content?.['application/json']?.schema?.properties;
      expect(schema, `GET ${path} has no documented 200 schema`).toBeTruthy();
      expect(Object.keys(schema ?? {}), `GET ${path} should document { data, meta }`).toEqual(['data', 'meta']);
    }
  });

  it('serves the document at /docs/json and /api/v1/openapi.json', async () => {
    for (const url of ['/docs/json', '/api/v1/openapi.json']) {
      const response = await app!.inject({ method: 'GET', url });

      expect(response.statusCode, url).toBe(200);
      const body = response.json() as OpenApiDocument;
      expect(body.openapi).toBe('3.1.0');
      expect(Object.keys(body.paths).length).toBeGreaterThan(80);
    }
  });
});
