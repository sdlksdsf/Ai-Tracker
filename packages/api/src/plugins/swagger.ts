import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { API_BASE_PATH } from '@platematch/shared';

/**
 * OpenAPI 3.1 documentation (Section 2).
 *
 * The spec is generated from the JSON schemas declared on each route, so it can
 * never drift from the handlers. It is served at `/docs` (UI) and
 * `/docs/json` (raw) and is disabled entirely in production unless
 * `ENABLE_SWAGGER=true`.
 */
async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'PlateMatch API',
        description: [
          'AI meal planning, fridge scanning and food-waste reduction.',
          '',
          '## Authentication',
          'Send `Authorization: Bearer <access_token>`. Access tokens live 15 minutes;',
          'exchange the 7-day rotating refresh token at `POST /auth/refresh` for a new pair.',
          '',
          '## Errors',
          'Every error uses one envelope:',
          '```json',
          '{ "statusCode": 422, "error": "validation_error", "message": "…", "requestId": "…" }',
          '```',
          '',
          '## Rate limits',
          '100 req/min general · 10 req/min AI generation · 5 req/min fridge scans ·',
          '10 req/min auth (per IP). Remaining budget is in the `X-RateLimit-*` headers.',
        ].join('\n'),
        version: app.version ?? '1.0.0',
        contact: { name: 'PlateMatch', url: 'https://github.com/sdlksdsf/Ai-Tracker' },
        license: { name: 'MIT', identifier: 'MIT' },
      },
      servers: [
        { url: env.APP_URL.replace(/\/$/, ''), description: 'This deployment' },
        { url: 'http://localhost:4000', description: 'Local development' },
      ],
      tags: [
        { name: 'health', description: 'Liveness, readiness and AI configuration' },
        { name: 'auth', description: 'Register, login, refresh, OAuth, password reset' },
        { name: 'users', description: 'Profile, preferences, allergies, nutrition targets' },
        { name: 'scan', description: 'Fridge photo → AI ingredient detection' },
        { name: 'pantry', description: 'Pantry CRUD, expiry tracking, statistics' },
        { name: 'recipes', description: 'AI recipe generation, search, ratings, cooking' },
        { name: 'meal-plans', description: 'Weekly AI meal plans, swaps, nutrition breakdown' },
        { name: 'grocery-lists', description: 'Smart shopping lists and price comparison' },
        { name: 'waste', description: 'Food-waste logging and impact analytics' },
        { name: 'achievements', description: 'Gamified badges, points and levels' },
        { name: 'notifications', description: 'Inbox, device tokens, preferences' },
        { name: 'subscription', description: 'Plans, Stripe checkout, usage and limits' },
        { name: 'dashboard', description: 'Home summary, savings stats, weekly report' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token from `POST /auth/login` or `POST /auth/refresh`.',
          },
        },
        schemas: {
          ApiError: {
            type: 'object',
            properties: {
              statusCode: { type: 'integer' },
              error: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string' },
            },
            required: ['statusCode', 'error', 'message'],
          },
          PaginationMeta: {
            type: 'object',
            properties: {
              page: { type: 'integer' },
              limit: { type: 'integer' },
              total: { type: 'integer' },
              has_more: { type: 'boolean' },
              next_cursor: { type: ['string', 'null'] },
            },
          },
        },
        parameters: {
          Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        },
      },
      security: [{ bearerAuth: [] }],
      externalDocs: {
        url: 'https://github.com/sdlksdsf/Ai-Tracker#readme',
        description: 'PlateMatch on GitHub',
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
      tryItOutEnabled: true,
      defaultModelsExpandDepth: 1,
    },
    uiHooks: {
      onRequest: async (request, reply) => {
        // Docs are opt-in outside development.
        if (!env.ENABLE_SWAGGER && env.NODE_ENV === 'production') {
          await reply.code(404).send({ statusCode: 404, error: 'not_found', message: 'API docs are disabled on this deployment.' });
        }
      },
    },
    staticCSP: false,
    transformSpecification: (swaggerObject) => swaggerObject,
  });

  app.get(`${API_BASE_PATH}/openapi.json`, {
    schema: {
      tags: ['health'],
      summary: 'Raw OpenAPI 3.1 document',
      security: [],
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => app.swagger());
}

export default fp(swaggerPlugin, { name: 'docs', fastify: '5.x' });
