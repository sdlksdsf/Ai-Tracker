import { z } from 'zod';
import { parseCorsOrigins, primaryOrigin, type CorsPolicy } from '../lib/cors.js';

/**
 * Environment configuration
 * ===========================================================================
 * Every value the process reads is declared and validated here once. The API
 * refuses to boot with a malformed configuration instead of failing later in a
 * request handler.
 *
 * Secrets are read from the environment only (the hosting dashboard — Render,
 * Fly, Doppler… — in production, `.env` locally). Nothing is ever committed —
 * see `.env.example` and docs/DEPLOYMENT.md.
 *
 * AI model identifiers are intentionally configurable: the defaults below point
 * at the current frontier models, and you can pin/upgrade them without a code
 * change. See README → "AI model matrix".
 */

const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

export const envSchema = z.object({
  // ---- Runtime -----------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default('false'),
  APP_URL: z.string().url().default('http://localhost:8080'),
  FRONTEND_URL: z.string().url().default('http://localhost:8081'),
  /** Comma-separated list of allowed CORS origins. `*` disables the check. */
  CORS_ORIGINS: z.string().default('*'),
  API_PREFIX: z.string().default('/api/v1'),
  /** Release tag surfaced in Sentry, OpenAPI and `/health`. */
  APP_VERSION: z.string().default(process.env.npm_package_version ?? '1.0.0'),
  ENABLE_SWAGGER: booleanish.default('true'),
  TRUST_PROXY: booleanish.default('true'),

  // ---- Database ----------------------------------------------------------
  DATABASE_URL: z.string().min(10).default('postgresql://platematch:platematch@localhost:5432/platematch'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_MIGRATE_ON_BOOT: booleanish.default('true'),

  // ---- Redis / queues ----------------------------------------------------
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Without Redis the API falls back to an in-process queue (dev convenience). */
  ENABLE_REDIS: booleanish.default('true'),
  QUEUE_PREFIX: z.string().default('platematch'),
  /**
   * Where background jobs run.
   *   auto   — BullMQ on Redis when Redis is enabled, otherwise in-process.
   *   redis  — always BullMQ (requires ENABLE_REDIS=true). Pair with a worker service.
   *   memory — always in-process, even when Redis serves the cache and rate limits.
   *            The right choice for ONE instance on per-command-billed Redis (Upstash):
   *            idle BullMQ workers poll Redis around the clock and exhaust a free tier.
   */
  QUEUE_DRIVER: z.enum(['auto', 'redis', 'memory']).default('auto'),
  ENABLE_WORKER: booleanish.default('true'),

  // ---- Auth --------------------------------------------------------------
  JWT_SECRET: z.string().min(16).default('dev-only-access-secret-change-me-please'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-only-refresh-secret-change-me-please'),
  JWT_ISSUER: z.string().default('platematch-api'),
  JWT_AUDIENCE: z.string().default('platematch-app'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(7 * 24 * 3600),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),
  /** Skip signature verification for OAuth tokens — LOCAL DEVELOPMENT ONLY. */
  INSECURE_SKIP_OAUTH_VERIFY: booleanish.default('false'),

  // ---- AI: vision (fridge scanning) --------------------------------------
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_CLOUD_VISION_KEY: z.string().optional(),
  /** Current frontier multimodal models (Oct 2026). Override to pin a version. */
  AI_VISION_PRIMARY_MODEL: z.string().default('gemini-3-pro'),
  AI_VISION_FALLBACK_MODEL: z.string().default('gpt-5.6-terra'),
  /** Cheap/fast model used for bounding boxes + batch work. */
  AI_VISION_FAST_MODEL: z.string().default('gemini-3-flash'),
  AI_VISION_BASE_URL: z.string().default('https://generativelanguage.googleapis.com/v1beta'),
  AI_VISION_OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_VISION_CONFIDENCE_FALLBACK: z.coerce.number().min(0).max(1).default(0.75),
  AI_VISION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(45_000),
  AI_VISION_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // ---- AI: reasoning (recipes & meal plans) -------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_REASONING_PRIMARY_MODEL: z.string().default('claude-sonnet-5'),
  AI_REASONING_FALLBACK_MODEL: z.string().default('gpt-5.6-sol'),
  AI_REASONING_BATCH_MODEL: z.string().default('gemini-3-flash'),
  AI_ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),
  AI_ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  AI_RECIPE_MAX_TOKENS: z.coerce.number().int().min(512).default(4096),
  AI_MEALPLAN_MAX_TOKENS: z.coerce.number().int().min(1024).default(8192),
  AI_RECIPE_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.7),
  AI_MEALPLAN_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.6),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90_000),
  /**
   * 'auto'  → use live providers when their keys exist, otherwise the built-in
   *           deterministic engine (lets the whole app run with zero API keys).
   * 'live'  → always call providers; fail loudly when a key is missing.
   * 'mock'  → always use the built-in engine (tests / CI / demos).
   */
  AI_MODE: z.enum(['auto', 'live', 'mock']).default('auto'),

  // ---- Nutrition ---------------------------------------------------------
  EDAMAM_APP_ID: z.string().optional(),
  EDAMAM_APP_KEY: z.string().optional(),
  EDAMAM_BASE_URL: z.string().default('https://api.edamam.com/api/nutrition-details'),
  SPOONACULAR_API_KEY: z.string().optional(),
  SPOONACULAR_BASE_URL: z.string().default('https://api.spoonacular.com'),

  // ---- Grocery prices ----------------------------------------------------
  KROGER_CLIENT_ID: z.string().optional(),
  KROGER_CLIENT_SECRET: z.string().optional(),
  KROGER_BASE_URL: z.string().default('https://api.kroger.com/v1'),
  KROGER_DEFAULT_LOCATION_ID: z.string().optional(),

  // ---- Storage -----------------------------------------------------------
  /** 'cloudinary' | 's3' | 'local' — local writes to ./uploads and serves /uploads. */
  STORAGE_DRIVER: z.enum(['cloudinary', 's3', 'local']).default('local'),
  /**
   * Cloudinary's "API environment variable" — cloudinary://<api_key>:<api_secret>@<cloud_name>.
   * One value instead of the three below; the discrete variables win when both are set.
   */
  CLOUDINARY_URL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('platematch'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),
  LOCAL_UPLOAD_DIR: z.string().default('./uploads'),

  // ---- Payments ----------------------------------------------------------
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PREMIUM_MONTHLY: z.string().optional(),
  STRIPE_PRICE_PREMIUM_YEARLY: z.string().optional(),
  STRIPE_PRICE_FAMILY_MONTHLY: z.string().optional(),
  STRIPE_PRICE_FAMILY_YEARLY: z.string().optional(),

  // ---- Notifications -----------------------------------------------------
  FCM_SERVER_KEY: z.string().optional(),
  EXPO_PUSH_ACCESS_TOKEN: z.string().optional(),
  /** Expo push service — works without FCM server credentials. */
  EXPO_PUSH_URL: z.string().default('https://exp.host/--/api/v2/push/send'),
  ENABLE_PUSH: booleanish.default('true'),
  ENABLE_CRONS: booleanish.default('true'),

  // ---- Observability -----------------------------------------------------
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default('https://us.i.posthog.com'),
  ENABLE_ANALYTICS: booleanish.default('true'),

  // ---- Rate limiting -----------------------------------------------------
  RATE_LIMIT_GENERAL_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_AI_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_SCAN_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_DISABLED: booleanish.default('false'),

  // ---- Seeding -----------------------------------------------------------
  SEED_DEMO_USER: booleanish.default('false'),
  SEED_DEMO_EMAIL: z.string().default('demo@platematch.app'),
  SEED_DEMO_PASSWORD: z.string().default('PlateMatch2025'),
  /** Seed the demo account on a paid tier so Premium features are explorable. */
  SEED_DEMO_PREMIUM: booleanish.default('false'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Non-fatal configuration advice gathered while parsing. `server.ts` logs these
 * once at boot — this module cannot use the logger (the logger imports it).
 */
export const envWarnings: string[] = [];

/** Parse (and memoise) the process environment. */
export function loadEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) return cached;

  const merged: Record<string, unknown> = { ...process.env, ...stripUndefined(overrides) };
  /** Was a variable actually provided (as opposed to falling back to a default)? */
  const provided = (key: string): boolean => typeof merged[key] === 'string' && (merged[key] as string).trim() !== '';

  // ---- Platform-derived defaults -------------------------------------------
  // Render injects its public URL; use it so APP_URL never needs setting by hand.
  if (!provided('APP_URL') && provided('RENDER_EXTERNAL_URL')) merged.APP_URL = merged.RENDER_EXTERNAL_URL;
  // The website that calls the API is, by definition, the first allowed origin.
  // Parse exactly what the schema will see: unset → '*', but an empty string
  // (a dashboard field left blank) stays empty and blocks every browser origin.
  const cors = parseCorsOrigins(typeof merged.CORS_ORIGINS === 'string' ? merged.CORS_ORIGINS : '*');
  if (!provided('FRONTEND_URL') && primaryOrigin(cors)) merged.FRONTEND_URL = primaryOrigin(cors);

  const parsed = envSchema.safeParse(merged);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[platematch] Invalid environment configuration:\n${details}\n`);
    throw new Error('Invalid environment configuration');
  }

  const env = parsed.data;
  const problems: string[] = [];

  // ---- Cloudinary: one URL → three settings ----------------------------------
  if (env.CLOUDINARY_URL) {
    const fromUrl = parseCloudinaryUrl(env.CLOUDINARY_URL);
    if (!fromUrl) {
      problems.push(
        'CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name> ' +
          '(copy the "API environment variable" from Cloudinary → Settings → API Keys)',
      );
    } else {
      env.CLOUDINARY_CLOUD_NAME ??= fromUrl.cloudName;
      env.CLOUDINARY_API_KEY ??= fromUrl.apiKey;
      env.CLOUDINARY_API_SECRET ??= fromUrl.apiSecret;
    }
  }

  // ---- Cross-field rules that hold in every environment ----------------------
  if (env.QUEUE_DRIVER === 'redis' && !env.ENABLE_REDIS) {
    problems.push('QUEUE_DRIVER=redis needs ENABLE_REDIS=true (or use QUEUE_DRIVER=memory)');
  }
  if (cors.invalid.length) {
    problems.push(
      `CORS_ORIGINS has entries that can never match a browser origin: ${cors.invalid.map((e) => `"${e}"`).join(', ')}. ` +
        'Use the full origin with no path, e.g. https://your-app.vercel.app',
    );
  }

  // ---- Fail fast on production misconfiguration ------------------------------
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET.includes('dev-only')) problems.push('JWT_SECRET is still the development default');
    if (env.JWT_REFRESH_SECRET.includes('dev-only'))
      problems.push('JWT_REFRESH_SECRET is still the development default');
    if (env.STORAGE_DRIVER === 'local') problems.push('STORAGE_DRIVER=local is not suitable for production');
    if (env.STORAGE_DRIVER === 'cloudinary' && !(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET)) {
      problems.push(
        'STORAGE_DRIVER=cloudinary but Cloudinary credentials are missing — set CLOUDINARY_CLOUD_NAME, ' +
          'CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET (Cloudinary → Settings → API Keys), or CLOUDINARY_URL',
      );
    }
    if (env.STORAGE_DRIVER === 's3' && !(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) {
      problems.push('STORAGE_DRIVER=s3 but S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing');
    }
    if (!provided('DATABASE_URL')) {
      problems.push('DATABASE_URL is not set — paste your PostgreSQL (Neon) connection string');
    }
    if (env.ENABLE_REDIS && !provided('REDIS_URL')) {
      problems.push('ENABLE_REDIS=true but REDIS_URL is not set — paste your Redis (Upstash) rediss:// URL, or set ENABLE_REDIS=false');
    }
    if (cors.allowAll) {
      envWarnings.push(
        'CORS_ORIGINS is "*" — any website can call this API from a browser. Set it to your frontend URL, e.g. https://your-app.vercel.app',
      );
    } else if (!cors.exact.size && !cors.patterns.length && !cors.invalid.length) {
      envWarnings.push('CORS_ORIGINS is empty — browsers on every website, including yours, will be blocked. Set it to your frontend URL.');
    }
  }

  if (problems.length) {
    throw new Error(
      `${env.NODE_ENV === 'production' ? 'Refusing to start in production' : 'Invalid configuration'}:\n - ${problems.join('\n - ')}`,
    );
  }

  if (Object.keys(overrides).length === 0) cached = env;
  return env;
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** `cloudinary://<api_key>:<api_secret>@<cloud_name>` → its parts, or null when malformed. */
export function parseCloudinaryUrl(raw: string): { cloudName: string; apiKey: string; apiSecret: string } | null {
  // People paste the whole line from the console, `CLOUDINARY_URL=` prefix included.
  const value = raw.trim().replace(/^CLOUDINARY_URL=/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'cloudinary:') return null;

  const apiKey = decodeURIComponent(url.username);
  const apiSecret = decodeURIComponent(url.password);
  const cloudName = url.hostname;
  // The console shows placeholders / a masked secret until you reveal it — catch both.
  if (!apiKey || !apiSecret || !cloudName || /[<>]/.test(value) || /^\*+$/.test(apiSecret)) return null;
  return { cloudName, apiKey, apiSecret };
}

