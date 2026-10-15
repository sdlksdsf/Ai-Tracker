#!/usr/bin/env node
/**
 * Supply-chain gate scoped to what actually ships.
 *
 * `npm audit` over the whole workspace reports advisories in the Expo / React
 * Native / Metro / Jest / Vitest toolchain, none of which is in the server
 * bundle or the app binary — they run on developer and CI machines. Blocking a
 * PR on those produces a gate that is red forever (the spec pins Expo SDK 52 and
 * React Native 0.76), and a gate that is always red is a gate people learn to
 * ignore, which is worse than not having one.
 *
 * So this resolves the **production dependency subtree of `packages/api`** — the
 * tree that serves user traffic — and fails on any high or critical advisory in
 * it. Everything else is still reported, just not blocking.
 *
 * Usage: node scripts/audit-runtime.mjs [--all]
 *   --all   also fail on advisories outside the API runtime tree
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const failOnEverything = process.argv.includes('--all');

/**
 * Advisories we knowingly accept, each with a reason and the work that retires
 * it. An entry with no reason is a bug in this file.
 */
const ALLOW_LIST = [
  {
    name: '@fastify/static',
    reason:
      'Serves only the bundled Swagger UI assets. The patched release ships with ' +
      '@fastify/swagger-ui 6.x, which requires Fastify 6; this repo is on Fastify 5. ' +
      'Retires with the Fastify 6 migration.',
  },
];

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // `npm audit` exits 1 *because* it found advisories, and `npm ls` exits
    // non-zero on any invalid dependency — in both cases stdout is still the
    // JSON we asked for. Anything without stdout is a genuine failure.
    const stdout = error?.stdout;
    if (typeof stdout === 'string' && stdout.trim().length > 0) return stdout;
    throw error;
  }
}

/**
 * Every package in `packages/api`'s production subtree, by name.
 *
 * Walked from the lockfile's own dependency edges rather than `npm ls`: in a
 * hoisted workspace `npm ls --workspace=... --all` reports the shared
 * node_modules tree, which pulls in Expo, React Native, Metro and Jest and
 * declares them "shipped". The lockfile records the real per-package edges,
 * including the nested copies npm creates when versions conflict.
 *
 * Only `dependencies` are followed — never `devDependencies` — so the result is
 * exactly what the server bundle can reach at runtime.
 */
function apiRuntimePackages() {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  const entries = lock.packages ?? {};

  /** Resolve `name` as `fromPath` sees it: nearest nested copy first, then root. */
  const resolve = (fromPath, name) => {
    const candidates = [];

    // Workspace links resolve to the workspace directory, not node_modules.
    if (name.startsWith('@platematch/')) candidates.push(`packages/${name.split('/')[1]}`);

    if (fromPath && fromPath !== '') {
      candidates.push(`${fromPath}/node_modules/${name}`);
      // Walk back up through any enclosing nested node_modules.
      const parts = fromPath.split('/node_modules/');
      for (let depth = parts.length - 1; depth > 0; depth -= 1) {
        candidates.push(`${parts.slice(0, depth).join('/node_modules/')}/node_modules/${name}`);
      }
    }
    candidates.push(`node_modules/${name}`);

    for (const candidate of candidates) {
      if (entries[candidate] && entries[candidate].dev !== true) return candidate;
    }
    return null;
  };

  const names = new Set();
  const visited = new Set();
  const queue = ['packages/api'];

  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);

    const entry = entries[path];
    if (!entry) continue;

    for (const depName of Object.keys(entry.dependencies ?? {})) {
      const depPath = resolve(path, depName);
      if (!depPath) continue;
      names.add(depName);
      queue.push(depPath);
    }
  }

  return names;
}

const audit = JSON.parse(run('npm', ['audit', '--json']) || '{}');
const runtime = apiRuntimePackages();

const flagged = [];
for (const [name, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(vuln.severity)) continue;
  const via = (vuln.via ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry.title))
    .filter(Boolean)[0];
  flagged.push({
    name,
    severity: vuln.severity,
    range: vuln.range,
    ships: runtime.has(name),
    allowed: ALLOW_LIST.some((entry) => entry.name === name),
    via: via ?? '',
  });
}

const blocking = flagged.filter((item) => item.ships && !item.allowed);
const reported = flagged.filter((item) => !item.ships);
const allowListed = flagged.filter((item) => item.ships && item.allowed);

const line = (item) => `  ${item.severity.padEnd(8)} ${item.name.padEnd(34)} ${item.range.padEnd(20)} ${item.via.slice(0, 64)}`;

console.log(`API runtime subtree: ${runtime.size} packages`);
console.log(`high/critical advisories in the tree: ${flagged.length}`);

if (allowListed.length > 0) {
  console.log(`\nAllow-listed (${allowListed.length}) — accepted with a written reason:`);
  for (const item of allowListed) {
    console.log(line(item));
    const entry = ALLOW_LIST.find((candidate) => candidate.name === item.name);
    console.log(`           reason: ${entry?.reason ?? '(MISSING — fix scripts/audit-runtime.mjs)'}`);
  }
}

if (reported.length > 0) {
  console.log(`\nOutside the API runtime subtree (${reported.length}) — reported, not blocking:`);
  console.log('  (build/test toolchain: Expo, React Native, Metro, Jest, Vitest, npm internals)');
  for (const item of reported.slice(0, 12)) console.log(line(item));
  if (reported.length > 12) console.log(`  … and ${reported.length - 12} more`);
}

if (blocking.length > 0) {
  console.log(`\nBLOCKING — high/critical in the shipped API runtime (${blocking.length}):`);
  for (const item of blocking) console.log(line(item));
  console.log('\nFix these, or add an entry to ALLOW_LIST above with a reason.');
  process.exit(1);
}

if (failOnEverything && reported.length > 0) {
  console.log(`\n--all was passed and ${reported.length} advisories remain outside the runtime tree.`);
  process.exit(1);
}

console.log('\nOK: no unaccepted high/critical advisory in the shipped API runtime.');

// Keep the lockfile honest: the audit above only reflects installed reality if
// package.json and the lockfile agree.
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
if (!rootPkg.workspaces?.includes('packages/*')) {
  console.error('Unexpected workspace layout — this script assumes packages/* is a workspace.');
  process.exit(1);
}
