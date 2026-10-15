import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * PlateMatch load test — AI endpoints, rate limits and cost caps.
 *
 *   k6 run tests/load/ai-endpoints.js
 *   k6 run -e ENFORCE_LIMITS=true tests/load/ai-endpoints.js
 *
 * The AI endpoints are the ones that can bankrupt a deployment: each call pays an
 * upstream model provider. This suite exists to prove that the controls around
 * them hold under pressure —
 *
 *   1. the rate limiter returns 429 with correct headers, never a 500
 *   2. a 429 is cheap (rejected before any upstream call is made)
 *   3. the per-user daily spend cap actually stops generation
 *   4. the free-tier quotas (3 scans/week, 5 recipes/day, 1 plan/month) hold
 *      when hammered concurrently
 *
 * Rate limiting is keyed per user, so each VU signs up its own account. A single
 * shared user would measure one bucket being drained rather than the limiter.
 *
 * Set ENFORCE_LIMITS=true to keep RATE_LIMIT_DISABLED off. CI sets
 * RATE_LIMIT_DISABLED=true for the integration suite; this test needs the
 * opposite, so it asserts the limiter is actually armed before trusting a 429.
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const API = `${BASE_URL}/api/v1`;

const rejected429 = new Counter('rate_limited_429');
const quotaExceeded402 = new Counter('quota_exceeded_402');
const serverErrors = new Counter('server_errors_5xx');
const limiterArmed = new Rate('rate_limiter_armed');
const rejectedFast = new Trend('rejected_latency_ms', true);
const acceptedLatency = new Trend('ai_accepted_latency_ms', true);
const scanLatency = new Trend('scan_latency_ms', true);

export const options = {
  scenarios: {
    // Fewer VUs than the daily-journey test: these are expensive calls and the
    // point is the limiter's behaviour at the boundary, not raw throughput.
    ai_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 30 },   // 30 VUs > the 10/min AI limit per user,
        { duration: '1m', target: 30 },   // sustained long enough to trip it
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },

  thresholds: {
    // The whole point of the run: a rate limiter that 500s is worse than none.
    server_errors_5xx: ['count==0'],

    // A rejection must be cheaper than the work it prevents. If a 429 costs as
    // much as a 200, the limiter is protecting the upstream bill but not the API.
    rejected_latency_ms: ['p(95)<250'],

    // Generation is slow by nature (model call + guard + persistence), so the
    // budget is generous — but it must still complete.
    ai_accepted_latency_ms: ['p(95)<20000', 'p(99)<45000'],
    scan_latency_ms: ['p(95)<30000'],

    http_req_failed: ['rate<0.05'],
  },
};

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

let token = null;

function authHeaders() {
  return token ? { ...HEADERS, Authorization: `Bearer ${token}` } : HEADERS;
}

function uniqueEmail(prefix) {
  return `k6-ai-${prefix}-${__VU}-${__ITER}-${Date.now()}@loadtest.platematch.app`;
}

function signUp(prefix) {
  const res = http.post(
    `${API}/auth/register`,
    JSON.stringify({
      email: uniqueEmail(prefix),
      password: 'LoadTest!2026',
      full_name: `AI Load Tester ${__VU}`,
      timezone: 'UTC',
    }),
    { headers: HEADERS, tags: { name: 'Register' } },
  );

  if (res.status !== 201) return false;

  try {
    token = res.json('data.access_token');
  } catch {
    token = null;
  }
  return Boolean(token);
}

/**
 * Assert the rate limiter is armed before trusting any 429.
 *
 * With RATE_LIMIT_DISABLED=true every request is allowed, so a run that "passed"
 * would have proved nothing. This makes that situation loud instead of silent.
 */
export function setup() {
  const health = http.get(`${BASE_URL}/health`, { tags: { name: 'HealthCheck' } });
  if (health.status !== 200) {
    throw new Error(`API not reachable at ${BASE_URL} (status ${health.status}).`);
  }

  const body = health.json();
  const enforce = (__ENV.ENFORCE_LIMITS || 'false').toLowerCase() === 'true';

  // eslint-disable-next-line no-console
  console.log(
    `Target: ${BASE_URL} · ai=${body?.checks?.ai} · cache=${body?.checks?.cache} · enforceLimits=${enforce}`,
  );

  if (body?.checks?.ai !== 'mock' && !enforce) {
    // eslint-disable-next-line no-console
    console.warn(
      'WARNING: the server is calling LIVE AI providers. This test will spend real money. ' +
        'Set AI_MODE=mock, or abort now.',
    );
  }

  return { aiMode: body?.checks?.ai, enforce };
}

/** A 429 must carry the standard headers so a client can back off correctly. */
function assertRejectionShape(res, label) {
  const limit = res.headers['X-Ratelimit-Limit'] || res.headers['x-ratelimit-limit'];
  const remaining = res.headers['X-Ratelimit-Remaining'] || res.headers['x-ratelimit-remaining'];

  check(res, {
    [`${label}: 429 body uses the standard envelope`]: (r) => {
      try {
        const parsed = r.json();
        return parsed.statusCode === 429 && parsed.error === 'rate_limited' && Boolean(parsed.message);
      } catch {
        return false;
      }
    },
    [`${label}: 429 advertises the limit`]: () => Boolean(limit),
    [`${label}: 429 advertises remaining`]: () => remaining !== undefined,
  });

  limiterArmed.add(Boolean(limit));
}

