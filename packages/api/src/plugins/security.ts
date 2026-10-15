import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { env, corsOrigins, isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Security + transport plugins (Section 8).
 *
 *   helmet    sensible headers, CSP tuned for the docs/Swagger UI
 *   cors      explicit origin allow-list in production, permissive in dev
 *   compress  gzip/deflate/br above 1 KB
 *   cookie    only used to hold the non-httpOnly locale hint; tokens travel in
 *             the Authorization header (see plugins/auth.ts)
 */
async function securityPlugin(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    // The API serves no HTML of its own; Swagger UI is a separate route tree.
    contentSecurityPolicy: env.ENABLE_SWAGGER
      ? {
          directives: {
            defaultSrc: ["'self'"],
            // swagger-ui injects inline styles/scripts and loads its assets from
            // the same origin, so it needs these relaxations.
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
            imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
            connectSrc: ["'self'", 'https:'],
            workerSrc: ["'self'", 'blob:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        }
      : undefined,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  });

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'If-None-Match', 'X-Client-Version', 'X-Device-Id'],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
      'ETag',
      'X-Request-Id',
    ],
    maxAge: 86_400,
  });

  await app.register(compress, {
    global: true,
    encodings: ['br', 'gzip', 'deflate'],
    // Only compress payloads above 1 KB. Already-compressed media is served
    // straight from object storage / a CDN, so it never reaches this plugin.
    threshold: 1024,
  });

  await app.register(cookie, {
    secret: env.JWT_SECRET,
    hook: 'onRequest',
    parseOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
    },
  });

  logger.debug(
    { cors: corsOrigins, compress: true, helmet: true },
    'Security plugins registered',
  );
}

export default fp(securityPlugin, { name: 'security', fastify: '5.x' });
