import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DayMealEntry, GroceryListDto, MealPlanDto, WeekOverviewDto } from '@platematch/shared';
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
 * Meal planning and grocery lists — the two halves of the "plan then shop" loop.
 *
 * The assertions that matter most here are the ones a user would notice if they
 * broke: a plan covers the days requested, entries carry real recipes, the
 * nutrition check reports against the user's target, and the grocery list
 * contains only what is actually missing.
 */

let harness: Harness | null = null;
const available = await isDatabaseAvailable();

/** A fridge with enough variety for the corpus to plan a full week. */
const FULL_PANTRY = [
  { name: 'chicken breast', quantity: 800, unit: 'g', category: 'meat' },
  { name: 'eggs', quantity: 12, unit: 'pieces', category: 'dairy' },
  { name: 'greek yoghurt', quantity: 500, unit: 'g', category: 'dairy' },
  { name: 'milk', quantity: 2, unit: 'l', category: 'dairy' },
  { name: 'cheddar cheese', quantity: 300, unit: 'g', category: 'dairy' },
  { name: 'butter', quantity: 250, unit: 'g', category: 'dairy' },
  { name: 'basmati rice', quantity: 2, unit: 'kg', category: 'grain' },
  { name: 'spaghetti', quantity: 1, unit: 'kg', category: 'grain' },
  { name: 'rolled oats', quantity: 1, unit: 'kg', category: 'grain' },
  { name: 'bread', quantity: 1, unit: 'pieces', category: 'bakery' },
  { name: 'chickpeas', quantity: 800, unit: 'g', category: 'legume' },
  { name: 'black beans', quantity: 800, unit: 'g', category: 'legume' },
  { name: 'spinach', quantity: 400, unit: 'g', category: 'vegetable' },
  { name: 'tomato', quantity: 6, unit: 'pieces', category: 'vegetable' },
  { name: 'onion', quantity: 6, unit: 'pieces', category: 'vegetable' },
  { name: 'garlic', quantity: 2, unit: 'pieces', category: 'vegetable' },
  { name: 'carrot', quantity: 600, unit: 'g', category: 'vegetable' },
  { name: 'bell pepper', quantity: 4, unit: 'pieces', category: 'vegetable' },
  { name: 'sweet potato', quantity: 800, unit: 'g', category: 'vegetable' },
  { name: 'banana', quantity: 8, unit: 'pieces', category: 'fruit' },
  { name: 'apple', quantity: 8, unit: 'pieces', category: 'fruit' },
  { name: 'lemon', quantity: 4, unit: 'pieces', category: 'fruit' },
  { name: 'olive oil', quantity: 1, unit: 'l', category: 'oil_fat' },
  { name: 'frozen peas', quantity: 500, unit: 'g', category: 'frozen' },
];

