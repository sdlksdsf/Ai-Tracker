import type { FastifyInstance } from 'fastify';
import type {
  BatchUsePantryInput,
  CreatePantryItemInput,
  ExpiringSoonQuery,
  ListPantryQuery,
  UpdatePantryItemInput,
} from '@platematch/shared';
import {
  batchUsePantrySchema,
  createPantryItemSchema,
  expiringSoonQuerySchema,
  listPantryQuerySchema,
  updatePantryItemSchema,
} from '@platematch/shared';
import { jsonSchemaFrom } from '../lib/openapi.js';
import { noContent, ok, pageParams, parseWith } from '../lib/http.js';
import { track } from '../plugins/telemetry.js';
import {
  batchMarkUsed,
  createPantryItem,
  deletePantryItem,
  getExpired,
  getExpiringSoon,
  getPantryStats,
  listPantry,
  updatePantryItem,
} from '../services/pantry.service.js';
import { invalidateDashboard } from '../services/dashboard.service.js';

/**
 * Pantry routes (Section 4 — `/pantry/*`, Section 6 Screen 9).
 *
 * The pantry is the input to everything else — recipe ranking, meal planning,
 * grocery subtraction and expiry alerts — so writes invalidate the pantry,
 * dashboard and week-overview caches before responding.
 */
export async function pantryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /** Runs after every mutation so the Home screen never shows stale data. */
  async function afterWrite(userId: string): Promise<void> {
    await invalidateDashboard(userId);
  }

  // -------------------------------------------------------------------------
  // GET /pantry
  // -------------------------------------------------------------------------
  app.get('/', {
    schema: {
      tags: ['pantry'],
      summary: 'List pantry items with filters, search and sorting',
      querystring: jsonSchemaFrom(listPantryQuerySchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            meta: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = listPantryQuerySchema.parse(request.query ?? {}) as ListPantryQuery;
    const params = pageParams(query, { limit: 50, maxLimit: 200 });

    const result = await listPantry(request.user!.id, {
      category: query.category,
      location: query.location,
      expired: query.expired,
      used: query.used,
      q: query.q,
      sort: query.sort,
      order: query.order,
      page: params.page,
      limit: params.limit,
    });

    return reply.send({
      data: result.items,
      meta: {
        page: params.page,
        limit: params.limit,
        total: result.total,
        has_more: params.page * params.limit < result.total,
        next_cursor: null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /pantry/stats
  // -------------------------------------------------------------------------
  app.get('/stats', {
    schema: {
      tags: ['pantry'],
      summary: 'Counts by category/location, expiry buckets and estimated value',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getPantryStats(request.user!.id)));

  // -------------------------------------------------------------------------
  // GET /pantry/expiring-soon  ·  /pantry/expired
  // -------------------------------------------------------------------------
  app.get('/expiring-soon', {
    schema: {
      tags: ['pantry'],
      summary: 'Items expiring within N days (default 3)',
      querystring: jsonSchemaFrom(expiringSoonQuerySchema),
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const query = expiringSoonQuerySchema.parse(request.query ?? {}) as ExpiringSoonQuery;
    return ok(reply, await getExpiringSoon(request.user!.id, query.days));
  });

  app.get('/expired', {
    schema: {
      tags: ['pantry'],
      summary: 'Items already past their expiry date',
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => ok(reply, await getExpired(request.user!.id)));

  // -------------------------------------------------------------------------
  // POST /pantry
  // -------------------------------------------------------------------------
  app.post('/', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      tags: ['pantry'],
      summary: 'Add an item manually',
      description:
        'When `expiry_date` is omitted it is estimated from the ingredient\'s typical shelf life ' +
        '(e.g. milk 7 days, eggs 21 days, frozen peas 180 days).',
      body: jsonSchemaFrom(createPantryItemSchema),
      response: { 201: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(createPantryItemSchema, request.body, 'pantry item') as CreatePantryItemInput;
    const dto = await createPantryItem(request.user!.id, input, request.user!.tier);
    await afterWrite(request.user!.id);
    track('pantry_item_added', dto.id, { via: dto.added_via, category: dto.category });
    return ok(reply, dto, 201);
  });

  // -------------------------------------------------------------------------
  // PATCH /pantry/:id
  // -------------------------------------------------------------------------
  app.patch('/:id', {
    schema: {
      tags: ['pantry'],
      summary: 'Update quantity, expiry, location or mark used/expired',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(updatePantryItemSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseWith(updatePantryItemSchema, request.body, 'pantry item') as UpdatePantryItemInput;
    const dto = await updatePantryItem(request.user!.id, id, input);
    await afterWrite(request.user!.id);
    return ok(reply, dto);
  });

  // -------------------------------------------------------------------------
  // DELETE /pantry/:id
  // -------------------------------------------------------------------------
  app.delete('/:id', {
    schema: {
      tags: ['pantry'],
      summary: 'Remove an item from the pantry',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deletePantryItem(request.user!.id, id);
    await afterWrite(request.user!.id);
    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // POST /pantry/batch-use — "I cooked with these"
  // -------------------------------------------------------------------------
  app.post('/batch-use', {
    schema: {
      tags: ['pantry'],
      summary: 'Mark several items as used in one call',
      body: jsonSchemaFrom(batchUsePantrySchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { updated: { type: 'integer' } } } } } },
    },
  }, async (request, reply) => {
    const input = batchUsePantrySchema.parse(request.body) as BatchUsePantryInput;
    const result = await batchMarkUsed(request.user!.id, input.ids);
    await afterWrite(request.user!.id);
    return ok(reply, result);
  });

  // -------------------------------------------------------------------------
  // POST /pantry/refresh-expiry — nightly cron also calls the same helper
  // -------------------------------------------------------------------------
  app.post('/refresh-expiry', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      tags: ['pantry'],
      summary: 'Re-evaluate `is_expired` for this user\'s items',
      description: 'Runs automatically at 04:00 UTC; exposed so the client can force a refresh after a long sleep.',
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { flagged: { type: 'integer' } } } } } },
    },
  }, async (request, reply) => {
    const { refreshExpiredFlags } = await import('../services/pantry.service.js');
    const flagged = await refreshExpiredFlags(request.user!.id);
    await afterWrite(request.user!.id);
    return ok(reply, { flagged });
  });
}
