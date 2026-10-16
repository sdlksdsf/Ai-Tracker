#!/usr/bin/env node
/**
 * Static checks for the deployment configuration (render.yaml + Vercel).
 *
 *   node scripts/check-deploy-config.mjs                 # fetches Render's schema
 *   node scripts/check-deploy-config.mjs --schema f.json # offline, local schema copy
 *
 * Catches, before a deploy does:
 *   • render.yaml that Render's own JSON schema rejects (an unquoted `true`, a
 *     region that does not exist, a misspelled field)
 *   • an env var in render.yaml the API never reads (a typo such as QUEUE_DRIVERS
 *     is silently ignored at runtime) — every key must be documented in .env.example
 *   • a start command, health-check path or build script that does not exist
 *   • vercel.json drifting from what the Expo web export produces
 *
 * Exits 1 on any problem.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const problems = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const check = (condition, msg, detail = '') => {
  if (condition) ok(msg);
  else problems.push(detail ? `${msg} — ${detail}` : msg);
};

// ---------------------------------------------------------------------------
// render.yaml
// ---------------------------------------------------------------------------
console.log('render.yaml');
const blueprint = YAML.parse(read('render.yaml'));

const schemaArg = process.argv.indexOf('--schema');
let schema = null;
if (schemaArg > -1) {
  schema = JSON.parse(readFileSync(process.argv[schemaArg + 1], 'utf8'));
} else {
  // A render.com outage must not turn every CI run red; the other checks still run.
  try {
    const res = await fetch('https://render.com/schema/render.yaml.json', {
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) schema = await res.json();
    else console.warn(`  ! could not download Render's schema (HTTP ${res.status}) — schema check skipped`);
  } catch (err) {
    console.warn(`  ! could not download Render's schema (${err.message}) — schema check skipped`);
  }
}
// In GitHub Actions, say visibly whether the schema check really ran.
const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level} title=render.yaml::${message}`);
};
if (schema) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(schema);
  const valid = validate(blueprint);
  check(
    valid,
    "matches Render's Blueprint schema",
    JSON.stringify((validate.errors ?? []).filter((e) => !e.schemaPath.includes('anyOf')).slice(0, 5)),
  );
  if (valid)
    annotate(
      'notice',
      `Validated against Render's Blueprint schema (${schemaArg > -1 ? 'local copy' : 'downloaded from render.com'})`,
    );
} else {
  annotate(
    'warning',
    "Render's schema could not be downloaded — render.yaml was NOT schema-validated in this run",
  );
}

const api = blueprint.services?.find((s) => s.type === 'web');
check(Boolean(api), 'declares a web service for the API');

if (api) {
  const documented = new Set(
    read('.env.example')
      .split('\n')
      .map((line) => /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line)?.[1])
      .filter(Boolean),
  );
  documented.add('NODE_VERSION'); // read by Render itself, not by the API
  const keys = (api.envVars ?? []).map((v) => v.key).filter(Boolean);
  const unknown = keys.filter((k) => !documented.has(k));
  check(
    unknown.length === 0,
    `all ${keys.length} env vars are ones the API reads`,
    `not in .env.example: ${unknown.join(', ')}`,
  );

  const secrets = [
    'DATABASE_URL',
    'REDIS_URL',
    'CLOUDINARY_URL',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'SEED_DEMO_PASSWORD',
  ];
  const leaked = (api.envVars ?? []).filter((v) => secrets.includes(v.key) && 'value' in v).map((v) => v.key);
  check(leaked.length === 0, 'no secret has a value written in the file', `hard-coded: ${leaked.join(', ')}`);

  const startFile = /node\s+(\S+\.js)/.exec(api.startCommand ?? '')?.[1];
  const tsup = read('packages/api/tsup.config.ts');
  const entry = startFile ? path.basename(startFile, '.js') : '';
  check(
    Boolean(startFile) &&
      startFile.startsWith('packages/api/dist/') &&
      new RegExp(`\\b${entry}:\\s*'src/`).test(tsup),
    `startCommand runs a file the build emits (${startFile})`,
  );
  check(
    /npm ci --include=dev/.test(api.buildCommand ?? ''),
    'buildCommand installs devDependencies (tsup) even with NODE_ENV=production',
  );

  const healthRoutes = read('packages/api/src/routes/health.routes.ts');
  check(
    Boolean(api.healthCheckPath) && healthRoutes.includes(`'${api.healthCheckPath}'`),
    `healthCheckPath ${api.healthCheckPath} is a real route`,
  );
}

// ---------------------------------------------------------------------------
// Vercel (apps/mobile)
// ---------------------------------------------------------------------------
console.log('apps/mobile/vercel.json');
const vercel = JSON.parse(read('apps/mobile/vercel.json'));
const mobilePkg = JSON.parse(read('apps/mobile/package.json'));
const appJson = JSON.parse(read('apps/mobile/app.json'));

check(vercel.framework === null, 'framework is null (Expo is not a Vercel preset)');
check(vercel.outputDirectory === 'dist', 'outputDirectory is dist (where `expo export` writes)');
const buildScript = /^npm run (\S+)$/.exec(vercel.buildCommand ?? '')?.[1];
check(
  Boolean(buildScript && mobilePkg.scripts?.[buildScript]),
  `buildCommand runs an existing script (${vercel.buildCommand})`,
);
check(
  /^cd \.\.\/\.\. && npm ci/.test(vercel.installCommand ?? ''),
  'installCommand installs the whole workspace from the repo root',
);
check(
  (vercel.rewrites ?? []).some((r) => r.destination === '/' || r.destination === '/index.html'),
  'unknown paths fall back to index.html (deep links survive a refresh)',
);
check(
  appJson.expo?.web?.output === 'single',
  'app.json web.output is "single" (one index.html to fall back to)',
);
check(
  /^22\./.test(mobilePkg.engines?.node ?? ''),
  `Node version pinned for Vercel (${mobilePkg.engines?.node})`,
);
for (const asset of ['icon', 'favicon', 'splash', 'adaptive-icon', 'notification-icon']) {
  if (!existsSync(path.join(root, 'apps/mobile/assets', `${asset}.png`)))
    problems.push(`apps/mobile/assets/${asset}.png is missing`);
}
ok('app.json image assets exist');

// ---------------------------------------------------------------------------
if (problems.length) {
  console.error(`\n✖ ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\n✔ Deployment configuration looks right.');