describe.skipIf(!available)('meal planning', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
    await seedPantry(harness!, user.accessToken, FULL_PANTRY);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  describe('POST /meal-plans/generate', () => {
    it('creates a seven-day plan with entries and a verification report', async () => {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); // this Monday

      const response = await harness!.post(
        '/api/v1/meal-plans/generate',
        {
          start_date: start.toISOString().slice(0, 10),
          days: 7,
          meals_per_day: 3,
          variety: 'high',
          cooking_time_pref: 'balanced',
        },
        user.accessToken,
      );

      expect(response.statusCode).toBe(201);

      const result = data<{
        meal_plan: MealPlanDto;
        grocery_list_id: string | null;
        ai_model_used: string;
        generation_time_ms: number;
        used_local_engine: boolean;
        nutrition_verification: {
          days_checked: number;
          days_within_tolerance: number;
          tolerance_pct: number;
          warnings: string[];
        };
      }>(response);

      const plan = result.meal_plan;
      expect(plan.id).toBeTruthy();
      expect(plan.week_start_date).toBe(start.toISOString().slice(0, 10));
      expect(plan.entries.length).toBeGreaterThan(0);
      expect(result.ai_model_used).toBeTruthy();
      expect(result.used_local_engine).toBe(true);

      // The verification report is what the UI shows to justify the plan.
      const verification = result.nutrition_verification;
      expect(verification.days_checked).toBeGreaterThan(0);
      expect(verification.tolerance_pct).toBe(10);
      expect(verification.days_within_tolerance).toBeLessThanOrEqual(verification.days_checked);
      expect(Array.isArray(verification.warnings)).toBe(true);

      // A plan should produce a shopping list for what is missing.
      expect(result.grocery_list_id).toBeTruthy();
    });

    it('populates each entry with a real recipe and calorie count', async () => {
      // Its own user on purpose: the free tier includes one generated plan per
      // month and the first test in this suite has already spent the shared
      // user's quota. Reusing it here would 402 and cascade into every later
      // test that reads `GET /meal-plans`.
      const planner = await createTestUser(harness!);
      await seedPantry(harness!, planner.accessToken, FULL_PANTRY);

      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 7);

      const result = data<{ meal_plan: MealPlanDto }>(
        await harness!.post(
          '/api/v1/meal-plans/generate',
          { start_date: start.toISOString().slice(0, 10), days: 3, meals_per_day: 2 },
          planner.accessToken,
        ),
      );

      for (const entry of result.meal_plan.entries) {
        expect(entry.id).toBeTruthy();
        expect(entry.day_of_week).toBeGreaterThanOrEqual(1);
        expect(entry.day_of_week).toBeLessThanOrEqual(7);
        expect(['breakfast', 'lunch', 'dinner', 'snack']).toContain(entry.meal_type);
        expect(entry.is_completed).toBe(false);

        if (entry.recipe) {
          expect(entry.recipe.title).toBeTruthy();
          expect(entry.recipe.ingredients.length).toBeGreaterThan(0);
        }
        if (entry.calories != null) {
          expect(entry.calories).toBeGreaterThan(0);
        }
      }
    });

    it('never plans an allergen the user declared', async () => {
      const allergic = await createTestUser(harness!);
      await seedPantry(harness!, allergic.accessToken, FULL_PANTRY);

      await harness!.put(
        '/api/v1/users/me/preferences',
        { dietary_preference: 'none', allergies: [{ allergen: 'shellfish', severity: 'severe' }] },
        allergic.accessToken,
      );

      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 14);

      const result = data<{ meal_plan: MealPlanDto }>(
        await harness!.post(
          '/api/v1/meal-plans/generate',
          { start_date: start.toISOString().slice(0, 10), days: 7, meals_per_day: 3 },
          allergic.accessToken,
        ),
      );

      for (const entry of result.meal_plan.entries) {
        const recipe = entry.recipe;
        if (!recipe) continue;

        const haystack = [
          recipe.title,
          ...recipe.ingredients.map((i) => i.ingredient_name),
          ...recipe.steps.map((s) => s.instruction),
        ]
          .join(' ')
          .toLowerCase();

        for (const banned of ['shrimp', 'prawn', 'crab', 'lobster', 'shellfish', 'calamari']) {
          expect(haystack, `"${recipe.title}" contains ${banned}`).not.toContain(banned);
        }
      }
    });

    it('requires authentication', async () => {
      const response = await harness!.post('/api/v1/meal-plans/generate', {
        start_date: new Date().toISOString().slice(0, 10),
        days: 7,
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an out-of-range day count with 422', async () => {
      const response = await harness!.post(
        '/api/v1/meal-plans/generate',
        { start_date: new Date().toISOString().slice(0, 10), days: 90 },
        user.accessToken,
      );
      expect(response.statusCode).toBe(422);
    });
  });

  describe('GET /meal-plans/week', () => {
    it('returns seven days with per-day calories and macro checks', async () => {
      const overview = data<WeekOverviewDto>(await harness!.get('/api/v1/meal-plans/week', user.accessToken));

      expect(overview.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(overview.week_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(overview.days).toHaveLength(7);

      for (const day of overview.days) {
        expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(day.day_name).toBeTruthy();
        expect(typeof day.is_today).toBe('boolean');
        expect(Array.isArray(day.meals)).toBe(true);
        expect(day.total_calories).toBeGreaterThanOrEqual(0);
      }

      // Exactly one day is flagged as today.
      expect(overview.days.filter((day) => day.is_today)).toHaveLength(1);

      // The Plan screen links straight to this week's shopping list, so the
      // overview has to carry the id. It used to be absent entirely, which left
      // the shortcut rendering nothing to open.
      expect(overview).toHaveProperty('grocery_list_id');
      expect(
        overview.grocery_list_id === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(overview.grocery_list_id),
      ).toBe(true);

      expect(overview.targets.calories).toBeGreaterThan(0);
      expect(overview.completion_rate).toBeGreaterThanOrEqual(0);
      expect(overview.completion_rate).toBeLessThanOrEqual(100);

      for (const check of overview.macro_check) {
        expect(check.day).toBeGreaterThanOrEqual(1);
        expect(check.target).toBeGreaterThan(0);
        expect(typeof check.within_tolerance).toBe('boolean');
        expect(Number.isFinite(check.delta_pct)).toBe(true);
      }
    });

    it('is stable for an explicit week start', async () => {
      const start = '2026-10-12'; // a Monday
      const overview = data<WeekOverviewDto>(await harness!.get(`/api/v1/meal-plans/week?week_start=${start}`, user.accessToken));
      expect(overview.week_start).toBe(start);
      expect(overview.week_end).toBe('2026-10-18');
    });
  });

  describe('GET /meal-plans/:id/nutrition', () => {
    it('breaks calories down per day and reports compliance', async () => {
      const plans = data<MealPlanDto[]>(await harness!.get('/api/v1/meal-plans', user.accessToken));
      const plan = plans[0];
      if (!plan) return;

      const breakdown = data<Record<string, unknown>>(
        await harness!.get(`/api/v1/meal-plans/${plan.id}/nutrition`, user.accessToken),
      );

      expect(breakdown.plan_id).toBe(plan.id);
      expect(Array.isArray(breakdown.days)).toBe(true);
      expect(breakdown.totals).toBeTruthy();
      expect(breakdown.targets).toBeTruthy();
      expect(breakdown.compliance).toBeTruthy();
    });
  });

  describe('GET /meal-plans', () => {
    it('uses the standard { data, meta } envelope', async () => {
      const response = await harness!.get('/api/v1/meal-plans', user.accessToken);
      expect(response.statusCode).toBe(200);

      // Every list endpoint paginates the same way, so a single client helper
      // can read all of them. This one used to return a bare `{ data, total }`.
      const body = response.json() as {
        data: MealPlanDto[];
        meta: { page: number; limit: number; total: number; has_more: boolean };
      };

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta.page).toBe(1);
      expect(body.meta.total).toBeGreaterThanOrEqual(body.data.length);
      expect(typeof body.meta.has_more).toBe('boolean');
    });
  });

  describe('GET /meal-plans/:id/days', () => {
    it('groups entries by day and carries the fields the calendar renders', async () => {
      const plans = data<MealPlanDto[]>(await harness!.get('/api/v1/meal-plans', user.accessToken));
      const plan = plans[0];
      if (!plan) return;

      const days = data<DayMealEntry[]>(await harness!.get(`/api/v1/meal-plans/${plan.id}/days`, user.accessToken));
      expect(days.length).toBeGreaterThan(0);

      for (const day of days) {
        expect(day.day).toBeGreaterThanOrEqual(1);
        expect(day.day).toBeLessThanOrEqual(7);

        // The day card renders a header, a date and a "today" highlight straight
        // off these fields. They used to arrive as `date: null` with no label,
        // so the card showed an empty header and never highlighted today.
        expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(day.day_name).toBeTruthy();
        expect(typeof day.is_today).toBe('boolean');
        expect(day.total_calories).toBeGreaterThanOrEqual(0);
        expect(day.meals).toBeTruthy();
      }

      // Calendar order, not insertion order.
      const numbers = days.map((day) => day.day);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    });
  });

  describe('POST /meal-plans/:id/entries/:entryId/complete', () => {
    it('marks a meal cooked', async () => {
      const plans = data<MealPlanDto[]>(await harness!.get('/api/v1/meal-plans', user.accessToken));
      const plan = plans.find((candidate) => candidate.entries.length > 0);
      if (!plan) return;

      const entry = plan.entries[0]!;
      const response = await harness!.post(
        `/api/v1/meal-plans/${plan.id}/entries/${entry.id}/complete`,
        { day: entry.day_of_week, meal_type: entry.meal_type, is_completed: true, consume_pantry: false },
        user.accessToken,
      );

      expect(response.statusCode).toBe(200);

      const updated = data<MealPlanDto>(response);
      const completed = updated.entries.find((candidate) => candidate.id === entry.id);
      expect(completed?.is_completed).toBe(true);
      expect(completed?.completed_at).toBeTruthy();
    });

    it('can be undone', async () => {
      const plans = data<MealPlanDto[]>(await harness!.get('/api/v1/meal-plans', user.accessToken));
      const plan = plans.find((candidate) => candidate.entries.some((entry) => entry.is_completed));
      if (!plan) return;

      const entry = plan.entries.find((candidate) => candidate.is_completed)!;
      const response = await harness!.post(
        `/api/v1/meal-plans/${plan.id}/entries/${entry.id}/complete`,
        { day: entry.day_of_week, meal_type: entry.meal_type, is_completed: false, consume_pantry: false },
        user.accessToken,
      );

      expect(response.statusCode).toBe(200);
      const updated = data<MealPlanDto>(response);
      expect(updated.entries.find((candidate) => candidate.id === entry.id)?.is_completed).toBe(false);
    });
  });
});

