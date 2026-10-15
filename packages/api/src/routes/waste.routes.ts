import type { FastifyInstance } from 'fastify';
import type { CreateWasteLogInput, WasteHistoryQuery } from '@platematch/shared';
import { logWasteSchema, wasteHistoryQuerySchema } from '@platematch/shared';
import { jsonSchemaFrom } from '../lib/openapi.js';
import { noContent, ok, pageParams, parseWith } from '../lib/http.js';
import { track } from '../plugins/telemetry.js';
import {
  createWasteLog,
  deleteWasteLog,
  getWasteCategories,
  getWasteImpact,
  getWasteStats,
  listWasteLogs,
  wasteFreeStreak,
  type WastePeriod,
} from '../services/waste.service.js';

/**
 * Food-waste routes (Section 4 — `/waste/*`, Section 6 Screen 11).
 *
 * Logging is deliberately frictionless: the client can send just a name and a
 * reason, and the service derives grams, CO₂e (per-category factor) and the
 * financial cost (offline price index). That matters because every extra field
 * is a reason not to log, and unlogged waste is invisible to the user.
 */
export async function wasteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // POST /waste
  // -------------------------------------------------------------------------
  app.post('/', {
    schema: {
      tags: ['waste'],
      summary: 'Log food that was thrown away',
      description:
        'CO₂e and cost are computed server-side when omitted, from the category factor table and ' +
        'the ingredient price index. Linking `pantry_item_id` also marks that pantry item used.',
      body: jsonSchemaFrom(logWasteSchema),
      response: { 201: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(logWasteSchema, request.body, 'waste log') as CreateWasteLogInput;
    const dto = await createWasteLog(request.user!.id, input);

    track('waste_logged', request.user!.id, {
      reason: dto.reason,
      category: dto.category,
      cost: dto.estimated_cost,
      co2_kg: dto.co2_equivalent_kg,
    });

    return ok(reply, dto, 201);
  });

  // -------------------------------------------------------------------------
  // GET /waste  — history
  // -------------------------------------------------------------------------
  app.get('/', {
    schema: {
      tags: ['waste'],
      summary: 'Waste log history with period and reason filters',
      querystring: jsonSchemaFrom(wasteHistoryQuerySchema),
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
    const query = wasteHistoryQuerySchema.parse(request.query ?? {}) as WasteHistoryQuery;
    const params = pageParams(query, { limit: 30, maxLimit: 100 });

    const range = periodRange(query.period);
    const result = await listWasteLogs(request.user!.id, {
      page: params.page,
      limit: params.limit,
      from: range.from,
      to: range.to,
      reason: query.reason,
    });

    return reply.send({
      data: result.data,
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
  // GET /waste/stats  ·  /waste/impact  ·  /waste/categories
  // -------------------------------------------------------------------------
  app.get('/stats', {
    schema: {
      tags: ['waste'],
      summary: 'Waste analytics for a period, with the previous period for comparison',
      querystring: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['week', 'month', 'year'], default: 'week' } },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { period } = request.query as { period?: string };
    const normalized: WastePeriod = period === 'month' || period === 'year' ? period : 'week';
    return ok(reply, await getWasteStats(request.user!.id, normalized));
  });

  app.get('/impact', {
    schema: {
      tags: ['waste'],
      summary: 'Lifetime environmental and financial impact, with relatable equivalents',
      description:
        'Converts the totals into things people can picture: mature trees needed to absorb the ' +
        'CO₂, home-cooked meals\' worth of food, and how the weekly waste compares with the ' +
        'UNEP household average of ~1.5 kg per person per week.',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getWasteImpact(request.user!.id)));

  app.get('/streak', {
    schema: {
      tags: ['waste'],
      summary: 'Consecutive waste-free days',
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object', properties: { waste_free_days: { type: 'integer' } } } },
        },
      },
    },
  }, async (request, reply) => ok(reply, { waste_free_days: await wasteFreeStreak(request.user!.id) }));

  app.get('/categories', {
    schema: {
      tags: ['waste'],
      summary: 'Waste categories with their CO₂ factors and example prompts',
      security: [],
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (_request, reply) => ok(reply, getWasteCategories()));

  // -------------------------------------------------------------------------
  // DELETE /waste/:id
  // -------------------------------------------------------------------------
  app.delete('/:logId', {
    schema: {
      tags: ['waste'],
      summary: 'Delete a waste log (e.g. logged by mistake)',
      params: { type: 'object', properties: { logId: { type: 'string', format: 'uuid' } }, required: ['logId'] },
    },
  }, async (request, reply) => {
    const { logId } = request.params as { logId: string };
    await deleteWasteLog(request.user!.id, logId);
    return noContent(reply);
  });
}

/** Map the history `period` filter onto a concrete date range. */
function periodRange(period: WasteHistoryQuery['period']): { from?: string; to?: string } {
  const now = new Date();
  const to = now.toISOString();

  switch (period) {
    case 'week':
      return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to };
    case 'month':
      return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), to };
    case 'quarter':
      return { from: new Date(now.getTime() - 91 * 86_400_000).toISOString(), to };
    case 'year':
      return { from: new Date(now.getTime() - 365 * 86_400_000).toISOString(), to };
    case 'all':
    default:
      return { to };
  }
}
