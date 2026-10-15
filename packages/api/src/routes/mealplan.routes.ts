import type { FastifyInstance } from 'fastify';
import type { CompleteMealInput, GenerateMealPlanInput, SwapMealInput } from '@platematch/shared';
import { completeMealSchema, generateMealPlanSchema, swapMealSchema } from '@platematch/shared';
import { z } from 'zod';
import { jsonSchemaFrom, paginatedResponseSchema } from '../lib/openapi.js';
import { noContent, ok, pageParams, paginated, parseWith } from '../lib/http.js';
import { rateLimits } from '../lib/ratelimit.js';
import { track } from '../plugins/telemetry.js';
import {
  completeMeal,
  createMealPlan,
  deleteMealPlan,
  getMealPlan,
  getNutritionBreakdown,
  getPlanDays,
  getWeekOverview,
  listMealPlans,
  swapMeal,
  updateMealPlan,
} from '../services/mealplan.service.js';

/**
 * Meal-plan routes (Section 4 — `/meal-plans/*`, Section 6 Screen 10).
 *
 * Generation is the second AI endpoint: 10 req/min plus a monthly plan quota
 * (3 free / unlimited on Premium and Family).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const weekQuerySchema = z.object({ week_start: isoDate.optional() });
const updatePlanSchema = z.object({
  name: z.string().trim().max(120).optional(),
  servings: z.number().int().min(1).max(12).optional(),
  budget_per_day: z.number().min(0).max(10000).optional(),
});

export async function mealPlanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // POST /meal-plans/generate
  // -------------------------------------------------------------------------
  app.post('/generate', {
    config: { rateLimit: rateLimits.ai() },
    schema: {
      tags: ['meal-plans'],
      summary: 'Generate a weekly meal plan',
      description:
        'Optimises for the user\'s calorie and macro targets, dietary restrictions, declared ' +
        'allergies, family size, cooking skill, time budget and grocery budget — prioritising ' +
        'ingredients that are already in the pantry and about to expire. The result is verified ' +
        'against the daily calorie target (±10%) and the verification report is returned with it.',
      body: jsonSchemaFrom(generateMealPlanSchema),
      response: { 201: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(generateMealPlanSchema, request.body, 'meal plan request') as GenerateMealPlanInput;
    const result = await createMealPlan(request.user!.id, input);

    track('meal_plan_generated', request.user!.id, {
      plan_id: result.meal_plan.id,
      days: input.days,
      entries: result.meal_plan.entries.length,
      model: result.ai_model_used,
      local_engine: result.used_local_engine,
    });

    return ok(reply, result, 201);
  });

  // -------------------------------------------------------------------------
  // GET /meal-plans
  // -------------------------------------------------------------------------
  app.get('/', {
    schema: {
      tags: ['meal-plans'],
      summary: 'List the user\'s meal plans, newest first',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
      },
      response: { 200: paginatedResponseSchema() },
    },
  }, async (request, reply) => {
    const params = pageParams(request.query, { limit: 10, maxLimit: 50 });
    const result = await listMealPlans(request.user!.id, params.page, params.limit);
    return paginated(reply, result.data, params, result.total);
  });

  // -------------------------------------------------------------------------
  // GET /meal-plans/week — the calendar view
  // -------------------------------------------------------------------------
  app.get('/week', {
    schema: {
      tags: ['meal-plans'],
      summary: 'Seven-day overview with per-day calories and macro compliance',
      querystring: jsonSchemaFrom(weekQuerySchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const query = weekQuerySchema.parse(request.query ?? {});
    return ok(reply, await getWeekOverview(request.user!.id, query.week_start));
  });

  // -------------------------------------------------------------------------
  // GET /meal-plans/:id
  // -------------------------------------------------------------------------
  app.get('/:id', {
    schema: {
      tags: ['meal-plans'],
      summary: 'Full plan with entries, daily nutrition and grocery preview',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return ok(reply, await getMealPlan(id, request.user!.id));
  });

  app.get('/:id/days', {
    schema: {
      tags: ['meal-plans'],
      summary: 'Plan entries grouped into a day → meals grid',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return ok(reply, await getPlanDays(id, request.user!.id));
  });

  app.get('/:id/nutrition', {
    schema: {
      tags: ['meal-plans'],
      summary: 'Per-day calorie/macro breakdown with target compliance',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return ok(reply, await getNutritionBreakdown(request.user!.id, id));
  });

  // -------------------------------------------------------------------------
  // PATCH /meal-plans/:id
  // -------------------------------------------------------------------------
  app.patch('/:id', {
    schema: {
      tags: ['meal-plans'],
      summary: 'Rename a plan or adjust servings / daily budget',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(updatePlanSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updatePlanSchema.parse(request.body ?? {});
    return ok(reply, await updateMealPlan(request.user!.id, id, input));
  });

  // -------------------------------------------------------------------------
  // DELETE /meal-plans/:id  (archives)
  // -------------------------------------------------------------------------
  app.delete('/:id', {
    schema: {
      tags: ['meal-plans'],
      summary: 'Archive a meal plan',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteMealPlan(request.user!.id, id);
    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // POST /meal-plans/:id/entries/:entryId/swap
  // -------------------------------------------------------------------------
  app.post('/:id/entries/:entryId/swap', {
    config: { rateLimit: rateLimits.ai(20) },
    schema: {
      tags: ['meal-plans'],
      summary: 'Swap one meal for another',
      description:
        'Pass `new_recipe_id` to swap in a specific recipe, or `ai_replace=true` to ask the model ' +
        'for a fresh suggestion that avoids everything else already in the plan. The derived ' +
        'grocery list is rebuilt automatically.',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, entryId: { type: 'string', format: 'uuid' } },
        required: ['id', 'entryId'],
      },
      body: jsonSchemaFrom(swapMealSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id, entryId } = request.params as { id: string; entryId: string };
    const input = parseWith(swapMealSchema, request.body, 'swap request') as SwapMealInput;

    const plan = await swapMeal(request.user!.id, id, entryId, input);
    track('meal_swapped', request.user!.id, { plan_id: id, entry_id: entryId, ai: input.ai_replace });

    return ok(reply, plan);
  });

  // -------------------------------------------------------------------------
  // POST /meal-plans/:id/entries/:entryId/complete
  // -------------------------------------------------------------------------
  app.post('/:id/entries/:entryId/complete', {
    schema: {
      tags: ['meal-plans'],
      summary: 'Mark a planned meal as cooked (consumes pantry ingredients)',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, entryId: { type: 'string', format: 'uuid' } },
        required: ['id', 'entryId'],
      },
      body: jsonSchemaFrom(completeMealSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id, entryId } = request.params as { id: string; entryId: string };
    const input = parseWith(completeMealSchema, request.body ?? {}, 'completion') as CompleteMealInput;

    const plan = await completeMeal(request.user!.id, id, entryId, input);
    if (input.is_completed) {
      track('planned_meal_cooked', request.user!.id, { plan_id: id, entry_id: entryId, meal_type: input.meal_type });
    }

    return ok(reply, plan);
  });
}
