import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env, isProduction, isTest } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { nanoid } from 'nanoid';

/**
 * Observability (Section 2 — Sentry + PostHog, both optional).
 *
 * Sentry is loaded lazily and only when `SENTRY_DSN` is set, so a self-hosted
 * deployment without a Sentry account pays nothing. PostHog captures product
 * events (scan completed, plan generated, upgrade started) rather than raw
 * request logs.
 *
 * Neither library may ever break a request: every call is wrapped.
 */

type SentryLike = {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, scope?: Record<string, unknown>): string;
  withScope<T>(fn: (scope: { setTag(k: string, v: string): void; setUser(u: Record<string, unknown> | null): void; setExtra(k: string, v: unknown): void }) => T): T;
  flush(timeout?: number): Promise<boolean>;
};

type PostHogLike = {
  capture(event: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdownAsync(): Promise<void>;
};

let sentry: SentryLike | null = null;
let posthog: PostHogLike | null = null;

async function initSentry(): Promise<SentryLike | null> {
  if (!env.SENTRY_DSN || isTest) return null;
  try {
    const mod = (await import('@sentry/node')) as unknown as SentryLike;
    mod.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      release: env.APP_VERSION,
      tracesSampleRate: isProduction ? env.SENTRY_TRACES_SAMPLE_RATE : 1,
      sendDefaultPii: false,
      // Our typed errors already carry the right status code.
      beforeSend(event: Record<string, unknown>, hint: { originalException?: unknown }) {
        const err = hint?.originalException;
        if (err instanceof AppError && !err.reportable) return null;
        return event;
      },
    });
    logger.info('Sentry initialised');
    return mod;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Sentry unavailable — continuing without error reporting');
    return null;
  }
}

async function initPostHog(): Promise<PostHogLike | null> {
  if (!env.POSTHOG_API_KEY || !env.ENABLE_ANALYTICS || isTest) return null;
  try {
    const { PostHog } = (await import('posthog-node')) as unknown as {
      PostHog: new (key: string, options?: Record<string, unknown>) => PostHogLike;
    };
    const client = new PostHog(env.POSTHOG_API_KEY as string, { host: env.POSTHOG_HOST, flushAt: 20, flushInterval: 5_000 });
    logger.info('PostHog initialised');
    return client;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'PostHog unavailable — continuing without product analytics');
    return null;
  }
}

/** Record a product event. Safe to call unconditionally — it is a no-op when disabled. */
export function track(event: string, distinctId: string | null, properties: Record<string, unknown> = {}): void {
  if (!posthog || !distinctId) return;
  try {
    posthog.capture({ distinctId, event, properties: { ...properties, environment: env.NODE_ENV } });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'PostHog capture failed');
  }
}

/** Report an unexpected error to Sentry. */
export function reportError(error: unknown, request?: FastifyRequest): void {
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      scope.setTag('route', request?.routeOptions?.url ?? request?.url ?? 'unknown');
      scope.setTag('method', request?.method ?? 'unknown');
      if (request?.user?.id) scope.setUser({ id: request.user.id });
      if (request?.id) scope.setExtra('requestId', request.id);
      sentry!.captureException(error);
    });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'Sentry capture failed');
  }
}

export async function flushTelemetry(timeoutMs = 2_000): Promise<void> {
  try {
    await Promise.all([sentry?.flush(timeoutMs), posthog?.shutdownAsync()]);
  } catch {
    // Shutdown must never hang the process.
  }
}

async function telemetryPlugin(app: FastifyInstance): Promise<void> {
  [sentry, posthog] = await Promise.all([initSentry(), initPostHog()]);

  app.decorate('track', track);
  app.decorate('reportError', reportError);
  app.decorate('requestId', () => nanoid(12));

  app.addHook('onResponse', async (request, reply) => {
    // Slow-request logging is the cheapest form of profiling we get for free.
    if (reply.elapsedTime > 3_000) {
      request.log.warn(
        { url: request.url, method: request.method, ms: Math.round(reply.elapsedTime), status: reply.statusCode },
        'Slow request',
      );
    }
  });

  app.addHook('onClose', async () => {
    await flushTelemetry();
  });
}

export default fp(telemetryPlugin, { name: 'telemetry', fastify: '5.x' });

declare module 'fastify' {
  interface FastifyInstance {
    track: typeof track;
    reportError: typeof reportError;
    requestId(): string;
  }
}
