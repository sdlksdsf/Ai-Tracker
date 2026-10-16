import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOriginAllowed, normalizeOrigin, parseCorsOrigins, primaryOrigin } from '../../src/lib/cors.js';
import { env, envSchema, envWarnings, loadEnv, parseCloudinaryUrl } from '../../src/config/env.js';
import { normalizeDatabaseUrl } from '../../src/db/index.js';
import { migrationFolderCandidates, resolveMigrationsFolder, runMigrations } from '../../src/db/migrate.js';
import { QUEUE_NAMES, toBullQueueName } from '../../src/lib/queue.js';
import { buildRedisOptions } from '../../src/lib/redis.js';
import { uploadFile } from '../../src/lib/storage.js';

/**
 * Deployment configuration.
 *
 * Each block pins a failure that reached (or would have reached) a real deploy:
 * a CORS entry that could never match, a Cloudinary upload Cloudinary rejects,
 * migrations that silently did not run from the bundle, BullMQ refusing the
 * queue names, and production booting against defaults nobody set.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe('CORS_ORIGINS parsing', () => {
  it('normalises origins the way browsers send them', () => {
    expect(normalizeOrigin('https://PlateMatch.Vercel.app/')).toBe('https://platematch.vercel.app');
    expect(normalizeOrigin('https://app.example.com:443')).toBe('https://app.example.com');
    expect(normalizeOrigin('http://localhost:8081')).toBe('http://localhost:8081');
  });

  it('rejects things that are not a bare origin', () => {
    for (const bad of [
      'platematch.vercel.app',
      'https://app.example.com/login',
      'ftp://x.example.com',
      'https://a.com?x=1',
      '',
    ]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });

  it('accepts exact origins and Vercel preview patterns, and reports invalid entries', () => {
    const policy = parseCorsOrigins(
      ' https://platematch.vercel.app/ , https://platematch-*-acme.vercel.app, myapp.vercel.app ',
    );
    expect(policy.allowAll).toBe(false);
    expect([...policy.exact]).toEqual(['https://platematch.vercel.app']);
    expect(policy.patterns).toHaveLength(1);
    expect(policy.invalid).toEqual(['myapp.vercel.app']);
    expect(primaryOrigin(policy)).toBe('https://platematch.vercel.app');
  });

  it('matches only what the allow-list names', () => {
    const policy = parseCorsOrigins('https://platematch.vercel.app,https://platematch-*-acme.vercel.app');
    expect(isOriginAllowed(policy, 'https://platematch.vercel.app')).toBe(true);
    expect(isOriginAllowed(policy, 'https://platematch-git-main-acme.vercel.app')).toBe(true);
    expect(isOriginAllowed(policy, 'https://platematch-k2j3h4-acme.vercel.app')).toBe(true);

    expect(isOriginAllowed(policy, 'http://platematch.vercel.app')).toBe(false); // wrong scheme
    expect(isOriginAllowed(policy, 'https://platematch-git-main-evil.vercel.app')).toBe(false);
    expect(isOriginAllowed(policy, 'https://x.platematch-a-acme.vercel.app.evil.com')).toBe(false);
    expect(isOriginAllowed(policy, 'https://platematch-a.b-acme.vercel.app')).toBe(false); // * never spans a dot
    expect(isOriginAllowed(policy, undefined)).toBe(false);
  });

  it('refuses wildcards that would allow (nearly) everything', () => {
    expect(parseCorsOrigins('https://*').invalid).toEqual(['https://*']);
    expect(parseCorsOrigins('https://*.com').invalid).toEqual(['https://*.com']);
  });

  it('treats a bare * as allow-all', () => {
    const policy = parseCorsOrigins('*');
    expect(policy.allowAll).toBe(true);
    expect(isOriginAllowed(policy, 'https://anything.example')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const PROD_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'REDIS_URL',
  'ENABLE_REDIS',
  'QUEUE_DRIVER',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'STORAGE_DRIVER',
  'CLOUDINARY_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CORS_ORIGINS',
  'APP_URL',
  'FRONTEND_URL',
  'RENDER_EXTERNAL_URL',
] as const;

/** Run `fn` with exactly these variables set (all others in PROD_KEYS unset). */
function withEnv<T>(vars: Partial<Record<(typeof PROD_KEYS)[number], string>>, fn: () => T): T {
  const saved = Object.fromEntries(PROD_KEYS.map((k) => [k, process.env[k]]));
  for (const key of PROD_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of PROD_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const renderLike = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://neondb_owner:pw@ep-x-123.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ENABLE_REDIS: 'true',
  REDIS_URL: 'rediss://default:pw@eu1-x.upstash.io:6379',
  QUEUE_DRIVER: 'memory',
  JWT_SECRET: 'a'.repeat(44),
  JWT_REFRESH_SECRET: 'b'.repeat(44),
  STORAGE_DRIVER: 'cloudinary',
  CLOUDINARY_URL: 'cloudinary://123456789012345:AbC-dEf_GhI@my-cloud',
  CORS_ORIGINS: 'https://platematch.vercel.app',
  RENDER_EXTERNAL_URL: 'https://platematch-api.onrender.com',
};

describe('production environment validation', () => {
  // `loadEnv()` with an empty override object is memoised; a dummy key bypasses that.
  const load = () => loadEnv({ LOG_LEVEL: 'silent' });

  it('accepts the Render + Neon + Upstash + Cloudinary configuration and derives the rest', () => {
    const parsed = withEnv(renderLike, load);
    expect(parsed.CLOUDINARY_CLOUD_NAME).toBe('my-cloud');
    expect(parsed.CLOUDINARY_API_KEY).toBe('123456789012345');
    expect(parsed.CLOUDINARY_API_SECRET).toBe('AbC-dEf_GhI');
    expect(parsed.APP_URL).toBe('https://platematch-api.onrender.com');
    expect(parsed.FRONTEND_URL).toBe('https://platematch.vercel.app');
  });

  it('accepts the three discrete Cloudinary variables Render asks for', () => {
    const { CLOUDINARY_URL: _unused, ...withoutUrl } = renderLike;
    const parsed = withEnv(
      {
        ...withoutUrl,
        CLOUDINARY_CLOUD_NAME: 'my-cloud',
        CLOUDINARY_API_KEY: '123456789012345',
        CLOUDINARY_API_SECRET: 'AbC-dEf_GhI',
      },
      load,
    );
    expect(parsed.CLOUDINARY_CLOUD_NAME).toBe('my-cloud');
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: undefined }, /DATABASE_URL is not set/],
    ['REDIS_URL', { REDIS_URL: undefined }, /REDIS_URL is not set/],
    ['Cloudinary credentials', { CLOUDINARY_URL: undefined }, /Cloudinary credentials are missing/],
    [
      'a masked Cloudinary secret',
      { CLOUDINARY_URL: 'cloudinary://123456789012345:**********@my-cloud' },
      /CLOUDINARY_URL must look like/,
    ],
    [
      'a CORS origin without a scheme',
      { CORS_ORIGINS: 'platematch.vercel.app' },
      /CORS_ORIGINS has entries that can never match/,
    ],
    ['local storage', { STORAGE_DRIVER: 'local' }, /STORAGE_DRIVER=local/],
  ])('refuses to start without %s', (_label, change, message) => {
    const vars = { ...renderLike, ...change } as Record<string, string | undefined>;
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
    expect(() => withEnv(vars, load)).toThrow(message);
  });

  it('rejects QUEUE_DRIVER=redis without Redis, in any environment', () => {
    expect(() => withEnv({ QUEUE_DRIVER: 'redis', ENABLE_REDIS: 'false' }, load)).toThrow(
      /QUEUE_DRIVER=redis needs ENABLE_REDIS=true/,
    );
  });

  it('warns (without failing) when production allows every origin', () => {
    withEnv({ ...renderLike, CORS_ORIGINS: '*' }, load);
    expect(envWarnings.some((w) => w.includes('CORS_ORIGINS is "*"'))).toBe(true);
  });

  it('treats a CORS field left blank in a dashboard as "block all", not "allow all"', () => {
    const parsed = withEnv({ ...renderLike, CORS_ORIGINS: '' }, load);
    expect(parsed.CORS_ORIGINS).toBe('');
    expect(envWarnings.some((w) => w.includes('CORS_ORIGINS is empty'))).toBe(true);
  });

  it('documents every variable the server reads in .env.example (and nothing else)', () => {
    const example = readFileSync(path.resolve(here, '../../../../.env.example'), 'utf8');
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] ?? ''));
    const read = Object.keys(envSchema.shape);
    expect(
      read.filter((k) => !documented.has(k)),
      'read by the server but missing from .env.example',
    ).toEqual([]);
    expect(
      [...documented].filter((k) => !read.includes(k)),
      'in .env.example but never read',
    ).toEqual([]);
  });

  it('parses CLOUDINARY_URL the way the official SDK does', () => {
    expect(parseCloudinaryUrl('cloudinary://123456789012345:AbC-dEf_GhI@my-cloud')).toEqual({
      cloudName: 'my-cloud',
      apiKey: '123456789012345',
      apiSecret: 'AbC-dEf_GhI',
    });
    // Pasted with the "CLOUDINARY_URL=" prefix from the console.
    expect(parseCloudinaryUrl('CLOUDINARY_URL=cloudinary://1:s@c')?.cloudName).toBe('c');
    expect(parseCloudinaryUrl('cloudinary://<your_api_key>:<your_api_secret>@my-cloud')).toBeNull();
    expect(parseCloudinaryUrl('https://123:abc@my-cloud')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

describe('database connection string', () => {
  it('pins sslmode=require to the verify-full behaviour pg already applies', () => {
    expect(
      normalizeDatabaseUrl('postgresql://u:p@ep-x.neon.tech/db?sslmode=require&channel_binding=require'),
    ).toBe('postgresql://u:p@ep-x.neon.tech/db?sslmode=verify-full&channel_binding=require');
  });

  it('leaves explicit choices and non-TLS URLs alone', () => {
    for (const url of [
      'postgresql://u:p@localhost:5432/db',
      'postgresql://u:p@h/db?sslmode=disable',
      'postgresql://u:p@h/db?sslmode=verify-full',
      'postgresql://u:p@h/db?sslmode=require&uselibpqcompat=true',
      'host=/tmp dbname=x',
    ]) {
      expect(normalizeDatabaseUrl(url)).toBe(url);
    }
  });
});

describe('migrations folder', () => {
  it('finds the committed SQL from the source tree', () => {
    expect(resolveMigrationsFolder()).toBe(path.resolve(here, '../../drizzle'));
  });

  it('also looks relative to the working directory (Docker WORKDIR, Render repo root)', () => {
    // The bundle-relative case (dist/ → ../drizzle) can only be exercised from
    // the built output; CI runs `node dist/migrate.js` against Postgres for that.
    const candidates = migrationFolderCandidates();
    expect(candidates).toContain(path.resolve(process.cwd(), 'drizzle'));
    expect(candidates).toContain(path.resolve(process.cwd(), 'packages/api/drizzle'));
  });

  it('fails loudly instead of booting against an empty schema', async () => {
    await expect(runMigrations('/definitely/not/here')).rejects.toThrow(/migrations folder not found/i);
  });

  it('ships a journal that lists every SQL file', () => {
    const folder = resolveMigrationsFolder()!;
    const journal = JSON.parse(readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.length).toBeGreaterThan(0);
    for (const entry of journal.entries) {
      expect(() => readFileSync(path.join(folder, `${entry.tag}.sql`))).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Queue + Redis
// ---------------------------------------------------------------------------

describe('BullMQ compatibility', () => {
  it('uses queue names BullMQ accepts (no ":")', () => {
    for (const name of Object.values(QUEUE_NAMES)) expect(name).not.toContain(':');
    expect(toBullQueueName('platematch:scan')).toBe('platematch-scan');
  });
});

describe('Redis connection options', () => {
  it('forces TLS for an Upstash URL pasted as redis://', () => {
    expect(buildRedisOptions('redis://default:pw@eu1-x.upstash.io:6379').tls).toEqual({});
  });

  it('leaves rediss:// (TLS from the scheme) and local Redis untouched', () => {
    expect(buildRedisOptions('rediss://default:pw@eu1-x.upstash.io:6379').tls).toBeUndefined();
    expect(buildRedisOptions('redis://localhost:6379').tls).toBeUndefined();
  });

  it('keeps maxRetriesPerRequest=null, which BullMQ requires', () => {
    expect(buildRedisOptions('redis://localhost:6379').maxRetriesPerRequest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cloudinary upload request
// ---------------------------------------------------------------------------

describe('Cloudinary signed upload', () => {
  const saved = {
    STORAGE_DRIVER: env.STORAGE_DRIVER,
    CLOUDINARY_CLOUD_NAME: env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: env.CLOUDINARY_API_SECRET,
    CLOUDINARY_FOLDER: env.CLOUDINARY_FOLDER,
  };

  afterEach(() => {
    Object.assign(env, saved);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('signs exactly like the official SDK and sends no incoming f_auto', async () => {
    Object.assign(env, {
      STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'my-cloud',
      CLOUDINARY_API_KEY: '123456789012345',
      CLOUDINARY_API_SECRET: 'test-secret-value',
      CLOUDINARY_FOLDER: 'platematch',
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_792_150_000_000));

    let captured: { url: string; form: FormData } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: FormData }) => {
        captured = { url, form: init.body };
        return new Response(
          JSON.stringify({
            secure_url: 'https://res.cloudinary.com/my-cloud/image/upload/v1/x.jpg',
            public_id: 'x',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const result = await uploadFile({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      mimeType: 'image/jpeg',
      folder: 'scans/user-1/2026-10-16',
      key: 'fixed-public-id',
    });

    expect(result.url).toBe('https://res.cloudinary.com/my-cloud/image/upload/v1/x.jpg');
    expect(captured!.url).toBe('https://api.cloudinary.com/v1_1/my-cloud/image/upload');

    const form = captured!.form;
    expect(form.get('api_key')).toBe('123456789012345');
    expect(form.get('folder')).toBe('platematch/scans/user-1/2026-10-16');
    // Cloudinary: "Never use f_auto in an incoming transformation".
    expect(form.get('transformation')).toBeNull();
    // Computed with cloudinary@2 `utils.api_sign_request` for these exact params.
    expect(form.get('signature')).toBe('f690609a072647de4a3bca9e1dbc620c2784a523');
    expect(String(form.get('file'))).toMatch(/^data:image\/jpeg;base64,/);
  });
});
