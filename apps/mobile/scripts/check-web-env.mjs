#!/usr/bin/env node
/**
 * Pre-build check for the web export (`npm run build:web`, used by Vercel).
 *
 * The API address is baked into the JavaScript bundle at BUILD time from
 * EXPO_PUBLIC_API_URL. If it is missing, the export still "succeeds" and ships
 * a site that quietly calls http://localhost:4000 — every request fails in the
 * visitor's browser and nothing in the Vercel dashboard says why. So the build
 * stops here instead, with the fix spelled out.
 *
 * Plain Node, no dependencies. Exits 1 on a problem.
 */

const onVercel = process.env.VERCEL === '1';
const raw = (process.env.EXPO_PUBLIC_API_URL ?? '').trim();

function fail(lines) {
  console.error(
    [
      '',
      '✖ Web build stopped: EXPO_PUBLIC_API_URL needs fixing.',
      '',
      ...lines.map((l) => `  ${l}`),
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const howToFix = onVercel
  ? [
      'Fix it in Vercel: Project → Settings → Environment Variables →',
      '  Key:   EXPO_PUBLIC_API_URL',
      '  Value: https://<your-render-service>.onrender.com   (your API address, nothing after .com)',
      'Tick Production and Preview, save, then Deployments → ⋯ → Redeploy.',
    ]
  : ['Set it before building, e.g.  EXPO_PUBLIC_API_URL=http://localhost:4000 npm run build:web'];

if (!raw) {
  fail(['It is not set, so the website would not know where your API lives.', '', ...howToFix]);
}

let url;
try {
  url = new URL(raw);
} catch {
  fail([`"${raw}" is not a valid web address. It must start with https://`, '', ...howToFix]);
}

if (url.protocol !== 'https:' && url.protocol !== 'http:') {
  fail([`"${raw}" must start with https://`, '', ...howToFix]);
}

const isLocal = ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
if (onVercel && (isLocal || url.protocol !== 'https:')) {
  fail([
    `"${raw}" cannot work from a deployed site:`,
    isLocal
      ? 'localhost means "the visitor\'s own computer", not your server.'
      : 'Browsers block http:// API calls from an https:// site.',
    '',
    ...howToFix,
  ]);
}

const path = url.pathname.replace(/\/+$/, '');
if (path === '/api/v1') {
  console.warn(
    `! EXPO_PUBLIC_API_URL ends with /api/v1 — the app adds that itself, so it will use ${url.origin}.`,
  );
} else if (path) {
  fail([
    `"${raw}" should be just the server address (like ${url.origin}), without "${path}".`,
    '',
    ...howToFix,
  ]);
}

console.log(`✔ EXPO_PUBLIC_API_URL = ${url.origin}  (baked into this build)`);
