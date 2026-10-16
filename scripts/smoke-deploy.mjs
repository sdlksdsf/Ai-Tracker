#!/usr/bin/env node
/**
 * Post-deploy smoke test — checks a RUNNING deployment from the outside.
 *
 *   node scripts/smoke-deploy.mjs --api https://platematch-api.onrender.com --web https://platematch.vercel.app
 *   node scripts/smoke-deploy.mjs --api http://localhost:10000 --origin https://platematch.vercel.app
 *
 *   --api URL       the API (Render) — required
 *   --web URL       the website (Vercel) — checks the site and that it points at --api
 *   --origin URL    origin to test CORS with (defaults to --web)
 *   --full          also create, use and delete a throwaway account
 *   --wait SECONDS  how long to wait for a sleeping free instance to wake (default 150)
 *
 * No dependencies; Node 22+. Exits 1 if any check fails. Also runs as the
 * "Deploy check" GitHub Action (.github/workflows/deploy-check.yml), so it can
 * be used without installing anything locally.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

const clean = (value) =>
  value
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/, '');
const API = clean(option('api'));
const WEB = clean(option('web'));
const ORIGIN = clean(option('origin')) ?? (WEB ? new URL(WEB).origin : undefined);
const WAIT_S = Number(option('wait') ?? 150);

if (!API) {
  console.error(
    'Usage: node scripts/smoke-deploy.mjs --api <api url> [--web <website url>] [--origin <url>] [--full]',
  );
  process.exit(2);
}

let failures = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (msg, fix) => {
  failures += 1;
  console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ''}`);
};

async function get(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000), ...init });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

// ---------------------------------------------------------------------------
console.log(`\nAPI  ${API}`);
// ---------------------------------------------------------------------------

// 1. Liveness — a free Render instance may be asleep and take ~1 minute to wake.
{
  const started = Date.now();
  let alive = false;
  let notified = false;
  let lastError = '';
  while (Date.now() - started < WAIT_S * 1000) {
    try {
      const r = await get(`${API}/health/live`);
      if (r.status === 200 && r.json?.status === 'alive') {
        alive = true;
        break;
      }
      lastError = `HTTP ${r.status}`;
    } catch (err) {
      lastError = err.cause?.code ?? err.message;
    }
    if (!notified) {
      console.log('  … waiting for the API to wake up (free instances sleep after 15 idle minutes)');
      notified = true;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (alive) pass(`/health/live answers (${Math.round((Date.now() - started) / 1000)}s)`);
  else
    fail(
      `/health/live did not answer within ${WAIT_S}s (${lastError})`,
      'Open the service in Render → Logs: is the deploy "Live", or did it stop with an error?',
    );
}

// 2. Readiness — database and Redis really reachable.
{
  try {
    const r = await get(`${API}/health/ready`);
    const body = r.json ?? {};
    if (body.database === 'ok') pass('database (Neon) reachable');
    else
      fail(
        `database is "${body.database ?? 'unknown'}"`,
        'Check DATABASE_URL on Render (Neon → Connect → connection string).',
      );
    if (body.cache === 'redis') pass('Redis (Upstash) reachable');
    else if (body.cache === 'memory')
      warn(
        'Redis is switched off (ENABLE_REDIS=false) — fine for one instance, but rate limits are per-instance',
      );
    else
      fail(
        `Redis is "${body.cache ?? 'unknown'}"`,
        'Check REDIS_URL on Render: it must be the rediss:// URL from Upstash, password included.',
      );
  } catch (err) {
    fail(`/health/ready failed: ${err.message}`);
  }
}

// 3. Storage driver — uploads must not go to the instance's throwaway disk.
{
  try {
    const r = await get(`${API}/health`);
    const storage = r.json?.checks?.storage;
    if (storage === 'cloudinary') pass('uploads go to Cloudinary');
    else if (storage === 's3') pass('uploads go to S3-compatible storage');
    else fail(`uploads go to "${storage}"`, 'Set STORAGE_DRIVER=cloudinary and CLOUDINARY_URL on Render.');
    if (r.json?.checks?.queue) pass(`background jobs: ${r.json.checks.queue}`);
  } catch (err) {
    fail(`/health failed: ${err.message}`);
  }
}

// 4. CORS — the website may call the API; other websites may not.
if (ORIGIN) {
  const preflight = (origin) =>
    get(`${API}/api/v1/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
  try {
    const allowed = await preflight(ORIGIN);
    const acao = allowed.headers.get('access-control-allow-origin');
    if (acao === ORIGIN || acao === '*') pass(`CORS allows ${ORIGIN}`);
    else
      fail(
        `CORS blocks ${ORIGIN}`,
        `On Render → Environment, set CORS_ORIGINS to ${ORIGIN} (exactly, no trailing slash), then save and redeploy.`,
      );

    const stranger = await preflight('https://not-your-site.example');
    const leaked = stranger.headers.get('access-control-allow-origin');
    if (!leaked) pass('CORS blocks other websites');
    else warn(`CORS allows any website (${leaked}) — set CORS_ORIGINS to your site only`);
  } catch (err) {
    fail(`CORS check failed: ${err.message}`);
  }
} else {
  warn('no --web/--origin given — CORS not checked');
}

// 5. Optional end-to-end account round trip.
if (flag('full')) {
  const email = `smoke-${Date.now()}@example.com`;
  const password = `Smoke-${Math.random().toString(36).slice(2)}-Aa1!`;
  const headers = { 'content-type': 'application/json', ...(ORIGIN ? { Origin: ORIGIN } : {}) };
  try {
    const reg = await get(`${API}/api/v1/auth/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password, full_name: 'Smoke Test' }),
    });
    const token = reg.json?.data?.access_token;
    if (reg.status === 201 && token) pass('register works (database writes OK)');
    else fail(`register returned HTTP ${reg.status}: ${reg.json?.message ?? reg.text.slice(0, 120)}`);

    if (token) {
      const me = await get(`${API}/api/v1/users/me`, {
        headers: { ...headers, authorization: `Bearer ${token}` },
      });
      if (me.status === 200 && me.json?.data?.email === email)
        pass('sign-in token accepted (JWT secrets OK)');
      else fail(`/users/me returned HTTP ${me.status}`);

      const del = await get(`${API}/api/v1/users/me`, {
        method: 'DELETE',
        headers: { ...headers, authorization: `Bearer ${token}` },
      });
      if (del.status === 204 || del.status === 200) pass('throwaway account deleted');
      else warn(`could not delete the throwaway account ${email} (HTTP ${del.status})`);
    }
  } catch (err) {
    fail(`account round trip failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
if (WEB) {
  console.log(`\nWEB  ${WEB}`);
  let bundlePath;
  try {
    const home = await get(`${WEB}/`);
    bundlePath = /src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/.exec(home.text)?.[1];
    if (home.status === 200 && home.text.includes('id="root"') && bundlePath) pass('site loads');
    else
      fail(
        `site returned HTTP ${home.status}${bundlePath ? '' : ' without the app bundle'}`,
        'Open Vercel → Deployments → the latest build log.',
      );

    if (home.headers.get('x-content-type-options') === 'nosniff')
      pass('security headers from vercel.json are applied');
    else warn('security headers missing — is the Vercel Root Directory set to apps/mobile?');

    const deep = await get(`${WEB}/recipe/deep-link-check`);
    if (deep.status === 200 && deep.text.includes('id="root"'))
      pass('deep links load (refreshing any page works)');
    else
      fail(
        `a deep link returned HTTP ${deep.status}`,
        'The rewrite in apps/mobile/vercel.json is not active — check the Root Directory setting.',
      );
  } catch (err) {
    fail(`could not load the site: ${err.message}`);
  }

  if (bundlePath) {
    try {
      const bundle = await get(`${WEB}${bundlePath}`);
      const apiOrigin = new URL(API).origin;
      if (bundle.text.includes(apiOrigin)) pass(`site is built to call ${apiOrigin}`);
      else
        fail(
          `the site was NOT built with ${apiOrigin}`,
          `Vercel → Settings → Environment Variables: EXPO_PUBLIC_API_URL = ${apiOrigin}, then Deployments → Redeploy (it is baked in at build time).`,
        );
    } catch (err) {
      fail(`could not read the app bundle: ${err.message}`);
    }
  }
}

console.log(failures ? `\n✖ ${failures} check(s) failed.\n` : '\n✔ Deployment looks healthy.\n');
process.exit(failures ? 1 : 0);