/** Test/dev helper — clears the memoised env so overrides take effect. */
export function resetEnvCache(): void {
  cached = undefined;
}

export const env = loadEnv();

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/** The parsed `CORS_ORIGINS` allow-list (see lib/cors.ts). */
export const corsPolicy: CorsPolicy = parseCorsOrigins(env.CORS_ORIGINS);

/** True when we have credentials for at least one vision provider. */
export const hasVisionKeys = Boolean(env.GEMINI_API_KEY || env.OPENAI_API_KEY);
/** True when we have credentials for at least one reasoning provider. */
export const hasReasoningKeys = Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY);
export const hasStripeKeys = Boolean(env.STRIPE_SECRET_KEY);
export const hasEdamamKeys = Boolean(env.EDAMAM_APP_ID && env.EDAMAM_APP_KEY);
export const hasKrogerKeys = Boolean(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET);
export const hasSpoonacularKey = Boolean(env.SPOONACULAR_API_KEY);

/**
 * Resolve the effective AI mode for a capability.
 * `AI_MODE=auto` degrades to the built-in deterministic engine when the
 * relevant API keys are absent, so a fresh clone runs end-to-end immediately.
 */
export function resolveAiMode(capability: 'vision' | 'reasoning'): 'live' | 'mock' {
  if (env.AI_MODE === 'mock') return 'mock';
  if (env.AI_MODE === 'live') return 'live';
  return capability === 'vision' ? (hasVisionKeys ? 'live' : 'mock') : hasReasoningKeys ? 'live' : 'mock';
}
