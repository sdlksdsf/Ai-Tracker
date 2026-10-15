import type { FastifyInstance } from 'fastify';
import type { CookRecipeInput, GenerateRecipesInput, RateRecipeInput, SearchRecipesQuery } from '@platematch/shared';
import { cookRecipeSchema, generateRecipesSchema, rateRecipeSchema, searchRecipesQuerySchema } from '@platematch/shared';
import { z } from 'zod';
import { jsonSchemaFrom, paginatedResponseSchema } from '../lib/openapi.js';
import { ok, pageParams, paginated, parseWith } from '../lib/http.js';
import { rateLimits } from '../lib/ratelimit.js';
import { track } from '../plugins/telemetry.js';
import {
  cookNowFromExpiring,
  getCookHistory,
  getFavoriteRecipes,
  getRecipeForUser,
  getRecipeRatings,
  getTrendingRecipes,
  generateRecipesForUser,
  markRecipeCooked,
  rateRecipe,
  searchRecipes,
  toggleFavorite,
} from '../services/recipe.service.js';

/**
 * Recipe routes (Section 4 — `/recipes/*`, Section 6 Screens 7-8).
 *
 * `POST /recipes/generate` is the AI endpoint: 10 req/min, a per-day quota that
 * depends on the plan, and a hard per-user daily spend cap so a runaway client
 * cannot burn the API budget.
 *
 * Read endpoints accept anonymous traffic — the catalogue is public — but attach
 * the user when a token is present so pantry matching and favourites work.
 */

const favoriteSchema = z.object({ favorite: z.boolean().default(true) });