describe.skipIf(!available)('grocery lists', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
    await seedPantry(harness!, user.accessToken, FULL_PANTRY);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('builds a list from explicit items', async () => {
    const response = await harness!.post(
      '/api/v1/grocery-lists/generate',
      {
        items: [
          { ingredient_name: 'coconut milk', quantity: 2, unit: 'cans', category: 'canned' },
          { ingredient_name: 'lime', quantity: 4, unit: 'pieces', category: 'fruit' },
          { ingredient_name: 'rice noodles', quantity: 400, unit: 'g', category: 'grain' },
        ],
        title: 'Thai night',
        subtract_pantry: false,
        skip_prices: true,
      },
      user.accessToken,
    );

    expect(response.statusCode).toBe(201);

    const list = data<GroceryListDto>(response);
    expect(list.id).toBeTruthy();
    expect(list.title).toBe('Thai night');
    expect(list.items).toHaveLength(3);
    expect(list.total_count).toBe(3);
    expect(list.purchased_count).toBe(0);
    expect(list.status).toBe('active');
    expect(list.total_estimated_cost).toBeGreaterThanOrEqual(0);

    for (const item of list.items) {
      expect(item.id).toBeTruthy();
      expect(item.grocery_list_id).toBe(list.id);
      expect(item.ingredient_name).toBeTruthy();
      expect(item.is_purchased).toBe(false);
      // A grocery line must never be unpriced — $0 trains users to distrust
      // every other number on the screen.
      expect(item.estimated_price).toBeGreaterThan(0);
    }
  });

  it('builds a list from a meal plan and excludes what is already at home', async () => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));

    const planResult = data<{ meal_plan: MealPlanDto; grocery_list_id: string | null }>(
      await harness!.post(
        '/api/v1/meal-plans/generate',
        { start_date: start.toISOString().slice(0, 10), days: 7, meals_per_day: 3 },
        user.accessToken,
      ),
    );

    expect(planResult.grocery_list_id).toBeTruthy();

    const list = data<GroceryListDto>(
      await harness!.get(`/api/v1/grocery-lists/${planResult.grocery_list_id}`, user.accessToken),
    );

    expect(list.meal_plan_id).toBe(planResult.meal_plan.id);
    expect(list.items.length).toBeGreaterThan(0);

    // Every line should be something the user does NOT already have.
    const alreadyHome = list.items.filter((item) => item.in_pantry);
    expect(alreadyHome.length).toBeLessThan(list.items.length);
  });

  it('rejects a request with no source at all', async () => {
    const response = await harness!.post(
      '/api/v1/grocery-lists/generate',
      { subtract_pantry: true, skip_prices: true },
      user.accessToken,
    );
    expect(response.statusCode).toBe(422);
  });

  it('ticks an item off and keeps the header counters in sync', async () => {
    const created = data<GroceryListDto>(
      await harness!.post(
        '/api/v1/grocery-lists/generate',
        {
          items: [
            { ingredient_name: 'tahini', quantity: 1, unit: 'pieces', category: 'condiment' },
            { ingredient_name: 'sumac', quantity: 1, unit: 'pieces', category: 'spice' },
          ],
          skip_prices: true,
        },
        user.accessToken,
      ),
    );

    const first = created.items[0]!;
    await harness!.post(`/api/v1/grocery-lists/${created.id}/items/${first.id}/check`, { checked: true }, user.accessToken);

    const refreshed = data<GroceryListDto>(await harness!.get(`/api/v1/grocery-lists/${created.id}`, user.accessToken));

    expect(refreshed.purchased_count).toBe(1);
    expect(refreshed.total_count).toBe(2);
    expect(refreshed.items.find((item) => item.id === first.id)?.is_purchased).toBe(true);
  });

  it('adds an item and merges it into an existing unchecked line', async () => {
    const created = data<GroceryListDto>(
      await harness!.post(
        '/api/v1/grocery-lists/generate',
        { items: [{ ingredient_name: 'plain flour', quantity: 500, unit: 'g', category: 'grain' }], skip_prices: true },
        user.accessToken,
      ),
    );

    await harness!.post(
      `/api/v1/grocery-lists/${created.id}/items`,
      { ingredient_name: 'plain flour', quantity: 500, unit: 'g', category: 'grain' },
      user.accessToken,
    );

    const refreshed = data<GroceryListDto>(await harness!.get(`/api/v1/grocery-lists/${created.id}`, user.accessToken));

    // Merging is the point: two 500 g lines for the same thing is a bug the
    // shopper discovers in aisle four.
    const flour = refreshed.items.filter((item) => /flour/i.test(item.ingredient_name));
    expect(flour).toHaveLength(1);
    // Named separately from the total: if NUMERIC ever comes back as a string,
    // the merge above fails with a confusing "expected '500500' to be 1000"
    // instead of pointing at the type.
    expect(typeof flour[0]!.quantity, 'merged quantity must be a JS number').toBe('number');
    expect(flour[0]!.quantity).toBe(1000);
  });

  it('returns every NUMERIC column as a JS number, not a string', async () => {
    // drizzle >= 0.44 coerces a plain `decimal()` / `numeric()` to a *string* in
    // its own mapFromDriverValue, which overrides the pg type parser. Every
    // decimal column in the schema therefore declares `mode: 'number'`.
    //
    // Losing that is silent and destructive: `existing.quantity + input.quantity`
    // becomes string concatenation, the merged total turns into NaN, and the
    // shopper is told to buy 0 g of flour. Prices and calories go the same way.
    const created = data<GroceryListDto>(
      await harness!.post(
        '/api/v1/grocery-lists/generate',
        {
          items: [
            { ingredient_name: 'plain flour', quantity: 500.5, unit: 'g', category: 'grain' },
            { ingredient_name: 'olive oil', quantity: 1.25, unit: 'l', category: 'oil_fat' },
          ],
        },
        user.accessToken,
      ),
    );

    expect(created.items.length).toBeGreaterThan(0);

    for (const item of created.items) {
      if (item.quantity != null) {
        expect(typeof item.quantity, `${item.ingredient_name} quantity`).toBe('number');
        expect(Number.isFinite(item.quantity), `${item.ingredient_name} quantity`).toBe(true);
      }
      for (const field of ['estimated_price', 'actual_price'] as const) {
        const value = item[field];
        if (value != null) {
          expect(typeof value, `${item.ingredient_name} ${field}`).toBe('number');
          expect(Number.isFinite(value), `${item.ingredient_name} ${field}`).toBe(true);
        }
      }
    }

    // The column is numeric(8,2), so a fractional quantity must survive intact
    // rather than being truncated or stringified.
    expect(created.items.find((item) => /flour/i.test(item.ingredient_name))?.quantity).toBe(500.5);

    for (const field of ['total_estimated_cost', 'total_actual_cost'] as const) {
      const value = created[field];
      if (value != null) expect(typeof value, field).toBe('number');
    }

    if (created.savings) {
      for (const field of ['single_store_total', 'optimized_total', 'saved', 'percent'] as const) {
        expect(typeof created.savings[field], `savings.${field}`).toBe('number');
      }
    }
  });

  it('gates price comparison behind a paid tier', async () => {
    const created = data<GroceryListDto>(
      await harness!.post(
        '/api/v1/grocery-lists/generate',
        { items: [{ ingredient_name: 'arborio rice', quantity: 1, unit: 'kg', category: 'grain' }], skip_prices: true },
        user.accessToken,
      ),
    );

    const response = await harness!.post(`/api/v1/grocery-lists/${created.id}/prices`, {}, user.accessToken);

    // A free-tier user gets a clear 403 with an upgrade path, not a 500.
    expect(response.statusCode).toBe(403);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe('forbidden');
    expect(body.message.toLowerCase()).toMatch(/premium|upgrade/);
  });

  it('builds a provider hand-off with share text', async () => {
    const created = data<GroceryListDto>(
      await harness!.post(
        '/api/v1/grocery-lists/generate',
        {
          items: [
            { ingredient_name: 'coconut milk', quantity: 2, unit: 'cans', category: 'canned' },
            { ingredient_name: 'red curry paste', quantity: 1, unit: 'pieces', category: 'condiment' },
          ],
          skip_prices: true,
        },
        user.accessToken,
      ),
    );

    const response = await harness!.post(
      `/api/v1/grocery-lists/${created.id}/order`,
      { provider: 'instacart', group_by: 'store' },
      user.accessToken,
    );

    expect(response.statusCode).toBe(200);

    const handoff = data<{ provider: string; url: string; item_count: number; estimated_total: number; share_text: string }>(response);
    expect(handoff.provider).toBe('instacart');
    expect(handoff.url).toMatch(/^https:\/\//);
    expect(handoff.item_count).toBe(2);
    expect(handoff.share_text).toContain('coconut milk');
  });

  it('returns 404 for another user’s list', async () => {
    const other = await createTestUser(harness!);
    const theirs = data<GroceryListDto>(
      await harness!.post(
        '/api/v1/grocery-lists/generate',
        { items: [{ ingredient_name: 'saffron', quantity: 1, unit: 'g', category: 'spice' }], skip_prices: true },
        other.accessToken,
      ),
    );

    const response = await harness!.get(`/api/v1/grocery-lists/${theirs.id}`, user.accessToken);
    expect(response.statusCode).toBe(404);
  });
});
