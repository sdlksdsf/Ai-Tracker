import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * PlateMatch load test — the daily-use journey.
 *
 *   k6 run tests/load/daily-journey.js
 *   k6 run -e BASE_URL=https://api.yourdomain.com tests/load/daily-journey.js
 *
 * Models what a real user does in a session: sign in, load Home, browse the
 * pantry, open a recipe, check the plan. Read-heavy, exactly like production —
 * which is why the read endpoints carry a far stricter latency budget than the
 * writes.
 *
 * Thresholds are assertions, not aspirations: the run exits non-zero when one is
 * breached, so this can gate a deploy.
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const API = `${BASE_URL}/api/v1`;

// ---------------------------------------------------------------------------
// Custom metrics, so a regression points at the endpoint rather than "the app".
// ---------------------------------------------------------------------------
const authErrors = new Counter('auth_errors');
const aiRequests = new Counter('ai_requests');
const cacheHits = new Rate('cache_hit_rate');
const homeLatency = new Trend('home_latency_ms', true);
const recipesLatency = new Trend('recipes_latency_ms', true);
const pantryLatency = new Trend('pantry_latency_ms', true);
const writeLatency = new Trend('write_latency_ms', true);

export const options = {
  scenarios: {
    // Ramp to a sustained load, then a spike, so both steady-state and burst
    // behaviour are measured in one run.
    ramping_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 25 },  // warm up: connection pools, JIT
        { duration: '3m', target: 75 },  // steady state
        { duration: '1m', target: 150 }, // spike: everyone opens the app at 6pm
        { duration: '2m', target: 75 },  // recovery
        { duration: '1m', target: 0 },   // drain
      ],
      gracefulRampDown: '30s',
    },
  },

  thresholds: {
    // Reads dominate the traffic and are cacheable, so they are held to a tight
    // budget. p95 < 400ms leaves room for a mobile connection on top.
    home_latency_ms: ['p(95)<400', 'p(99)<900'],
    recipes_latency_ms: ['p(95)<500', 'p(99)<1200'],
    pantry_latency_ms: ['p(95)<400', 'p(99)<900'],

    // Writes hit the database directly and cannot be cached.
    write_latency_ms: ['p(95)<900', 'p(99)<2000'],

    http_req_failed: ['rate<0.01'],        // <1% failed requests
    http_req_duration: ['p(95)<800'],      // overall
    auth_errors: ['count==0'],             // auth must not fail under load
    cache_hit_rate: ['rate>0.5'],          // the read path is supposed to be cached
  },
};

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** One virtual user = one signed-in session, reused across its iterations. */
let sessionToken = null;
let vuSeq = 0;

function uniqueEmail() {
  vuSeq += 1;
  return `k6-${__VU}-${__ITER}-${vuSeq}-${Date.now()}@loadtest.platematch.app`;
}

function authHeaders() {
  return sessionToken ? { ...HEADERS, Authorization: `Bearer ${sessionToken}` } : HEADERS;
}

/**
 * Every VU creates its own account.
 *
 * Sharing one user across 150 VUs would measure lock contention on a single row
 * rather than the API, and every cache key would collide — a benchmark that
 * flatters the system instead of testing it.
 */
function signUp() {
  const res = http.post(
    `${API}/auth/register`,
    JSON.stringify({
      email: uniqueEmail(),
      password: 'LoadTest!2026',
      full_name: `Load Tester ${__VU}`,
      timezone: 'UTC',
      locale: 'en',
    }),
    { headers: HEADERS, tags: { name: 'Register' } },
  );

  const ok = check(res, { 'register succeeded': (r) => r.status === 201 });
  if (!ok) {
    authErrors.add(1);
    return false;
  }

  try {
    sessionToken = res.json('data.access_token');
  } catch {
    sessionToken = null;
  }

  if (!sessionToken) {
    authErrors.add(1);
    return false;
  }

  return true;
}

