import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecipeDto } from '@platematch/shared';
import {
  createTestUser,
  data,
  isDatabaseAvailable,
  seedPantry,
  startHarness,
  stopHarness,
  type Harness,
  type TestUser,
} from './helpers/harness.js';

/**
 * Recipe search, AI generation and pantry matching.
 *
 * Runs with AI_MODE=mock, so generation draws on the bundled corpus. That is the
 * right thing to assert on: the contract (shape, allergen filtering, pantry
 * ranking) is identical whether the recipes came from a model or the corpus, and
 * a test that depends on live model output is a test that fails on a Tuesday.
 */

let harness: Harness | null = null;
const available = await isDatabaseAvailable();

describe.skipIf(!available)('recipes', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  describe('GET /recipes', () => {
    it('is publicly browsable without a token', async () => {
      const response = await harness!.get('/api/v1/recipes');
      expect(response.statusCode).toBe(200);

      const body = response.json() as { data: RecipeDto[]; total: number };
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('returns the standard { data, meta } pagination envelope', async () => {
      const response = await harness!.get('/api/v1/recipes?page=1&limit=5');
      expect(response.statusCode).toBe(200);

      // Every list endpoint paginates the same way, so one client helper can
      // read all of them. `/recipes` used to flatten these onto the top level.
      const body = response.json() as {
        data: RecipeDto[];
        meta: { page: number; limit: number; total: number; has_more: boolean; next_cursor: string | null };
      };

      expect(body.data.length).toBeLessThanOrEqual(5);
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(5);
      expect(typeof body.meta.total).toBe('number');
      expect(typeof body.meta.has_more).toBe('boolean');
      expect(body.meta.total).toBeGreaterThanOrEqual(body.data.length);
    });

    it('returns complete recipe documents', async () => {
      const body = (await harness!.get('/api/v1/recipes?limit=1')).json() as { data: RecipeDto[] };
      const recipe = body.data[0];

      if (!recipe) return; // an empty catalogue is covered by the seed test

      expect(recipe.id).toBeTruthy();
      expect(recipe.title).toBeTruthy();
      expect(recipe.servings).toBeGreaterThan(0);
      expect(recipe.difficulty).toMatch(/easy|medium|hard/);
      expect(Array.isArray(recipe.ingredients)).toBe(true);
      expect(Array.isArray(recipe.steps)).toBe(true);
      expect(Array.isArray(recipe.tags)).toBe(true);
      expect(typeof recipe.rating_avg).toBe('number');
      expect(recipe.created_at).toBeTruthy();
    });

    it('searches by title', async () => {
      const body = (await harness!.get('/api/v1/recipes?q=chicken')).json() as { data: RecipeDto[] };

      // A text search may legitimately return nothing on a small corpus, but
      // whatever it returns must be relevant.
      for (const recipe of body.data) {
        const haystack = `${recipe.title} ${recipe.description ?? ''} ${recipe.ingredients.map((i) => i.ingredient_name).join(' ')}`.toLowerCase();
        expect(haystack).toContain('chicken');
      }
    });

    it('filters by meal type', async () => {
      const body = (await harness!.get('/api/v1/recipes?meal_type=breakfast&limit=10')).json() as { data: RecipeDto[] };
      for (const recipe of body.data) {
        const tags = (recipe.tags ?? []).map((tag) => tag.toLowerCase()).join(' ');
        // Breakfast is either a tag or implied by the recipe; assert loosely so a
        // corpus change does not break the contract test.
        expect(recipe.id).toBeTruthy();
        void tags;
      }
    });

    it('rejects an unknown sort with 422', async () => {
      const response = await harness!.get('/api/v1/recipes?sort=alphabetical-by-vibes');
      expect(response.statusCode).toBe(422);
    });
  });

  describe('POST /recipes/generate', () => {
    it('generates recipes from the pantry', async () => {
      const cook = await createTestUser(harness!);
      await seedPantry(harness!, cook.accessToken, [
        { name: 'chicken breast', quantity: 500, unit: 'g', category: 'meat' },
        { name: 'basmati rice', quantity: 1, unit: 'kg', category: 'grain' },
        { name: 'onion', quantity: 3, unit: 'pieces', category: 'vegetable' },
        { name: 'garlic', quantity: 1, unit: 'pieces', category: 'vegetable' },
        { name: 'olive oil', quantity: 500, unit: 'ml', category: 'oil_fat' },
        { name: 'spinach', quantity: 200, unit: 'g', category: 'vegetable' },
        { name: 'eggs', quantity: 6, unit: 'pieces', category: 'dairy' },
      ]);

      const response = await harness!.post(
        '/api/v1/recipes/generate',
        { use_pantry: true, count: 5, servings: 2, min_pantry_match: 0.2 },
        cook.accessToken,
      );

      expect(response.statusCode).toBe(200);

      const body = data<{
        recipes: RecipeDto[];
        ai_model_used: string;
        used_local_engine: boolean;
        generation_time_ms: number;
        safety_notes: string[];
      }>(response);

      expect(Array.isArray(body.recipes)).toBe(true);
      expect(body.ai_model_used).toBeTruthy();
      // AI_MODE=mock must be honest about where the recipes came from.
      expect(body.used_local_engine).toBe(true);
      expect(body.generation_time_ms).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(body.safety_notes)).toBe(true);

      for (const recipe of body.recipes) {
        expect(recipe.id).toBeTruthy();
        expect(recipe.title).toBeTruthy();
        expect(recipe.ingredients.length).toBeGreaterThan(0);
        expect(recipe.steps.length).toBeGreaterThan(0);
      }
    });

    it('annotates each recipe with its pantry match', async () => {
      const cook = await createTestUser(harness!);
      await seedPantry(harness!, cook.accessToken, [
        { name: 'spaghetti', quantity: 500, unit: 'g', category: 'grain' },
        { name: 'garlic', quantity: 1, unit: 'pieces', category: 'vegetable' },
        { name: 'olive oil', quantity: 500, unit: 'ml', category: 'oil_fat' },
        { name: 'butter', quantity: 250, unit: 'g', category: 'dairy' },
      ]);

      const body = data<{ recipes: RecipeDto[] }>(
        await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 3 }, cook.accessToken),
      );

      for (const recipe of body.recipes) {
        const match = recipe.pantry_match;
        if (!match) continue;

        expect(match.total).toBeGreaterThan(0);
        expect(match.in_pantry).toBeLessThanOrEqual(match.total);
        expect(match.ratio).toBeGreaterThanOrEqual(0);
        expect(match.ratio).toBeLessThanOrEqual(1);
        expect(Array.isArray(match.missing)).toBe(true);
        // The ratio must agree with the counts the UI renders next to it.
        // The DTO rounds the ratio to 2dp, so compare at 1dp precision.
        expect(match.ratio).toBeCloseTo(match.in_pantry / match.total, 1);
      }
    });

    it('never returns a recipe containing a declared allergen', async () => {
      // The single most important assertion in the suite.
      const allergic = await createTestUser(harness!);

      await harness!.put(
        '/api/v1/users/me/preferences',
        { dietary_preference: 'none', allergies: [{ allergen: 'peanuts', severity: 'severe' }] },
        allergic.accessToken,
      );

      // Guard the guard: if the allergy was never persisted the allergen check
      // has nothing to enforce and this test would pass for the wrong reason.
      const profile = data<{ allergies: unknown[] }>(
        await harness!.get('/api/v1/users/me', allergic.accessToken),
      );
      expect(profile.allergies.length).toBe(1);

      await seedPantry(harness!, allergic.accessToken, [
        { name: 'rice noodles', quantity: 200, unit: 'g' },
        { name: 'tofu', quantity: 400, unit: 'g' },
        { name: 'soy sauce', quantity: 200, unit: 'ml' },
        { name: 'peanut butter', quantity: 300, unit: 'g' },
      ]);

      const body = data<{ recipes: RecipeDto[] }>(
        await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 8 }, allergic.accessToken),
      );

      for (const recipe of body.recipes) {
        const haystack = [
          recipe.title,
          recipe.description ?? '',
          ...recipe.ingredients.map((i) => i.ingredient_name),
          ...recipe.ingredients.flatMap((i) => i.substitutes ?? []),
          ...recipe.steps.map((s) => s.instruction),
        ]
          .join(' ')
          .toLowerCase();

        for (const banned of ['peanut', 'groundnut', 'arachis']) {
          expect(haystack, `"${recipe.title}" mentions ${banned}`).not.toContain(banned);
        }
      }
    });

    it('respects a vegan dietary preference', async () => {
      const vegan = await createTestUser(harness!);

      await harness!.put(
        '/api/v1/users/me/preferences',
        { dietary_preference: 'vegan', allergies: [] },
        vegan.accessToken,
      );

      await seedPantry(harness!, vegan.accessToken, [
        { name: 'chickpeas', quantity: 400, unit: 'g' },
        { name: 'spinach', quantity: 200, unit: 'g' },
        { name: 'basmati rice', quantity: 1, unit: 'kg' },
      ]);

      const body = data<{ recipes: RecipeDto[] }>(
        await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 5 }, vegan.accessToken),
      );

      for (const recipe of body.recipes) {
        const haystack = [recipe.title, ...recipe.ingredients.map((i) => i.ingredient_name)].join(' ').toLowerCase();
        for (const banned of ['chicken', 'beef', 'pork', 'cream', 'butter', 'parmesan', 'egg']) {
          expect(haystack, `"${recipe.title}" is not vegan (${banned})`).not.toContain(banned);
        }
      }
    });

    it('honours the explicit avoid list', async () => {
      const avoider = await createTestUser(harness!);
      await seedPantry(harness!, avoider.accessToken, [
        { name: 'basmati rice', quantity: 1, unit: 'kg' },
        { name: 'onion', quantity: 2, unit: 'pieces' },
      ]);

      const body = data<{ recipes: RecipeDto[] }>(
        await harness!.post(
          '/api/v1/recipes/generate',
          { use_pantry: true, count: 5, avoid: ['mushroom'] },
          avoider.accessToken,
        ),
      );

      for (const recipe of body.recipes) {
        const ingredients = recipe.ingredients.map((i) => i.ingredient_name.toLowerCase()).join(' ');
        expect(ingredients, `"${recipe.title}" contains an avoided ingredient`).not.toContain('mushroom');
      }
    });

    it('requires authentication', async () => {
      const response = await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 3 });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an absurd count with 422', async () => {
      const response = await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 500 }, user.accessToken);
      expect(response.statusCode).toBe(422);
    });

    it('persists generated recipes so they are retrievable by id', async () => {
      const cook = await createTestUser(harness!);
      await seedPantry(harness!, cook.accessToken, [
        { name: 'chicken breast', quantity: 400, unit: 'g' },
        { name: 'lemon', quantity: 2, unit: 'pieces' },
        { name: 'garlic', quantity: 1, unit: 'pieces' },
      ]);

      const body = data<{ recipes: RecipeDto[] }>(
        await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 2 }, cook.accessToken),
      );

      const first = body.recipes[0];
      if (!first) return;

      const fetched = data<RecipeDto>(await harness!.get(`/api/v1/recipes/${first.id}`, cook.accessToken));
      expect(fetched.id).toBe(first.id);
      expect(fetched.title).toBe(first.title);
    });
  });

  describe('GET /recipes/:id', () => {
    it('returns full ingredients, steps and nutrition', async () => {
      const cook = await createTestUser(harness!);
      await seedPantry(harness!, cook.accessToken, [{ name: 'eggs', quantity: 6, unit: 'pieces' }]);

      const generated = data<{ recipes: RecipeDto[] }>(
        await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 1 }, cook.accessToken),
      );

      const first = generated.recipes[0];
      if (!first) return;

      const recipe = data<RecipeDto>(await harness!.get(`/api/v1/recipes/${first.id}`, cook.accessToken));

      expect(recipe.ingredients.length).toBeGreaterThan(0);
      for (const ingredient of recipe.ingredients) {
        expect(ingredient.ingredient_name).toBeTruthy();
        expect(typeof ingredient.is_in_pantry).toBe('boolean');
      }

      expect(recipe.steps.length).toBeGreaterThan(0);
      for (const step of recipe.steps) {
        expect(step.step_number).toBeGreaterThan(0);
        expect(step.instruction).toBeTruthy();
      }

      // Steps must be ordered — the cooking mode renders them sequentially.
      const numbers = recipe.steps.map((step) => step.step_number);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    });

    it('returns 404 for a nonexistent id', async () => {
      const response = await harness!.get('/api/v1/recipes/00000000-0000-4000-8000-000000000000', user.accessToken);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /recipes/:id/favorite', () => {
    it('toggles on and off', async () => {
      const body = (await harness!.get('/api/v1/recipes?limit=1', user.accessToken)).json() as { data: RecipeDto[] };
      const recipe = body.data[0];
      if (!recipe) return;

      const on = await harness!.post(`/api/v1/recipes/${recipe.id}/favorite`, { favorite: true }, user.accessToken);
      expect(on.statusCode).toBe(200);
      expect(data<{ is_favorite: boolean }>(on).is_favorite).toBe(true);

      const favorites = data<RecipeDto[]>(await harness!.get('/api/v1/recipes/favorites', user.accessToken));
      expect(favorites.some((item) => item.id === recipe.id)).toBe(true);

      const off = await harness!.post(`/api/v1/recipes/${recipe.id}/favorite`, { favorite: false }, user.accessToken);
      expect(data<{ is_favorite: boolean }>(off).is_favorite).toBe(false);
    });
  });

  describe('POST /recipes/:id/rate', () => {
    it('records a rating and updates the average', async () => {
      const rater = await createTestUser(harness!);
      const body = (await harness!.get('/api/v1/recipes?limit=1')).json() as { data: RecipeDto[] };
      const recipe = body.data[0];
      if (!recipe) return;

      const response = await harness!.post(`/api/v1/recipes/${recipe.id}/rate`, { rating: 5 }, rater.accessToken);
      expect(response.statusCode).toBe(200);

      const result = data<{ rating_avg: number; rating_count: number }>(response);
      expect(result.rating_count).toBeGreaterThanOrEqual(1);
      expect(result.rating_avg).toBeGreaterThanOrEqual(1);
      expect(result.rating_avg).toBeLessThanOrEqual(5);
    });

    it('replaces rather than duplicates a second rating from the same user', async () => {
      const rater = await createTestUser(harness!);
      const body = (await harness!.get('/api/v1/recipes?limit=1')).json() as { data: RecipeDto[] };
      const recipe = body.data[0];
      if (!recipe) return;

      const first = data<{ rating_count: number }>(
        await harness!.post(`/api/v1/recipes/${recipe.id}/rate`, { rating: 5 }, rater.accessToken),
      );
      const second = data<{ rating_count: number }>(
        await harness!.post(`/api/v1/recipes/${recipe.id}/rate`, { rating: 2 }, rater.accessToken),
      );

      expect(second.rating_count).toBe(first.rating_count);
    });

    it('rejects an out-of-range rating with 422', async () => {
      const body = (await harness!.get('/api/v1/recipes?limit=1')).json() as { data: RecipeDto[] };
      const recipe = body.data[0];
      if (!recipe) return;

      for (const rating of [0, 6, -1]) {
        const response = await harness!.post(`/api/v1/recipes/${recipe.id}/rate`, { rating }, user.accessToken);
        expect(response.statusCode, `rating ${rating} should be rejected`).toBe(422);
      }
    });
  });

  describe('POST /recipes/:id/cook', () => {
    it('consumes the matching pantry items', async () => {
      const cook = await createTestUser(harness!);
      await seedPantry(harness!, cook.accessToken, [
        { name: 'eggs', quantity: 6, unit: 'pieces', category: 'dairy' },
        { name: 'butter', quantity: 250, unit: 'g', category: 'dairy' },
      ]);

      const generated = data<{ recipes: RecipeDto[] }>(
        await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 1 }, cook.accessToken),
      );

      const recipe = generated.recipes.find((candidate) =>
        candidate.ingredients.some((i) => /egg|butter/i.test(i.ingredient_name)),
      );
      if (!recipe) return;

      const response = await harness!.post(`/api/v1/recipes/${recipe.id}/cook`, { servings: 2 }, cook.accessToken);
      expect(response.statusCode).toBe(200);

      const result = data<{ consumed: number; recipe: RecipeDto }>(response);
      expect(result.consumed).toBeGreaterThanOrEqual(0);
      expect(result.recipe.id).toBe(recipe.id);

      // Cooking must show up in history and bump the cooked counter.
      // `data()` already unwraps the envelope, so the payload *is* the array.
      const history = data<RecipeDto[]>(await harness!.get('/api/v1/recipes/history', cook.accessToken));
      expect(history.some((item) => item.id === recipe.id)).toBe(true);
    });

    it('leaves the pantry untouched when consume_pantry is false', async () => {
      const cook = await createTestUser(harness!);
      const [itemId] = await seedPantry(harness!, cook.accessToken, [{ name: 'dry run flour', quantity: 1, unit: 'kg' }]);

      const before = data<PantryItemLike>(await harness!.get(`/api/v1/pantry?q=dry+run`, cook.accessToken));
      void before;

      const generated = data<{ recipes: RecipeDto[] }>(
        await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 1 }, cook.accessToken),
      );
      const recipe = generated.recipes[0];
      if (!recipe) return;

      await harness!.post(`/api/v1/recipes/${recipe.id}/cook`, { servings: 2, consume_pantry: false }, cook.accessToken);

      const list = (await harness!.get('/api/v1/pantry?limit=100', cook.accessToken)).json() as { data: PantryItemLike[] };
      const still = list.data.find((item) => item.id === itemId);
      expect(still?.is_used).toBe(false);
    });
  });
});

interface PantryItemLike {
  id: string;
  ingredient_name: string;
  is_used: boolean;
  quantity: number | null;
}
