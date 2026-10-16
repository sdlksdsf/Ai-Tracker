import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { env, corsPolicy, isProduction } from '../config/env.js';
import { isOriginAllowed } from '../lib/cors.js';
import { logger } from '../lib/logger.js';

/**
 * A blocked origin is logged once per process. The browser only says "CORS
 * error" — without this line the API log is silent and the cause (an origin
 * missing from CORS_ORIGINS, a trailing slash, http vs https) is guesswork.
 */
const reportedOrigins = new Set<string>();
function reportBlockedOrigin(origin: string): void {
  if (reportedOrigins.has(origin) || reportedOrigins.size >= 50) return;
  reportedOrigins.add(origin);
  logger.warn(
    { origin, allowed: corsPolicy.entries },
    `CORS: blocked a browser request from ${origin}. If this is your website, add it to CORS_ORIGINS.`,
  );
}

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
    // Requests without an Origin header (curl, native apps, health probes) are
    // not CORS requests: they get no CORS headers and are otherwise unaffected.
    origin: corsPolicy.allowAll
      ? '*'
      : (origin, callback) => {
          if (!origin) return callback(null, false);
          if (isOriginAllowed(corsPolicy, origin)) return callback(null, true);
          reportBlockedOrigin(origin);
          return callback(null, false);
        },
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
    { cors: corsPolicy.entries, compress: true, helmet: true },
    'Security plugins registered',
  );
}

export default fp(securityPlugin, { name: 'security', fastify: '5.x' });