export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /recipes/generate  (authenticated, AI)
  // -------------------------------------------------------------------------
  app.post('/generate', {
    preHandler: [app.authenticate],
    config: { rateLimit: rateLimits.ai() },
    schema: {
      tags: ['recipes'],
      summary: 'Generate recipes from what is already in the fridge',
      description:
        'Sends the pantry, declared allergies and dietary preference to the reasoning chain ' +
        '(Claude → GPT → Gemini, with a deterministic built-in engine as the last resort). ' +
        'Every candidate is re-checked against the allergen guard before it is returned, and ' +
        'anything unsafe is disqualified at the recipe level rather than silently edited.',
      body: jsonSchemaFrom(generateRecipesSchema),
      // 200, not 201 — and deliberately different from POST /meal-plans/generate.
      // A generation can be served from the prompt cache (`model=cache`) and create
      // nothing at all, so promising 201 Created here would be a lie on cache hits.
      // Meal-plan generation always persists a plan, its entries and a grocery list,
      // so 201 is correct there. Both codes are declared in the OpenAPI document.
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(generateRecipesSchema, request.body, 'recipe request') as GenerateRecipesInput;
    const result = await generateRecipesForUser(request.user!.id, input);

    track('recipes_generated', request.user!.id, {
      count: result.recipes.length,
      model: result.ai_model_used,
      local_engine: result.used_local_engine,
      ms: result.generation_time_ms,
    });

    return ok(reply, result);
  });

  // -------------------------------------------------------------------------
  // GET /recipes  (public + optional personalisation)
  // -------------------------------------------------------------------------
  app.get('/', {
    preHandler: [app.optionalAuth],
    schema: {
      tags: ['recipes'],
      summary: 'Search and filter the recipe catalogue',
      description:
        '`sort=best_match` and `sort=fewest_missing` need the pantry, so pass a token to rank by ' +
        'what you can actually cook tonight.',
      querystring: jsonSchemaFrom(searchRecipesQuerySchema),
      response: { 200: paginatedResponseSchema() },
    },
  }, async (request, reply) => {
    const query = searchRecipesQuerySchema.parse(request.query ?? {}) as SearchRecipesQuery;
    const params = pageParams(query, { limit: 20, maxLimit: 50 });

    const result = await searchRecipes({
      userId: request.user?.id ?? null,
      q: query.q,
      cuisine: query.cuisine,
      diet: query.diet,
      maxTime: query.maxTime,
      difficulty: query.difficulty,
      meal_type: query.meal_type,
      use_pantry: query.use_pantry,
      sort: query.sort,
      page: params.page,
      limit: params.limit,
    });

    // `searchRecipes` returns its pagination flattened for internal callers;
    // the HTTP boundary normalises it to the `{ data, meta }` envelope every
    // other list endpoint uses, so one client pagination helper works for all.
    return paginated(reply, result.data, params, result.total, result.next_cursor);
  });

  // -------------------------------------------------------------------------
  // GET /recipes/trending  ·  /recipes/favorites  ·  /recipes/history
  // -------------------------------------------------------------------------
  app.get('/trending', {
    preHandler: [app.optionalAuth],
    schema: {
      tags: ['recipes'],
      summary: 'Highest-rated, most-cooked public recipes',
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 } },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    return ok(reply, await getTrendingRecipes(Number(limit ?? 12)));
  });

  app.get('/favorites', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['recipes'],
      summary: 'Saved recipes, newest first',
      response: { 200: paginatedResponseSchema() },
    },
  }, async (request, reply) => {
    const params = pageParams(request.query, { limit: 20, maxLimit: 50 });
    const result = await getFavoriteRecipes(request.user!.id, params.page, params.limit);
    return paginated(reply, result.data, params, result.total);
  });

  app.get('/history', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['recipes'],
      summary: 'Recipes the user has cooked, newest first',
      response: { 200: paginatedResponseSchema() },
    },
  }, async (request, reply) => {
    const params = pageParams(request.query, { limit: 20, maxLimit: 50 });
    const result = await getCookHistory(request.user!.id, params.page, params.limit);
    return paginated(reply, result.data, params, result.total);
  });

  // -------------------------------------------------------------------------
  // GET /recipes/:id
  // -------------------------------------------------------------------------
  app.get('/:id', {
    preHandler: [app.optionalAuth],
    schema: {
      tags: ['recipes'],
      summary: 'Recipe detail with ingredients, steps, nutrition and pantry match',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return ok(reply, await getRecipeForUser(id, request.user?.id ?? null));
  });

  // -------------------------------------------------------------------------
  // POST /recipes/:id/favorite
  // -------------------------------------------------------------------------
  app.post('/:id/favorite', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['recipes'],
      summary: 'Save or unsave a recipe',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(favoriteSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { is_favorite: { type: 'boolean' } } } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = favoriteSchema.parse(request.body ?? {});
    return ok(reply, await toggleFavorite(request.user!.id, id, input.favorite));
  });

  // -------------------------------------------------------------------------
  // POST /recipes/:id/rate
  // -------------------------------------------------------------------------
  app.post('/:id/rate', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['recipes'],
      summary: 'Rate a recipe (1-5) and optionally leave a review',
      description: 'One rating per user per recipe — rating again replaces the previous one.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(rateRecipeSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { rating_avg: { type: 'number' }, rating_count: { type: 'integer' } },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseWith(rateRecipeSchema, request.body, 'rating') as RateRecipeInput;
    const result = await rateRecipe(request.user!.id, id, input);
    track('recipe_rated', request.user!.id, { recipe_id: id, rating: input.rating });
    return ok(reply, result);
  });

  app.get('/:id/ratings', {
    preHandler: [app.optionalAuth],
    schema: {
      tags: ['recipes'],
      summary: 'Ratings and reviews for a recipe',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const params = pageParams(request.query, { limit: 20, maxLimit: 50 });
    return ok(reply, await getRecipeRatings(id, params.limit));
  });

  // -------------------------------------------------------------------------
  // POST /recipes/:id/cook — "Start Cooking" → pantry consumption
  // -------------------------------------------------------------------------
  app.post('/:id/cook', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['recipes'],
      summary: 'Mark a recipe as cooked and consume the matched pantry items',
      description:
        'Scales ingredient quantities to the servings actually cooked. Items with no recorded ' +
        'quantity are consumed in full; items with more than needed are decremented. ' +
        'Pass `consume_pantry=false` for a dry run, or list names in `skip_ingredients` ' +
        'for anything bought fresh for this meal.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: jsonSchemaFrom(cookRecipeSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                consumed: { type: 'integer' },
                recipe: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseWith(cookRecipeSchema, request.body ?? {}, 'cook request') as CookRecipeInput;

    const result = await markRecipeCooked(request.user!.id, id, input, 'recipe_detail');
    track('recipe_cooked', request.user!.id, { recipe_id: id, servings: input.servings ?? null, consumed: result.consumed });

    return ok(reply, result);
  });

  // -------------------------------------------------------------------------
  // POST /recipes/cook-now/:pantryItemId — from the Expiring Soon carousel
  // -------------------------------------------------------------------------
  app.post('/cook-now/:pantryItemId', {
    preHandler: [app.authenticate],
    config: { rateLimit: rateLimits.ai(20) },
    schema: {
      tags: ['recipes'],
      summary: 'Find the best recipe that uses an item about to expire',
      params: {
        type: 'object',
        properties: { pantryItemId: { type: 'string', format: 'uuid' } },
        required: ['pantryItemId'],
      },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { pantryItemId } = request.params as { pantryItemId: string };
    const result = await cookNowFromExpiring(request.user!.id, pantryItemId);
    track('cook_now_requested', request.user!.id, { pantry_item_id: pantryItemId, found: result.recipe !== null });
    return ok(reply, result);
  });
}