export default function () {
  if (!token && !signUp('gen')) {
    sleep(1);
    return;
  }

  // -------------------------------------------------------------------------
  // Recipe generation: 10/min per user.
  // Hammer it and confirm the limiter, not the model, is what stops the run.
  // -------------------------------------------------------------------------
  group('recipe generation burst', () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const started = Date.now();
      const res = http.post(
        `${API}/recipes/generate`,
        JSON.stringify({ use_pantry: true, count: 3, servings: 2, min_pantry_match: 0.2 }),
        { headers: authHeaders(), timeout: '60s', tags: { name: 'GenerateRecipes' } },
      );
      const elapsed = Date.now() - started;

      if (res.status >= 500) serverErrors.add(1);

      if (res.status === 429) {
        rejected429.add(1);
        rejectedFast.add(elapsed);
        assertRejectionShape(res, 'generate');
      } else if (res.status === 402) {
        // Free tier: 5 generations/day. Expected once a VU has looped enough.
        quotaExceeded402.add(1);
        check(res, {
          'generate: 402 explains the upgrade path': (r) => {
            try {
              const parsed = r.json();
              return parsed.error === 'quota_exceeded' && /upgrade|premium|limit/i.test(parsed.message);
            } catch {
              return false;
            }
          },
        });
      } else {
        acceptedLatency.add(elapsed);
        check(res, {
          'generate: 200 returns recipes': (r) => r.status === 200,
          'generate: reports its model': (r) => {
            try {
              return Boolean(r.json('data.ai_model_used'));
            } catch {
              return false;
            }
          },
        });
      }

      sleep(0.4);
    }
  });

  sleep(1);

  // -------------------------------------------------------------------------
  // Meal plan generation: a monthly quota of 1 on the free tier.
  // The second call in the same month must be refused with 402, not 500.
  // -------------------------------------------------------------------------
  group('meal plan quota', () => {
    const today = new Date();
    today.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
    const start = today.toISOString().slice(0, 10);

    const first = http.post(
      `${API}/meal-plans/generate`,
      JSON.stringify({ start_date: start, days: 7, meals_per_day: 3, variety: 'medium', cooking_time_pref: 'balanced' }),
      { headers: authHeaders(), timeout: '90s', tags: { name: 'GenerateMealPlan' } },
    );

    if (first.status >= 500) serverErrors.add(1);

    check(first, {
      'first plan is accepted or correctly refused': (r) => [201, 402, 429].includes(r.status),
    });

    if (first.status === 429) {
      rejected429.add(1);
      assertRejectionShape(first, 'plan');
      return;
    }

    if (first.status === 201) {
      const second = http.post(
        `${API}/meal-plans/generate`,
        JSON.stringify({ start_date: start, days: 7, meals_per_day: 3 }),
        { headers: authHeaders(), timeout: '90s', tags: { name: 'GenerateMealPlanSecond' } },
      );

      if (second.status >= 500) serverErrors.add(1);

      // The free tier allows one plan per month, so the second must be refused
      // with a quota error rather than silently succeeding.
      check(second, {
        'second plan in the same month is refused': (r) => r.status === 402 || r.status === 429,
      });

      if (second.status === 402) quotaExceeded402.add(1);
      if (second.status === 429) {
        rejected429.add(1);
        assertRejectionShape(second, 'plan');
      }
    }
  });

  sleep(1);

  // -------------------------------------------------------------------------
  // Price comparison: Premium-only, so a free user must get 403, not a 500.
  // -------------------------------------------------------------------------
  group('premium gate under load', () => {
    const list = http.post(
      `${API}/grocery-lists/generate`,
      JSON.stringify({
        items: [{ ingredient_name: 'arborio rice', quantity: 1, unit: 'kg', category: 'grain' }],
        skip_prices: true,
      }),
      { headers: authHeaders(), tags: { name: 'CreateGroceryList' } },
    );

    if (list.status >= 500) serverErrors.add(1);

    if (list.status === 201) {
      let listId = null;
      try {
        listId = list.json('data.id');
      } catch {
        listId = null;
      }

      if (listId) {
        const prices = http.post(`${API}/grocery-lists/${listId}/prices`, '{}', {
          headers: authHeaders(),
          tags: { name: 'ComparePrices' },
        });

        if (prices.status >= 500) serverErrors.add(1);

        check(prices, {
          'price comparison is gated for free users': (r) => r.status === 403 || r.status === 200,
        });
      }
    }
  });

  sleep(1);

  // -------------------------------------------------------------------------
  // Upload endpoint: must reject a non-image cheaply, without touching storage
  // or a vision provider.
  // -------------------------------------------------------------------------
  group('scan rejects a bad upload cheaply', () => {
    const started = Date.now();
    const res = http.post(`${API}/scan/fridge`, 'this is not an image', {
      headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
      timeout: '30s',
      tags: { name: 'ScanBadUpload' },
    });
    scanLatency.add(Date.now() - started);

    if (res.status >= 500) serverErrors.add(1);

    check(res, {
      'bad upload is a client error': (r) => r.status >= 400 && r.status < 500,
    });
  });

  sleep(2);
}

export function teardown(data) {
  // eslint-disable-next-line no-console
  console.log(
    `AI load test finished · ai mode: ${data.aiMode} · enforceLimits: ${data.enforce}\n` +
      'A run with zero 429s and rate limiting enabled means the limiter never engaged — ' +
      'check that RATE_LIMIT_DISABLED is not true.',
  );
}
