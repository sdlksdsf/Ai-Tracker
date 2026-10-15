import type { FastifyInstance } from 'fastify';
import type {
  AddGroceryItemInput,
  GenerateGroceryListInput,
  ListGroceryListsQuery,
  OrderGroceryListInput,
  UpdateGroceryItemInput,
  UpdateGroceryListInput,
} from '@platematch/shared';
import {
  addGroceryItemSchema,
  generateGroceryListSchema,
  listGroceryListsQuerySchema,
  orderGroceryListSchema,
  updateGroceryItemSchema,
  updateGroceryListSchema,
} from '@platematch/shared';
import { z } from 'zod';
import { jsonSchemaFrom, paginatedResponseSchema } from '../lib/openapi.js';
import { noContent, ok, paginated, parseWith } from '../lib/http.js';
import { rateLimits } from '../lib/ratelimit.js';
import { track } from '../plugins/telemetry.js';
import {
  addGroceryItem,
  buildOrderHandoff,
  clearGroceryList,
  deleteGroceryList,
  generateGroceryList,
  getActiveGroceryList,
  getGroceryList,
  listGroceryLists,
  refreshPrices,
  removeCheckedItems,
  removeGroceryItem,
  toggleGroceryItem,
  updateGroceryItem,
  updateGroceryList,
} from '../services/grocery.service.js';

/**
 * Grocery-list routes (Section 4 — `/grocery-lists/*`, Section 6 Screen 11).
 *
 * `POST /grocery-lists/:id/prices` is the multi-store comparison: Kroger API →
 * Spoonacular → an offline price-index estimator, cached for 24 h. It is a
 * Premium feature, so it is gated by `requirePlan('premium')`.
 */

const checkSchema = z.object({ checked: z.boolean().default(true) });

