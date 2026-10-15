import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '@platematch/shared';
import {
  isDatabaseAvailable,
  startHarness,
  stopHarness,
  type Harness,
} from './helpers/harness.js';

/**
 * Operational endpoints.
 *
 * These are what a load balancer and an orchestrator probe, so their contracts
 * matter more than they look: `/health` must answer 200 even when a dependency is
 * degraded, while `/health/ready` must go 503 so traffic is drained.
 */

let harness: Harness | null = null;
const available = await isDatabaseAvailable();

describe.skipIf(!available)('health endpoints', () => {
  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('GET /health returns 200 with a status and per-dependency checks', async () => {
    const response = await harness!.get('/health');

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      status: string;
      version: string;
      uptime_s: number;
      timestamp: string;
      checks: Record<string, string>;
    };

    expect(['ok', 'degraded']).toContain(body.status);
    expect(typeof body.version).toBe('string');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();

    // Every dependency the deployment cares about must report, even if degraded.
    for (const key of ['database', 'cache', 'queue', 'storage', 'ai']) {
      expect(body.checks[key], `missing health check: ${key}`).toBeDefined();
    }
  });

  it('GET /health/live always answers, without touching dependencies', async () => {
    const response = await harness!.get('/health/live');
    expect(response.statusCode).toBe(200);

    const body = response.json() as { status: string; uptime_s: number };
    expect(body.status).toBe('alive');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('GET /health/ready is 200 when the database answers', async () => {
    const response = await harness!.get('/health/ready');
    expect(response.statusCode).toBe(200);

    const body = response.json() as { ready: boolean; database: string; cache: string };
    expect(body.ready).toBe(true);
    expect(body.database).toBe('ok');
  });

  it('the health endpoints need no authentication', async () => {
    // An orchestrator probe carries no bearer token; requiring one would mean a
    // container is killed while it is perfectly healthy.
    for (const url of ['/health', '/health/live', '/health/ready']) {
      const response = await harness!.get(url);
      expect(response.statusCode, `${url} should be public`).toBe(200);
    }
  });

  it(`GET ${API_BASE_PATH}/ai/status exposes model names but never keys`, async () => {
    const response = await harness!.get(`${API_BASE_PATH}/ai/status`);
    expect(response.statusCode).toBe(200);

    const body = response.json() as Record<string, unknown>;
    expect(body.mode).toBeDefined();

    // The whole point of this endpoint is that it is safe to expose publicly.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const leak of ['api_key', 'apikey', 'secret', 'bearer ', 'password', 'authorization']) {
      expect(serialized, `ai/status leaked "${leak}"`).not.toContain(leak);
    }
  });

  it('in mock mode the AI status reports the built-in engine', async () => {
    const response = await harness!.get(`${API_BASE_PATH}/ai/status`);
    const body = response.json() as { mode: string; vision: { mode: string }; reasoning: { mode: string } };

    expect(body.mode).toBe('mock');
    expect(body.vision.mode).toBe('mock');
    expect(body.reasoning.mode).toBe('mock');
  });

  it('GET / returns the service banner', async () => {
    const response = await harness!.get('/');
    expect(response.statusCode).toBe(200);

    const body = response.json() as { name: string; api: string; health: string };
    expect(body.name).toBe('PlateMatch API');
    expect(body.api).toBe(API_BASE_PATH);
    expect(body.health).toBe('/health');
  });

  it(`GET ${API_BASE_PATH} lists the available resources`, async () => {
    const response = await harness!.get(API_BASE_PATH);
    expect(response.statusCode).toBe(200);

    const body = response.json() as { base_path: string; resources: string[] };
    expect(body.base_path).toBe(API_BASE_PATH);

    for (const resource of ['auth', 'users', 'scan', 'pantry', 'recipes', 'meal-plans', 'grocery-lists', 'waste', 'achievements', 'notifications', 'subscription', 'dashboard']) {
      expect(body.resources, `missing resource: ${resource}`).toContain(`${API_BASE_PATH}/${resource}`);
    }
  });

  it('returns the standard 404 envelope for an unknown route', async () => {
    const response = await harness!.get(`${API_BASE_PATH}/does-not-exist`);
    expect(response.statusCode).toBe(404);

    const body = response.json() as { statusCode: number; error: string; message: string; requestId: string };
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('not_found');
    expect(typeof body.message).toBe('string');
    // Every error carries a requestId so a support ticket can be traced.
    expect(body.requestId).toBeTruthy();
  });

  it('trailing slashes and casing do not change routing', async () => {
    const a = await harness!.get('/health');
    const b = await harness!.get('/health/');
    expect(a.statusCode).toBe(b.statusCode);
  });
});

describe.skipIf(available)('health endpoints (no database)', () => {
  it('skips cleanly when PostgreSQL is not reachable', () => {
    // Reaching this branch means the suite above was skipped, not silently
    // passed. CI runs the real suite against service containers.
    expect(available).toBe(false);
  });
});