export function setup() {
  // Fail fast with a clear message rather than 8 minutes of 500s.
  const health = http.get(`${BASE_URL}/health`, { tags: { name: 'HealthCheck' } });

  if (health.status !== 200) {
    throw new Error(`API not reachable at ${BASE_URL} (status ${health.status}). Start it before running the load test.`);
  }

  const body = health.json();
  // eslint-disable-next-line no-console
  console.log(`Target: ${BASE_URL} · status=${body?.status} · ai=${body?.checks?.ai} · cache=${body?.checks?.cache}`);

  return { baseUrl: BASE_URL, aiMode: body?.checks?.ai };
}

export default function () {
  if (!sessionToken && !signUp()) {
    sleep(1);
    return;
  }

  group('home', () => {
    const started = Date.now();
    const res = http.get(`${API}/dashboard/home`, { headers: authHeaders(), tags: { name: 'DashboardHome' } });
    homeLatency.add(Date.now() - started);

    const etag = res.headers['Etag'] || res.headers['etag'];
    cacheHits.add(Boolean(etag) || res.status === 304);

    check(res, {
      'home is 200': (r) => r.status === 200,
      'home has a payload': (r) => (r.body || '').length > 50,
    });
  });

  sleep(1);

  group('pantry', () => {
    const started = Date.now();
    const res = http.get(`${API}/pantry?page=1&limit=50`, { headers: authHeaders(), tags: { name: 'ListPantry' } });
    pantryLatency.add(Date.now() - started);

    check(res, { 'pantry list is 200': (r) => r.status === 200 });
  });

  sleep(0.5);

  group('add pantry item', () => {
    const started = Date.now();
    const res = http.post(
      `${API}/pantry`,
      JSON.stringify({
        ingredient_name: `load test item ${__VU}-${__ITER}`,
        quantity: 200,
        unit: 'g',
        category: 'vegetable',
        location: 'fridge',
        added_via: 'manual',
      }),
      { headers: authHeaders(), tags: { name: 'CreatePantryItem' } },
    );
    writeLatency.add(Date.now() - started);

    check(res, {
      'pantry write is 201': (r) => r.status === 201,
      // A 402 here means the free-tier cap (50 items) was hit — expected late in
      // a long run, and worth seeing explicitly rather than as a mystery failure.
      'pantry write is not a server error': (r) => r.status < 500,
    });
  });

  sleep(1);

  group('browse recipes', () => {
    const started = Date.now();
    const res = http.get(`${API}/recipes?page=1&limit=20&sort=best_match`, {
      headers: authHeaders(),
      tags: { name: 'SearchRecipes' },
    });
    recipesLatency.add(Date.now() - started);

    check(res, { 'recipe search is 200': (r) => r.status === 200 });
  });

  sleep(1);

  group('week overview', () => {
    const res = http.get(`${API}/meal-plans/week`, { headers: authHeaders(), tags: { name: 'WeekOverview' } });
    check(res, { 'week overview is 200': (r) => r.status === 200 });
  });

  sleep(0.5);

  group('stats and impact', () => {
    const responses = http.batch([
      ['GET', `${API}/waste/stats?period=week`, { headers: authHeaders(), tags: { name: 'WasteStats' } }],
      ['GET', `${API}/waste/impact`, { headers: authHeaders(), tags: { name: 'WasteImpact' } }],
      ['GET', `${API}/achievements/progress`, { headers: authHeaders(), tags: { name: 'Achievements' } }],
      ['GET', `${API}/dashboard/savings?period=month`, { headers: authHeaders(), tags: { name: 'Savings' } }],
    ]);

    check(responses, {
      'waste stats is 200': (r) => r[0].status === 200,
      'waste impact is 200': (r) => r[1].status === 200,
      'achievements is 200': (r) => r[2].status === 200,
      'savings is 200': (r) => r[3].status === 200,
    });
  });

  // Think time. Without it, k6 measures the server's ability to absorb a
  // denial-of-service rather than a realistic user population.
  sleep(2 + Math.random() * 3);
}

export function teardown(data) {
  // eslint-disable-next-line no-console
  console.log(`Load test finished against ${data.baseUrl} (ai mode: ${data.aiMode}).`);
}
