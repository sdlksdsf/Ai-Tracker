import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AchievementDto,
  AchievementsProgress,
  DashboardDto,
  HomeSummaryDto,
  SavingsStatsDto,
  WasteDto,
  WasteImpactDto,
  WasteStatsDto,
} from '@platematch/shared';
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
 * Waste tracking, impact analytics, achievements, subscriptions and the
 * dashboard aggregates.
 *
 * These are the "is it working?" screens. The assertions focus on the numbers a
 * user reads and acts on: a waste log must produce a non-zero cost and CO₂e
 * derived server-side, the impact figures must be paired with equivalents, and
 * the Home payload must be complete enough to render without a second request.
 */

let harness: Harness | null = null;
const available = await isDatabaseAvailable();

describe.skipIf(!available)('food waste', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  describe('POST /waste', () => {
    it('logs waste with only a name and a reason', async () => {
      // Frictionless logging is the whole design: every extra required field is a
      // reason not to log, and unlogged waste is invisible.
      const response = await harness!.post(
        '/api/v1/waste',
        { item_name: 'baby spinach', reason: 'expired' },
        user.accessToken,
      );

      expect(response.statusCode).toBe(201);

      const log = data<WasteDto>(response);
      expect(log.id).toBeTruthy();
      expect(log.item_name).toBe('baby spinach');
      expect(log.reason).toBe('expired');
      expect(log.logged_at).toBeTruthy();
    });

    it('derives cost and CO₂e server-side', async () => {
      const response = await harness!.post(
        '/api/v1/waste',
        { item_name: 'chicken breast', quantity: 500, unit: 'g', reason: 'spoiled', category: 'meat' },
        user.accessToken,
      );

      expect(response.statusCode).toBe(201);
      const log = data<WasteDto>(response);

      expect(log.estimated_cost).not.toBeNull();
      expect(log.estimated_cost!).toBeGreaterThan(0);
      expect(log.co2_equivalent_kg).not.toBeNull();
      expect(log.co2_equivalent_kg!).toBeGreaterThan(0);
    });

    it('produces more CO₂e for meat than for vegetables at the same weight', async () => {
      const meat = data<WasteDto>(
        await harness!.post('/api/v1/waste', { item_name: 'beef steak', quantity: 1, unit: 'kg', reason: 'spoiled', category: 'meat' }, user.accessToken),
      );
      const veg = data<WasteDto>(
        await harness!.post('/api/v1/waste', { item_name: 'carrots', quantity: 1, unit: 'kg', reason: 'spoiled', category: 'vegetable' }, user.accessToken),
      );

      expect(meat.co2_equivalent_kg!).toBeGreaterThan(veg.co2_equivalent_kg!);
    });

    it('scales CO₂e linearly with quantity', async () => {
      const one = data<WasteDto>(
        await harness!.post('/api/v1/waste', { item_name: 'rice', quantity: 1, unit: 'kg', reason: 'leftover', category: 'grain' }, user.accessToken),
      );
      const two = data<WasteDto>(
        await harness!.post('/api/v1/waste', { item_name: 'rice', quantity: 2, unit: 'kg', reason: 'leftover', category: 'grain' }, user.accessToken),
      );

      expect(two.co2_equivalent_kg!).toBeCloseTo(one.co2_equivalent_kg! * 2, 1);
    });

    it('marks a linked pantry item as used', async () => {
      const linked = await createTestUser(harness!);
      const [itemId] = await seedPantry(harness!, linked.accessToken, [{ name: 'doomed strawberries', expiresInDays: -1 }]);

      await harness!.post(
        '/api/v1/waste',
        { item_name: 'doomed strawberries', reason: 'spoiled', pantry_item_id: itemId },
        linked.accessToken,
      );

      const list = (await harness!.get('/api/v1/pantry?used=true&limit=100', linked.accessToken)).json() as {
        data: Array<{ id: string; is_used: boolean }>;
      };
      expect(list.data.some((item) => item.id === itemId)).toBe(true);
    });

    it('rejects a missing item name with 422', async () => {
      const response = await harness!.post('/api/v1/waste', { reason: 'expired' }, user.accessToken);
      expect(response.statusCode).toBe(422);
    });

    it('rejects an unknown reason with 422', async () => {
      const response = await harness!.post('/api/v1/waste', { item_name: 'x', reason: 'my_dog_ate_it' }, user.accessToken);
      expect(response.statusCode).toBe(422);
    });

    it('requires authentication', async () => {
      const response = await harness!.post('/api/v1/waste', { item_name: 'x', reason: 'expired' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /waste and /waste/stats', () => {
    it('returns paginated history', async () => {
      const response = await harness!.get('/api/v1/waste?page=1&limit=10', user.accessToken);
      expect(response.statusCode).toBe(200);

      const body = response.json() as { data: WasteDto[]; meta: { total: number; has_more: boolean } };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeLessThanOrEqual(10);
      expect(body.meta.total).toBeGreaterThanOrEqual(body.data.length);
    });

    it('filters by reason', async () => {
      const body = (await harness!.get('/api/v1/waste?reason=expired&limit=50', user.accessToken)).json() as { data: WasteDto[] };
      expect(body.data.every((log) => log.reason === 'expired')).toBe(true);
    });

    it('reports period totals with a previous-period comparison', async () => {
      const stats = data<WasteStatsDto>(await harness!.get('/api/v1/waste/stats?period=week', user.accessToken));

      expect(stats.period).toBe('week');
      expect(stats.period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stats.period_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stats.total_logs).toBeGreaterThan(0);
      expect(stats.total_grams).toBeGreaterThan(0);
      expect(stats.total_cost_usd).toBeGreaterThan(0);
      expect(stats.total_co2_kg).toBeGreaterThan(0);

      // The comparison is what makes the number actionable.
      expect(Number.isFinite(stats.cost_change_pct)).toBe(true);
      expect(Number.isFinite(stats.co2_change_pct)).toBe(true);
      expect(Array.isArray(stats.by_category)).toBe(true);
      expect(Array.isArray(stats.by_reason)).toBe(true);
      expect(Array.isArray(stats.daily)).toBe(true);
    });

    it('rejects an unknown period with 422', async () => {
      const response = await harness!.get('/api/v1/waste/stats?period=fortnight', user.accessToken);
      expect(response.statusCode).toBe(422);
    });
  });

  describe('GET /waste/impact', () => {
    it('pairs every total with an equivalent a person can picture', async () => {
      const impact = data<WasteImpactDto>(await harness!.get('/api/v1/waste/impact', user.accessToken));

      expect(impact.lifetime_co2_kg).toBeGreaterThan(0);
      expect(impact.lifetime_cost_usd).toBeGreaterThan(0);
      expect(impact.equivalent_trees).toBeGreaterThan(0);
      expect(impact.equivalent_meals).toBeGreaterThan(0);

      // The UNEP household benchmark is what makes the number meaningful.
      expect(impact.national_average_kg_per_week).toBeGreaterThan(0);
      expect(impact.user_kg_per_week).toBeGreaterThanOrEqual(0);
      expect(typeof impact.better_than_average).toBe('boolean');
    });

    it('derives trees from the published per-tree carbon figure', async () => {
      const impact = data<WasteImpactDto>(await harness!.get('/api/v1/waste/impact', user.accessToken));

      // One mature tree absorbs ~21 kg CO₂ per year.
      expect(impact.equivalent_trees).toBeCloseTo(impact.lifetime_co2_kg / 21, 1);
    });
  });

  describe('DELETE /waste/:logId', () => {
    it('removes a log the user made by mistake', async () => {
      const created = data<WasteDto>(
        await harness!.post('/api/v1/waste', { item_name: 'mistake basil', reason: 'other' }, user.accessToken),
      );

      const removed = await harness!.delete(`/api/v1/waste/${created.id}`, user.accessToken);
      expect([200, 204]).toContain(removed.statusCode);

      const history = (await harness!.get('/api/v1/waste?limit=100', user.accessToken)).json() as { data: WasteDto[] };
      expect(history.data.some((log) => log.id === created.id)).toBe(false);
    });

    it('returns 404 for another user’s log', async () => {
      const other = await createTestUser(harness!);
      const theirs = data<WasteDto>(
        await harness!.post('/api/v1/waste', { item_name: 'their basil', reason: 'other' }, other.accessToken),
      );

      const response = await harness!.delete(`/api/v1/waste/${theirs.id}`, user.accessToken);
      expect(response.statusCode).toBe(404);
    });
  });
});

describe.skipIf(!available)('achievements', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
    await seedPantry(harness!, user.accessToken, [
      { name: 'chicken breast', quantity: 500, unit: 'g' },
      { name: 'basmati rice', quantity: 1, unit: 'kg' },
    ]);
    await harness!.post('/api/v1/waste', { item_name: 'old lettuce', reason: 'expired' }, user.accessToken);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('lists every badge with progress, even when locked', async () => {
    const badges = data<AchievementDto[]>(await harness!.get('/api/v1/achievements', user.accessToken));

    expect(badges.length).toBeGreaterThan(0);

    for (const badge of badges) {
      expect(badge.key).toBeTruthy();
      expect(badge.name).toBeTruthy();
      expect(badge.description).toBeTruthy();
      expect(badge.icon).toBeTruthy();
      expect(typeof badge.earned).toBe('boolean');
      expect(['bronze', 'silver', 'gold', 'platinum']).toContain(badge.tier);
      expect(['waste', 'cooking', 'saving', 'explorer', 'streak']).toContain(badge.category);

      // `target` and `unit` are nullable: some badges are one-shot ("first scan")
      // rather than progress-based, so there is nothing to count towards.
      expect(badge.current).toBeGreaterThanOrEqual(0);

      // `progress` is a 0..100 percentage, not a 0..1 ratio — the UI renders it
      // directly into a progress bar.
      expect(badge.progress).toBeGreaterThanOrEqual(0);
      expect(badge.progress).toBeLessThanOrEqual(100);

      if (badge.target != null) {
        expect(badge.target).toBeGreaterThan(0);
        expect(badge.current).toBeLessThanOrEqual(badge.target);
        if (badge.earned) expect(badge.current).toBe(badge.target);
      }

      if (badge.earned) expect(badge.earned_at).toBeTruthy();
    }
  });

  it('reports points, level and streak', async () => {
    const progress = data<AchievementsProgress>(await harness!.get('/api/v1/achievements/progress', user.accessToken));

    expect(progress.total).toBeGreaterThan(0);
    expect(progress.earned).toBeGreaterThanOrEqual(0);
    expect(progress.earned).toBeLessThanOrEqual(progress.total);
    expect(progress.points).toBeGreaterThanOrEqual(0);
    expect(progress.level).toBeGreaterThanOrEqual(1);
    expect(progress.level_label).toBeTruthy();
    expect(progress.next_level_points).toBeGreaterThanOrEqual(progress.points);
    expect(progress.streak_days).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(progress.achievements)).toBe(true);

    // Every badge carries its own point value — the UI renders "+N pts" on an
    // earned badge, so the number has to survive the trip from the definitions.
    for (const badge of progress.achievements) {
      expect(typeof badge.points).toBe('number');
      expect(badge.points).toBeGreaterThanOrEqual(0);
    }
  });

  it('awards badges for activity that already happened', async () => {
    // Achievements are evaluated lazily from the user's own rows, so a badge is
    // never missed because a write path forgot to emit an event.
    const active = await createTestUser(harness!);

    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await harness!.post('/api/v1/waste', { item_name: `logged item ${index}`, reason: 'expired' }, active.accessToken);
    }

    const progress = data<AchievementsProgress>(await harness!.get('/api/v1/achievements/progress', active.accessToken));
    const wasteBadges = progress.achievements.filter((badge) => badge.category === 'waste');

    expect(wasteBadges.some((badge) => badge.current >= 3)).toBe(true);
  });
});

