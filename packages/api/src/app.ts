import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { API_BASE_PATH } from '@platematch/shared';
import { env, isProduction, isTest } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';
import { storageDriverName } from './lib/storage.js';

import securityPlugin from './plugins/security.js';
import rawBodyPlugin from './plugins/raw-body.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import multipartPlugin from './plugins/multipart.js';
import authPlugin from './plugins/auth.js';
import telemetryPlugin from './plugins/telemetry.js';
import docsPlugin from './plugins/swagger.js';

/**
 * Application factory.
 *
 * Building the app separately from listening on a port means integration tests
 * can `await buildApp()` and use `app.inject()` — no sockets, no races, and the
 * exact same plugin graph the server boots with.
 *
 * Plugin order matters:
 *   1. logger            (every later plugin logs)
 *   2. rawBody           (content-type parser must be registered before routes)
 *   3. security          (helmet/cors must run before anything else)
 *   4. telemetry         (Sentry/PostHog, decorates `track`/`reportError`)
 *   5. rate-limit        (needs `request.user` to key by user id when present)
 *   6. multipart         (upload parsing)
 *   7. auth              (decorators used by route preHandlers)
 *   8. docs              (reads the schemas registered by the routes)
 *   9. routes
 */
export interface BuildAppOptions {
  /** Skip the OpenAPI docs (faster boots in tests). */
  skipDocs?: boolean;
  /** Skip plugin registration entirely — only the error handlers. */
  bare?: boolean;
  /** An already-constructed pino logger, passed to Fastify's `loggerInstance`. */
  logger?: FastifyBaseLogger;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify 5 separates the two: `logger` takes a config object, while an
    // already-constructed pino instance must be handed to `loggerInstance`.
    // Passing our shared instance to `logger` throws
    // "logger options only accepts a configuration object" at boot.
    loggerInstance: options.logger ?? logger,
    // Behind a load balancer we must trust X-Forwarded-For to rate-limit per client.
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024, // 2 MB for JSON; images go through multipart.
    caseSensitive: false,
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    requestIdHeader: 'x-request-id',
    // Both warn about removal in Fastify 6. The replacement (`logController`)
    // takes a controller *class* rather than options, which is not worth
    // implementing for a cosmetic deprecation notice; revisit on the v6 upgrade.
    requestIdLogLabel: 'requestId',
    disableRequestLogging: isTest,
    maxParamLength: 128,
    connectionTimeout: 20_000,
    keepAliveTimeout: isProduction ? 65_000 : 5_000,
    exposeHeadRoutes: true,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  if (options.bare) return app;

  // 2. Raw bodies (Stripe signature verification)
  await app.register(rawBodyPlugin);

  // 3. Security headers, CORS, compression, cookies
  await app.register(securityPlugin);

  // 4. Sentry + PostHog (both optional)
  await app.register(telemetryPlugin);

  // 5. Rate limiting
  await app.register(rateLimitPlugin);

  // 6. Multipart uploads
  await app.register(multipartPlugin);

  // 7. Authentication decorators
  await app.register(authPlugin);

  // 9. Routes (registered before docs so the schemas exist)
  await app.register(registerRoutes);

  // 8. OpenAPI docs
  if (!options.skipDocs && env.ENABLE_SWAGGER) {
    await app.register(docsPlugin);
  }

  // --- Local static file serving ------------------------------------------
  // Only for STORAGE_DRIVER=local; object storage and Cloudinary serve files
  // themselves. Explicitly refused in production.
  if (storageDriverName() === 'local' && !isProduction) {
    const { readdir } = await import('node:fs/promises');
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');

    const root = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR);
    await readdir(root).catch(() => undefined);

    app.get('/uploads/*', {
      schema: { tags: ['health'], summary: 'Locally stored uploads (development only)', security: [] },
    }, async (request, reply) => {
      const requested = String((request.params as Record<string, string>)['*'] ?? '');
      const resolved = path.resolve(root, requested);

      // Reject anything that escapes the upload directory.
      if (!resolved.startsWith(root + path.sep)) {
        return reply.code(400).send({ statusCode: 400, error: 'bad_request', message: 'Invalid path' });
      }

      const buffer = await readFile(resolved).catch(() => null);
      if (!buffer) return reply.code(404).send({ statusCode: 404, error: 'not_found', message: 'File not found' });

      const ext = path.extname(resolved).toLowerCase();
      const type =
        ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.avif' ? 'image/avif' : 'image/jpeg';

      return reply.type(type).header('cache-control', 'public, max-age=31536000, immutable').send(buffer);
    });
  }

  // --- Root ----------------------------------------------------------------
  app.get('/', { schema: { tags: ['health'], summary: 'Service banner', security: [] } }, async () => ({
    name: 'PlateMatch API',
    version: env.APP_VERSION,
    documentation: env.ENABLE_SWAGGER ? '/docs' : null,
    api: API_BASE_PATH,
    health: '/health',
    environment: env.NODE_ENV,
  }));

  return app;
}

/** Boot the app and start listening. Used by `server.ts`. */
export async function startApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = await buildApp(options);

  await app.listen({ port: env.PORT, host: env.HOST });

  app.log.info(
    {
      url: env.APP_URL,
      docs: env.ENABLE_SWAGGER ? `${env.APP_URL}/docs` : 'disabled',
      environment: env.NODE_ENV,
      version: env.APP_VERSION,
    },
    'PlateMatch API listening',
  );

  return app;
}