export async function groceryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // POST /grocery-lists/generate
  // -------------------------------------------------------------------------
  app.post('/generate', {
    config: { rateLimit: rateLimits.ai(20) },
    schema: {
      tags: ['grocery-lists'],
      summary: 'Build a shopping list from a meal plan, recipes or explicit items',
      description:
        'Aggregates every ingredient across the source, scales quantities to the planned servings ' +
        'and merges duplicates that share a unit. With `subtract_pantry=true` anything already at ' +
        'home is dropped; with `skip_prices=false` on a paid plan each line is priced across stores.',
      body: jsonSchemaFrom(generateGroceryListSchema),
      response: { 201: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(generateGroceryListSchema, request.body, 'grocery list request') as GenerateGroceryListInput;
    const dto = await generateGroceryList(request.user!.id, input);

    track('grocery_list_generated', request.user!.id, {
      list_id: dto.id,
      items: dto.total_count,
      from_plan: Boolean(input.meal_plan_id),
      estimated_cost: dto.total_estimated_cost,
    });

    return ok(reply, dto, 201);
  });

  // -------------------------------------------------------------------------
  // GET /grocery-lists  ·  /grocery-lists/active
  // -------------------------------------------------------------------------
  app.get('/', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'List shopping lists',
      querystring: jsonSchemaFrom(listGroceryListsQuerySchema),
      response: { 200: paginatedResponseSchema() },
    },
  }, async (request, reply) => {
    const query = listGroceryListsQuerySchema.parse(request.query ?? {}) as ListGroceryListsQuery;
    const result = await listGroceryLists(request.user!.id, query);
    return paginated(reply, result.data, { page: query.page, limit: query.limit }, result.total);
  });

  app.get('/active', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'The most recent active list (Home screen shortcut)',
      response: { 200: { type: 'object', properties: { data: { type: ['object', 'null'], additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getActiveGroceryList(request.user!.id)));

  // -------------------------------------------------------------------------
  // GET /grocery-lists/:id
  // -------------------------------------------------------------------------
  app.get('/:id', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Full list with items, per-store prices and the savings summary',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return ok(reply, await getGroceryList(request.user!.id, id));
  });

  // -------------------------------------------------------------------------
  // POST /grocery-lists/:id/prices  (Premium)
  // -------------------------------------------------------------------------
  app.post('/:id/prices', {
    preHandler: [app.requirePlan('premium')],
    config: { rateLimit: rateLimits.ai(6) },
    schema: {
      tags: ['grocery-lists'],
      summary: 'Compare prices across stores and recompute the cheapest basket',
      description:
        'Queries Kroger, then Spoonacular, then falls back to an offline price index so a line is ' +
        'never unpriced. Results are cached for 24 hours; this endpoint always forces a refresh.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const comparison = await refreshPrices(request.user!.id, id);

    track('prices_compared', request.user!.id, {
      list_id: id,
      best_store: comparison.best_store,
      saved: comparison.saved,
    });

    return ok(reply, comparison);
  });

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------
  app.post('/:id/items', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Add an item (merges into an existing unchecked line for the same ingredient)',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(addGroceryItemSchema),
      response: { 201: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseWith(addGroceryItemSchema, request.body, 'grocery item') as AddGroceryItemInput;
    return ok(reply, await addGroceryItem(request.user!.id, id, input), 201);
  });

  app.patch('/:id/items/:itemId', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Update quantity, unit, actual price or tick an item off',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, itemId: { type: 'string', format: 'uuid' } },
        required: ['id', 'itemId'],
      },
      body: jsonSchemaFrom(updateGroceryItemSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const input = parseWith(updateGroceryItemSchema, request.body, 'grocery item') as UpdateGroceryItemInput;
    return ok(reply, await updateGroceryItem(request.user!.id, id, itemId, input));
  });

  app.post('/:id/items/:itemId/check', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Tick or untick a single item (the shopping-mode toggle)',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, itemId: { type: 'string', format: 'uuid' } },
        required: ['id', 'itemId'],
      },
      body: jsonSchemaFrom(checkSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const input = checkSchema.parse(request.body ?? {});
    return ok(reply, await toggleGroceryItem(request.user!.id, id, itemId, input.checked));
  });

  app.delete('/:id/items/:itemId', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Remove an item',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, itemId: { type: 'string', format: 'uuid' } },
        required: ['id', 'itemId'],
      },
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } },
    },
  }, async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    return ok(reply, await removeGroceryItem(request.user!.id, id, itemId));
  });

  // -------------------------------------------------------------------------
  // List-level operations
  // -------------------------------------------------------------------------
  app.patch('/:id', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Rename, complete, or tick every remaining item at once',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(updateGroceryListSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateGroceryListSchema.parse(request.body ?? {}) as UpdateGroceryListInput;
    return ok(reply, await updateGroceryList(request.user!.id, id, input));
  });

  app.post('/:id/clear-checked', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Delete every ticked item (post-shop tidy-up)',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return ok(reply, await removeCheckedItems(request.user!.id, id));
  });

  app.post('/:id/clear', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Remove every item but keep the list',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return ok(reply, await clearGroceryList(request.user!.id, id));
  });

  app.delete('/:id', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Delete a list and its items',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteGroceryList(request.user!.id, id);
    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // POST /grocery-lists/:id/order — hand off to a delivery provider
  // -------------------------------------------------------------------------
  app.post('/:id/order', {
    schema: {
      tags: ['grocery-lists'],
      summary: 'Build a deep link + share text for a grocery delivery provider',
      description:
        'Returns a provider search URL pre-filled with the unchecked items, plus a plain-text ' +
        'version of the list grouped by store or category for the native share sheet.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(orderGroceryListSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = orderGroceryListSchema.parse(request.body ?? {}) as OrderGroceryListInput;
    const result = await buildOrderHandoff(request.user!.id, id, input);

    track('grocery_order_handoff', request.user!.id, {
      list_id: id,
      provider: input.provider,
      items: result.item_count,
      total: result.estimated_total,
    });

    return ok(reply, result);
  });
}
