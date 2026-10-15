import { describe, expect, it } from 'vitest';
import { generalRateLimitOptions, isOperationallyExempt, resolveAllowList, rateLimits } from '../../src/lib/ratelimit.js';

/**
 * The rate limiter's allow-list.
 *
 * `RATE_LIMIT_DISABLED` used to do nothing. `generalRateLimitOptions()` installed
 * `allowList: () => true` for it, and the plugin then spread its *own* allow-list
 * after that — so the operational one won, the flag only produced a warning that
 * claimed rate limiting was off, and limiting continued at full strength.
 *
 * That was invisible until CI ran the integration suite with Redis enabled, which
 * made the counter shared and persistent: the pantry-quota seed, which deliberately
 * writes past the free-tier cap, tripped the 100/min general limit and failed with
 * a 429 in a job configured to have no rate limiting at all.
 */

describe('isOperationallyExempt', () => {
  it('exempts the health probes — a 429 on liveness takes a healthy container out of rotation', () => {
    for (const url of ['/health', '/health/live', '/health/ready']) {
      expect(isOperationallyExempt(url), url).toBe(true);
    }
  });

  it('exempts the Stripe webhook — a rejected webhook silently desyncs billing', () => {
    expect(isOperationallyExempt('/api/v1/subscription/webhook')).toBe(true);
  });

  it('exempts the docs UI and its assets', () => {
    for (const url of ['/docs', '/docs/json', '/docs/static/swagger-ui.css']) {
      expect(isOperationallyExempt(url), url).toBe(true);
    }
  });

  it('does not exempt /metrics, which is cheap to serve but worth throttling', () => {
    expect(isOperationallyExempt('/metrics')).toBe(false);
  });

  it('does not exempt ordinary API traffic', () => {
    for (const url of ['/api/v1/pantry', '/api/v1/recipes', '/api/v1/scan/fridge', '/']) {
      expect(isOperationallyExempt(url), url).toBe(false);
    }
  });

  it('ignores the query string', () => {
    expect(isOperationallyExempt('/health?ts=1')).toBe(true);
    expect(isOperationallyExempt('/api/v1/pantry?page=1&limit=20')).toBe(false);
  });

  it('is not fooled by a path that merely contains an exempt segment', () => {
    expect(isOperationallyExempt('/api/v1/health')).toBe(false);
    expect(isOperationallyExempt('/api/v1/docs')).toBe(false);
  });
});

describe('resolveAllowList', () => {
  it('allows everything when rate limiting is disabled', () => {
    const allowList = resolveAllowList(true);

    for (const url of ['/api/v1/pantry', '/api/v1/recipes/generate', '/api/v1/scan/fridge', '/metrics', '/']) {
      expect(allowList(url), url).toBe(true);
    }
  });

  it('falls back to the operational exemptions when rate limiting is on', () => {
    const allowList = resolveAllowList(false);

    expect(allowList('/health')).toBe(true);
    expect(allowList('/api/v1/subscription/webhook')).toBe(true);
    expect(allowList('/docs/json')).toBe(true);
    expect(allowList('/api/v1/pantry')).toBe(false);
    expect(allowList('/metrics')).toBe(false);
  });

  it('agrees with isOperationallyExempt for every path when enabled', () => {
    const allowList = resolveAllowList(false);
    const urls = ['/health', '/health/live', '/health/ready', '/metrics', '/docs', '/api/v1/subscription/webhook', '/api/v1/pantry', '/'];

    for (const url of urls) {
      expect(allowList(url), url).toBe(isOperationallyExempt(url));
    }
  });
});

describe('generalRateLimitOptions', () => {
  it('does not set an allow-list, so nothing can be silently overwritten', () => {
    // The whole bug was two places assigning the same option and a spread
    // deciding the winner. There is now exactly one.
    expect(generalRateLimitOptions().allowList).toBeUndefined();
  });

  it('keeps the documented limits', () => {
    const options = generalRateLimitOptions();

    expect(options.global).toBe(true);
    expect(options.timeWindow).toBe('1 minute');
    expect(typeof options.max).toBe('number');
    expect(options.skipOnError ?? false).toBe(false);
  });

  it('keeps the AI and scan limits tighter than the general one', () => {
    const general = generalRateLimitOptions().max as number;
    const ai = rateLimits.ai().max as number;
    const scan = rateLimits.scan().max as number;

    expect(ai).toBeLessThan(general);
    expect(scan).toBeLessThan(ai);
  });
});