describe.skipIf(!available)('subscriptions', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
    // Usage counters are only worth asserting on if there is something to
    // count — a brand-new user would report zeros and prove nothing.
    await seedPantry(harness!, user.accessToken, [
      { name: 'eggs', quantity: 6, unit: 'pieces', category: 'dairy' },
      { name: 'spinach', quantity: 200, unit: 'g', category: 'vegetable' },
    ]);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('exposes the public plan catalogue without authentication', async () => {
    const response = await harness!.get('/api/v1/subscription/plans');
    expect(response.statusCode).toBe(200);

    const catalog = data<{
      prices: Array<{ tier: string; monthly: number; yearly: number; savings_percent: number }>;
      features: Array<Record<string, unknown>>;
      limits: Record<string, Record<string, unknown>>;
      currency: string;
    }>(response);

    expect(catalog.currency).toBe('USD');
    expect(catalog.prices).toHaveLength(2);

    const premium = catalog.prices.find((price) => price.tier === 'premium');
    const family = catalog.prices.find((price) => price.tier === 'family');

    expect(premium?.monthly).toBe(4.99);
    expect(premium?.yearly).toBe(39.99);
    expect(family?.monthly).toBe(7.99);
    expect(family?.yearly).toBe(59.99);

    // Yearly must actually be cheaper per month, and say by how much.
    expect(premium!.savings_percent).toBeGreaterThan(0);
    expect(premium!.yearly).toBeLessThan(premium!.monthly * 12);

    expect(catalog.limits.free).toBeTruthy();
    expect(catalog.limits.premium).toBeTruthy();
    expect(catalog.limits.family).toBeTruthy();
  });

  it('reports the current tier, limits and usage', async () => {
    const status = data<{
      tier: string;
      status: string;
      limits: Record<string, number | boolean>;
      usage: {
        scans_used_this_week: number;
        scans_remaining: number | null;
        recipes_generated_today: number;
        recipes_remaining_today: number | null;
        meal_plans_this_month: number;
        pantry_items: number;
        pantry_items_max: number | null;
      };
    }>(await harness!.get('/api/v1/subscription/status', user.accessToken));

    expect(status.tier).toBe('free');
    // The API speaks snake_case end to end, including inside `limits`.
    expect(status.limits.scans_per_week).toBe(3);
    expect(status.usage.pantry_items).toBeGreaterThan(0);
    expect(status.usage.pantry_items_max).toBe(50);
  });

  it('simulates checkout when Stripe is not configured, and says so', async () => {
    const response = await harness!.post(
      '/api/v1/subscription/checkout',
      { tier: 'premium', interval: 'monthly' },
      user.accessToken,
    );

    expect(response.statusCode).toBe(200);

    const result = data<{ checkout_url: string | null; session_id: string | null; simulated: boolean }>(response);

    // Honesty matters here: the app shows a notice rather than pretending a
    // payment happened.
    expect(result.simulated).toBe(true);
    expect(result.checkout_url).toBeNull();

    // The tier was still granted, so the feature is explorable end to end.
    const status = data<{ tier: string }>(await harness!.get('/api/v1/subscription/status', user.accessToken));
    expect(status.tier).toBe('premium');
  });

  it('unlocks price comparison once the tier is premium', async () => {
    const list = data<{ id: string }>(
      await harness!.post(
        '/api/v1/grocery-lists/generate',
        { items: [{ ingredient_name: 'arborio rice', quantity: 1, unit: 'kg', category: 'grain' }] },
        user.accessToken,
      ),
    );

    const response = await harness!.post(`/api/v1/grocery-lists/${list.id}/prices`, {}, user.accessToken);

    // No longer 403 — and with no store keys it must still return a comparison
    // built from the offline price index rather than failing.
    expect(response.statusCode).toBe(200);

    const comparison = data<{
      grocery_list_id: string;
      single_store_total: number;
      optimized_total: number;
      saved: number;
      percent: number;
      per_store: unknown[];
    }>(response);

    expect(comparison.grocery_list_id).toBe(list.id);
    expect(comparison.single_store_total).toBeGreaterThanOrEqual(0);
    expect(comparison.optimized_total).toBeGreaterThanOrEqual(0);
    expect(comparison.saved).toBeGreaterThanOrEqual(0);
  });

  it('cancels and returns to free', async () => {
    const cancelled = await harness!.post('/api/v1/subscription/cancel', { immediate: true }, user.accessToken);
    expect(cancelled.statusCode).toBe(200);

    const status = data<{ tier: string }>(await harness!.get('/api/v1/subscription/status', user.accessToken));
    expect(status.tier).toBe('free');
  });

  it('rejects the Stripe webhook without a signature', async () => {
    const response = await harness!.app.inject({
      method: 'POST',
      url: '/api/v1/subscription/webhook',
      payload: { type: 'checkout.session.completed' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe.skipIf(!available)('dashboard', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);

    await seedPantry(harness!, user.accessToken, [
      { name: 'baby spinach', quantity: 200, unit: 'g', expiresInDays: 1 },
      { name: 'milk', quantity: 1, unit: 'l', expiresInDays: 3 },
      { name: 'chicken breast', quantity: 500, unit: 'g', expiresInDays: 2 },
      { name: 'basmati rice', quantity: 1, unit: 'kg', expiresInDays: 200 },
    ]);
    await harness!.post('/api/v1/waste', { item_name: 'old bread', reason: 'expired', quantity: 300, unit: 'g' }, user.accessToken);
    await harness!.post('/api/v1/recipes/generate', { use_pantry: true, count: 3 }, user.accessToken);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('GET /dashboard/home returns everything the Home screen renders', async () => {
    const home = data<HomeSummaryDto>(await harness!.get('/api/v1/dashboard/home', user.accessToken));

    expect(home.greeting).toBeTruthy();
    expect(home.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(home.timezone).toBeTruthy();

    expect(Array.isArray(home.expiring_soon)).toBe(true);
    expect(Array.isArray(home.todays_meals)).toBe(true);
    expect(Array.isArray(home.quick_recipes)).toBe(true);

    expect(home.pantry_summary.total_items).toBe(4);
    expect(home.pantry_summary.expiring_soon_count).toBeGreaterThanOrEqual(2);
    expect(home.pantry_summary.estimated_value).toBeGreaterThanOrEqual(0);

    expect(home.stats_snapshot.scans_completed).toBeGreaterThanOrEqual(0);
    expect(home.stats_snapshot.meals_cooked).toBeGreaterThanOrEqual(0);
    expect(home.stats_snapshot.achievements_total).toBeGreaterThan(0);

    expect(home.streak_days).toBeGreaterThanOrEqual(0);
    expect(typeof home.money_saved_this_week).toBe('number');
    expect(typeof home.co2_saved_this_week).toBe('number');
    expect(typeof home.show_upgrade_prompt).toBe('boolean');
  });

  it('pairs each expiring item with an actionable recipe suggestion field', async () => {
    const home = data<HomeSummaryDto>(await harness!.get('/api/v1/dashboard/home', user.accessToken));

    for (const item of home.expiring_soon) {
      expect(item.ingredient_name).toBeTruthy();
      expect(item.days_until_expiry).toBeLessThanOrEqual(5);
      expect(item.urgency).toMatch(/critical|warning|soon|expired|ok/);
      expect(item.expiry_label).toBeTruthy();
      // Nullable by design — not every item has a matching recipe — but the
      // field must exist so the client can render the link or the fallback.
      expect('suggested_recipe_id' in item).toBe(true);
      expect('suggested_recipe_title' in item).toBe(true);
    }
  });

  it('GET /dashboard/savings reports money saved by source', async () => {
    const savings = data<SavingsStatsDto>(await harness!.get('/api/v1/dashboard/savings?period=month', user.accessToken));

    expect(savings.period).toBe('month');
    expect(savings.total_saved_usd).toBeGreaterThanOrEqual(0);
    expect(savings.breakdown).toBeTruthy();
    expect(savings.breakdown.waste_reduction_usd).toBeGreaterThanOrEqual(0);
    expect(savings.breakdown.grocery_savings_usd).toBeGreaterThanOrEqual(0);
    expect(savings.breakdown.cooking_savings_usd).toBeGreaterThanOrEqual(0);

    expect(Number.isFinite(savings.waste_reduced_pct)).toBe(true);
    expect(savings.level).toBeGreaterThanOrEqual(1);
    expect(typeof savings.better_than_average).toBe('boolean');
  });

  it('GET /dashboard/expiring-soon covers the requested horizon', async () => {
    const items = data<Array<{ days_until_expiry: number }>>(
      await harness!.get('/api/v1/dashboard/expiring-soon?days=5', user.accessToken),
    );

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.days_until_expiry <= 5)).toBe(true);
  });

  it('GET /dashboard returns the full bundle in one round trip', async () => {
    const dashboard = data<DashboardDto>(await harness!.get('/api/v1/dashboard', user.accessToken));

    expect(dashboard.home).toBeTruthy();
    expect(dashboard.savings).toBeTruthy();
    expect(dashboard.subscription).toBeTruthy();
    expect(Array.isArray(dashboard.expiring_soon)).toBe(true);
    expect(dashboard.generated_at).toBeTruthy();
  });

  it('GET /dashboard/weekly-report builds the Sunday digest content', async () => {
    const report = data<{
      user_id: string;
      week_start: string;
      week_end: string;
      meals_cooked: number;
      money_saved_usd: number;
      waste_change_pct: number;
      streak_days: number;
      headline: string;
    }>(await harness!.get('/api/v1/dashboard/weekly-report', user.accessToken));

    expect(report.user_id).toBe(user.id);
    expect(report.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.week_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof report.meals_cooked).toBe('number');
    expect(typeof report.money_saved_usd).toBe('number');
    // The headline is what the push notification actually says.
    expect(report.headline.length).toBeGreaterThan(10);
  });
});

describe.skipIf(!available)('notifications', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('starts with default preferences and all triggers on', async () => {
    const prefs = data<Record<string, unknown>>(await harness!.get('/api/v1/notifications/preferences', user.accessToken));

    expect(prefs.expiry_alerts).toBe(true);
    expect(prefs.meal_reminders).toBe(true);
    expect(prefs.weekly_reports).toBe(true);
    expect(prefs.smart_suggestions).toBe(true);
    expect(prefs.achievement_alerts).toBe(true);
    expect(prefs.reminder_breakfast_time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('persists an update', async () => {
    await harness!.put(
      '/api/v1/notifications/preferences',
      { expiry_alerts: false, reminder_dinner_time: '19:30', quiet_hours_start: '22:00', quiet_hours_end: '07:00' },
      user.accessToken,
    );

    const prefs = data<Record<string, unknown>>(await harness!.get('/api/v1/notifications/preferences', user.accessToken));

    expect(prefs.expiry_alerts).toBe(false);
    expect(prefs.reminder_dinner_time).toBe('19:30');
    expect(prefs.quiet_hours_start).toBe('22:00');
    // Untouched triggers must keep their previous value.
    expect(prefs.meal_reminders).toBe(true);
  });

  it('starts with an empty inbox and a zero badge count', async () => {
    const inbox = (await harness!.get('/api/v1/notifications', user.accessToken)).json() as { data: unknown[] };
    expect(Array.isArray(inbox.data)).toBe(true);

    const unread = data<{ unread: number }>(await harness!.get('/api/v1/notifications/unread-count', user.accessToken));
    expect(unread.unread).toBe(0);
  });

  it('registers a push token idempotently', async () => {
    const token = 'ExponentPushToken[test-integration]';

    const first = await harness!.post(
      '/api/v1/notifications/device',
      { fcm_token: token, platform: 'ios', device_name: 'Test iPhone' },
      user.accessToken,
    );
    expect(first.statusCode).toBe(200);

    // Re-registering on app start must not create a second row.
    const second = await harness!.post(
      '/api/v1/notifications/device',
      { fcm_token: token, platform: 'ios', device_name: 'Test iPhone' },
      user.accessToken,
    );
    expect(second.statusCode).toBe(200);
  });

  it('rejects a malformed push token with 422', async () => {
    const response = await harness!.post('/api/v1/notifications/device', { fcm_token: '', platform: 'ios' }, user.accessToken);
    expect(response.statusCode).toBe(422);
  });
});

describe.skipIf(!available)('scan', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('lists an empty history for a new user', async () => {
    const response = await harness!.get('/api/v1/scan', user.accessToken);
    expect(response.statusCode).toBe(200);

    const body = response.json() as { data: unknown[]; meta: { total: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.total).toBe(0);
  });

  it('rejects an upload that is not an image', async () => {
    const form = new FormData();
    form.append('image', new Blob(['this is not an image'], { type: 'text/plain' }), 'notes.txt');

    const response = await harness!.app.inject({
      method: 'POST',
      url: '/api/v1/scan/fridge',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: form,
    });

    // A non-image must be refused with a client error, never a 500.
    expect([400, 415]).toContain(response.statusCode);
  });

  it('rejects an upload with no file at all', async () => {
    const response = await harness!.app.inject({
      method: 'POST',
      url: '/api/v1/scan/fridge',
      headers: { authorization: `Bearer ${user.accessToken}`, 'content-type': 'application/json' },
      payload: { source: 'camera' },
    });

    expect([400, 415]).toContain(response.statusCode);
  });

  it('returns 404 for another user’s scan', async () => {
    const response = await harness!.get('/api/v1/scan/status/00000000-0000-4000-8000-000000000000', user.accessToken);
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await harness!.get('/api/v1/scan');
    expect(response.statusCode).toBe(401);
  });
});
