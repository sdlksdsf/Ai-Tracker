import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  DashboardDto,
  ExpiringSoonItemDto,
  HomeSummaryDto,
  PantryItemDto,
  RecipeDto,
  SavingsStatsDto,
  TrendPoint,
} from '@platematch/shared';
import { getDb } from '../db/index.js';
import {
  fridgeScans,
  groceryLists,
  mealPlanEntries,
  mealPlans,
  pantryItems,
  recipeCookLog,
  recipes,
  users,
  foodWasteLogs,
  type PantryItem,
} from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { estimatePriceUsd, normalizeIngredient, round2 } from '../utils/food.js';
import { addDays, greetingForHour, hourInTimezone, periodStart, toIsoDate, todayInTimezone, todayUtc } from '../utils/dates.js';
import { getExpiringSoon, getPantryStats } from './pantry.service.js';
import { getWasteStats, getWasteImpact, wasteFreeStreak } from './waste.service.js';
import { getAchievementsProgress } from './achievement.service.js';
import { getSubscriptionStatus } from './subscription.service.js';
import { searchRecipes, getRecipeForUser, loadRecipe } from './recipe.service.js';
import { recipeToDto, type RecipeWithChildren } from './dto.js';

/**
 * Dashboard service — the Home screen, the Stats screen and the weekly report
 * payload (Section 6, Screens 5 and 12 + Section 7, trigger 3).
 *
 * Everything here is read-only and heavily cached: the Home screen is the most
 * requested endpoint in the app, so it is served from Redis for 60s and
 * invalidated whenever the pantry or a plan changes.
 */

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export async function getHomeSummary(userId: string): Promise<HomeSummaryDto> {
  const cacheKey = CacheKeys.dashboard(userId, 'home');
  const cached = await cache.get<HomeSummaryDto>(cacheKey);
  if (cached) return cached;

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    logger.warn({ userId }, 'Home summary requested for missing user');
    throw new Error('User not found');
  }

  const timezone = user.timezone ?? 'UTC';
  const today = todayInTimezone(timezone);

  const [expiringRows, pantryStats, todaysMeals, suggestions, wasteStats, progress, streak] = await Promise.all([
    getExpiringSoon(userId, 5),
    getPantryStats(userId),
    getTodaysMeals(userId, today),
    getQuickSuggestions(userId, 4),
    getWasteStats(userId, 'week'),
    getAchievementsProgress(userId),
    wasteFreeStreak(userId),
  ]);

  const [scanCount, cookCount] = await Promise.all([
    countScans(userId),
    countCookedMeals(userId),
  ]);

  const summary: HomeSummaryDto = {
    greeting: `${greetingForHour(hourInTimezone(timezone))}, ${user.fullName.split(' ')[0] || 'there'} 👋`,
    date: today,
    timezone,
    streak_days: progress.streak_days || streak,
    waste_free_days: streak,
    money_saved_this_week: wasteStats.money_saved_usd,
    co2_saved_this_week: wasteStats.co2_saved_kg,
    points: progress.points,
    level: progress.level,
    level_label: progress.level_label,
    expiring_soon: await toExpiringSoonDto(expiringRows),
    todays_meals: todaysMeals,
    quick_recipes: suggestions,
    pantry_summary: {
      total_items: pantryStats.total_items,
      expiring_soon_count: pantryStats.expiring_soon,
      expired_count: pantryStats.expired,
      estimated_value: pantryStats.total_estimated_value,
    },
    stats_snapshot: {
      scans_completed: scanCount,
      meals_cooked: cookCount,
      achievements_earned: progress.earned,
      achievements_total: progress.total,
    },
    subscription_tier: user.subscriptionTier,
    show_upgrade_prompt: user.subscriptionTier === 'free' && scanCount >= 2,
  };

  await cache.set(cacheKey, summary, 60);
  return summary;
}

async function getTodaysMeals(userId: string, today: string): Promise<HomeSummaryDto['todays_meals']> {
  const db = getDb();
  const dayOfWeek = new Date(`${today}T12:00:00Z`).getUTCDay();
  const normalizedDay = dayOfWeek === 0 ? 7 : dayOfWeek;

  const rows = await db
    .select({
      entryId: mealPlanEntries.id,
      mealType: mealPlanEntries.mealType,
      recipeId: mealPlanEntries.recipeId,
      servings: mealPlanEntries.servings,
      isCompleted: mealPlanEntries.isCompleted,
      planId: mealPlanEntries.mealPlanId,
      title: recipes.title,
      totalTimeMin: recipes.totalTimeMin,
      imageUrl: recipes.imageUrl,
      difficulty: recipes.difficulty,
    })
    .from(mealPlanEntries)
    .innerJoin(mealPlans, eq(mealPlans.id, mealPlanEntries.mealPlanId))
    .leftJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(
      and(
        eq(mealPlans.userId, userId),
        eq(mealPlans.status, 'active'),
        sql`(${mealPlanEntries.date} = ${today} OR ${mealPlanEntries.dayOfWeek} = ${normalizedDay})`,
      ),
    )
    .orderBy(sql`CASE ${mealPlanEntries.mealType} WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'dinner' THEN 3 ELSE 4 END`);

  return rows.map((row) => ({
    entry_id: row.entryId,
    plan_id: row.planId,
    meal_type: row.mealType as 'breakfast' | 'lunch' | 'dinner' | 'snack',
    recipe_id: row.recipeId,
    title: row.title ?? 'Planned meal',
    total_time_min: row.totalTimeMin,
    image_url: row.imageUrl,
    difficulty: row.difficulty,
    servings: row.servings,
    completed: row.isCompleted,
  }));
}

/** Recipes the user can cook right now, ranked by pantry coverage. */
async function getQuickSuggestions(userId: string, limit: number): Promise<RecipeDto[]> {
  const db = getDb();

  // Prefer recipes that use something about to expire.
  const expiringNames = await db
    .select({ name: pantryItems.ingredientName })
    .from(pantryItems)
    .where(
      and(
        eq(pantryItems.userId, userId),
        eq(pantryItems.isUsed, false),
        eq(pantryItems.isExpired, false),
        sql`${pantryItems.expiryDate} IS NOT NULL`,
        sql`${pantryItems.expiryDate} BETWEEN ${toIsoDate(todayUtc())} AND ${toIsoDate(addDays(todayUtc(), 3))}`,
      ),
    )
    .limit(3);

  for (const row of expiringNames) {
    const results = await searchRecipes({ userId, q: normalizeIngredient(row.name), limit, sort: 'best_match' });
    if (results.data.length >= limit) return results.data.slice(0, limit);
  }

  const fallback = await searchRecipes({ userId, limit, sort: 'best_match' });
  return fallback.data.slice(0, limit);
}

async function countScans(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(fridgeScans)
    .where(and(eq(fridgeScans.userId, userId), eq(fridgeScans.status, 'completed')));
  return Number(rows[0]?.count ?? 0);
}

async function countCookedMeals(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(recipeCookLog).where(eq(recipeCookLog.userId, userId));
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Stats / Savings
// ---------------------------------------------------------------------------

export type StatsPeriod = 'week' | 'month' | 'year';

export async function getSavingsStats(userId: string, period: StatsPeriod = 'month'): Promise<SavingsStatsDto> {
  const cacheKey = CacheKeys.dashboard(userId, `savings:${period}`);
  const cached = await cache.get<SavingsStatsDto>(cacheKey);
  if (cached) return cached;

  const db = getDb();
  const waste = await getWasteStats(userId, period === 'year' ? 'week' : period);
  const impact = await getWasteImpact(userId);
  const progress = await getAchievementsProgress(userId);

  const [cookAgg, groceryAgg, pantryAgg] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)::int`,
        cost: sql<number>`COALESCE(SUM(${recipes.totalCostEstimate} * 0.6), 0)::numeric`,
      })
      .from(recipeCookLog)
      .innerJoin(recipes, eq(recipes.id, recipeCookLog.recipeId))
      .where(eq(recipeCookLog.userId, userId)),
    db
      .select({ savings: sql<number>`COALESCE(SUM(${groceryLists.savingsAmount}), 0)::numeric` })
      .from(groceryLists)
      .where(eq(groceryLists.userId, userId)),
    db
      .select()
      .from(pantryItems)
      .where(and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false), eq(pantryItems.isExpired, false))),
  ]);

  const pantryValue = (pantryAgg as PantryItem[]).reduce(
    (sum, item) => sum + estimatePriceUsd(item.ingredientName, item.quantity ?? 1, item.unit ?? 'pcs'),
    0,
  );

  const mealsCooked = Number(cookAgg[0]?.count ?? 0);
  const grocerySavings = round2(Number(groceryAgg[0]?.savings ?? 0));
  const cookingSavings = round2(Number(cookAgg[0]?.cost ?? 0));
  const wasteSavings = waste.money_saved_usd;

  const totalSaved = round2(grocerySavings + cookingSavings + wasteSavings);

  const stats: SavingsStatsDto = {
    period,
    total_saved_usd: totalSaved,
    breakdown: {
      grocery_savings_usd: grocerySavings,
      cooking_savings_usd: cookingSavings,
      waste_reduction_usd: wasteSavings,
    },
    co2_saved_kg: round2(waste.co2_saved_kg + impact.lifetime_co2_kg * 0.1),
    lifetime_co2_kg: impact.lifetime_co2_kg,
    equivalent_trees: impact.equivalent_trees,
    equivalent_meals: impact.equivalent_meals,
    waste_reduced_pct: Math.max(0, -waste.cost_change_pct),
    meals_cooked: mealsCooked,
    pantry_value_usd: round2(pantryValue),
    streak_days: progress.streak_days,
    waste_free_days: waste.waste_free_days,
    points: progress.points,
    level: progress.level,
    level_label: progress.level_label,
    better_than_average: impact.better_than_average,
    national_average_kg_per_week: impact.national_average_kg_per_week,
    user_kg_per_week: impact.user_kg_per_week,
    trend: await savingsTrend(userId),
  };

  await cache.set(cacheKey, stats, 300);
  return stats;
}

/** 8 weekly points of money saved + CO₂ for the Stats line chart. */
async function savingsTrend(userId: string): Promise<TrendPoint[]> {
  const db = getDb();
  const points: TrendPoint[] = [];

  for (let i = 7; i >= 0; i -= 1) {
    const weekStart = new Date(periodStart('week').getTime() - i * 7 * 86_400_000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000 - 1);

    // eslint-disable-next-line no-await-in-loop
    const [row] = await db
      .select({
        cost: sql<number>`COALESCE(SUM(${groceryLists.savingsAmount}), 0)::numeric`,
      })
      .from(groceryLists)
      .where(and(eq(groceryLists.userId, userId), sql`${groceryLists.createdAt} BETWEEN ${weekStart} AND ${weekEnd}`));

    points.push({
      label: toIsoDate(weekStart),
      value: round2(Number(row?.cost ?? 0)),
    });
  }

  return points;
}

/** Combined dashboard payload for GET /dashboard. */
export async function getDashboard(userId: string): Promise<DashboardDto> {
  const [home, savings, subscription, expiring] = await Promise.all([
    getHomeSummary(userId),
    getSavingsStats(userId, 'week'),
    getSubscriptionStatus(userId),
    getExpiringSoonItems(userId, 7),
  ]);

  return {
    home,
    savings,
    subscription,
    expiring_soon: expiring,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Weekly report (Section 7, trigger 3)
// ---------------------------------------------------------------------------

export interface WeeklyReportDto {
  user_id: string;
  week_start: string;
  week_end: string;
  meals_cooked: number;
  scans_completed: number;
  grocery_lists_completed: number;
  money_saved_usd: number;
  co2_saved_kg: number;
  waste_change_pct: number;
  waste_logged_usd: number;
  top_wasted: Array<{ name: string; count: number; cost_usd: number }>;
  most_cooked_recipe: { id: string; title: string; times: number } | null;
  achievements_earned: number;
  streak_days: number;
  points: number;
  headline: string;
}

export async function buildWeeklyReport(userId: string): Promise<WeeklyReportDto> {
  const db = getDb();
  const start = periodStart('week');
  const end = new Date(start.getTime() + 7 * 86_400_000 - 1);

  const [cookRows, scanRows, groceryRows, topWaste, topRecipe] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(recipeCookLog).where(and(eq(recipeCookLog.userId, userId), sql`${recipeCookLog.cookedAt} BETWEEN ${start} AND ${end}`)),
    db.select({ count: sql<number>`count(*)::int` }).from(fridgeScans).where(and(eq(fridgeScans.userId, userId), sql`${fridgeScans.createdAt} BETWEEN ${start} AND ${end}`, eq(fridgeScans.status, 'completed'))),
    db
      .select({ count: sql<number>`count(*) FILTER (WHERE ${groceryLists.totalChecked} > 0)::int`, savings: sql<number>`COALESCE(SUM(${groceryLists.savingsAmount}), 0)::numeric` })
      .from(groceryLists)
      .where(and(eq(groceryLists.userId, userId), sql`${groceryLists.createdAt} BETWEEN ${start} AND ${end}`)),
    db
      .select({
        name: foodWasteLogs.ingredientName,
        count: sql<number>`count(*)::int`,
        cost: sql<number>`COALESCE(SUM(${foodWasteLogs.estimatedCostUsd}), 0)::numeric`,
      })
      .from(foodWasteLogs)
      .where(and(eq(foodWasteLogs.userId, userId), sql`${foodWasteLogs.loggedAt} BETWEEN ${start} AND ${end}`))
      .groupBy(foodWasteLogs.ingredientName)
      .orderBy(sql`count(*) DESC`)
      .limit(3),
    db
      .select({ recipeId: recipeCookLog.recipeId, title: recipes.title, times: sql<number>`count(*)::int` })
      .from(recipeCookLog)
      .innerJoin(recipes, eq(recipes.id, recipeCookLog.recipeId))
      .where(and(eq(recipeCookLog.userId, userId), sql`${recipeCookLog.cookedAt} BETWEEN ${start} AND ${end}`))
      .groupBy(recipeCookLog.recipeId, recipes.title)
      .orderBy(sql`count(*) DESC`)
      .limit(1),
  ]);

  const waste = await getWasteStats(userId, 'week');
  const progress = await getAchievementsProgress(userId);

  const mealsCooked = Number(cookRows[0]?.count ?? 0);
  const moneySaved = round2(Number(groceryRows[0]?.savings ?? 0) + waste.money_saved_usd);
  const mostCooked = topRecipeRow(topRecipe);

  return {
    user_id: userId,
    week_start: toIsoDate(start),
    week_end: toIsoDate(end),
    meals_cooked: mealsCooked,
    scans_completed: Number(scanRows[0]?.count ?? 0),
    grocery_lists_completed: Number(groceryRows[0]?.count ?? 0),
    money_saved_usd: moneySaved,
    co2_saved_kg: waste.co2_saved_kg,
    waste_change_pct: waste.cost_change_pct,
    waste_logged_usd: waste.total_cost_usd,
    top_wasted: topWaste.map((r) => ({
      name: String(r.name),
      count: Number(r.count),
      cost_usd: round2(Number(r.cost)),
    })),
    most_cooked_recipe: mostCooked,
    achievements_earned: progress.earned,
    streak_days: progress.streak_days,
    points: progress.points,
    headline: headlineFor(moneySaved, waste.cost_change_pct, mealsCooked),
  };
}

function topRecipeRow(rows: Array<{ recipeId: string; title: string; times: number }>): WeeklyReportDto['most_cooked_recipe'] {
  const row = rows[0];
  if (!row) return null;
  return { id: row.recipeId, title: row.title, times: Number(row.times) };
}

function headlineFor(saved: number, wasteChangePct: number, mealsCooked: number): string {
  if (saved >= 20) return `Great week — you saved $${saved.toFixed(2)} and cooked ${mealsCooked} meal${mealsCooked === 1 ? '' : 's'}!`;
  if (wasteChangePct <= -10) return `You cut food waste by ${Math.abs(wasteChangePct)}% this week. Keep it up!`;
  if (mealsCooked >= 5) return `${mealsCooked} home-cooked meals this week — your wallet and the planet say thanks.`;
  return 'A solid week. Plan next week\'s meals to save even more.';
}

/** Invalidate the cached dashboards for a user (called after pantry/plan writes). */
export async function invalidateDashboard(userId: string): Promise<void> {
  await Promise.all([
    cache.del(CacheKeys.dashboard(userId, 'home')),
    cache.del(CacheKeys.dashboard(userId, 'savings:week')),
    cache.del(CacheKeys.dashboard(userId, 'savings:month')),
    cache.del(CacheKeys.dashboard(userId, 'savings:year')),
  ]);
}

/** Trend series for the Stats screen charts. */
export async function getTrends(userId: string, days = 30): Promise<{
  waste: TrendPoint[];
  savings: TrendPoint[];
  meals: TrendPoint[];
}> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);

  const [wasteRows, mealRows] = await Promise.all([
    db
      .select({
        date: sql<string>`to_char(date(${foodWasteLogs.loggedAt}), 'YYYY-MM-DD')`,
        cost: sql<number>`COALESCE(SUM(${foodWasteLogs.estimatedCostUsd}), 0)::numeric`,
      })
      .from(foodWasteLogs)
      .where(and(eq(foodWasteLogs.userId, userId), sql`${foodWasteLogs.loggedAt} >= ${since}`))
      .groupBy(sql`date(${foodWasteLogs.loggedAt})`)
      .orderBy(sql`date(${foodWasteLogs.loggedAt}) ASC`),
    db
      .select({
        date: sql<string>`to_char(date(${recipeCookLog.cookedAt}), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(recipeCookLog)
      .where(and(eq(recipeCookLog.userId, userId), sql`${recipeCookLog.cookedAt} >= ${since}`))
      .groupBy(sql`date(${recipeCookLog.cookedAt})`)
      .orderBy(sql`date(${recipeCookLog.cookedAt}) ASC`),
  ]);

  const wasteMap = new Map(wasteRows.map((r) => [String(r.date), round2(Number(r.cost))]));
  const mealMap = new Map(mealRows.map((r) => [String(r.date), Number(r.count)]));

  const waste: TrendPoint[] = [];
  const meals: TrendPoint[] = [];
  const savings: TrendPoint[] = [];

  let cumulative = 0;
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = toIsoDate(new Date(Date.now() - i * 86_400_000));
    const wasted = wasteMap.get(date) ?? 0;
    cumulative += Math.max(0, 2 - wasted * 0.5);
    waste.push({ label: date, value: wasted });
    meals.push({ label: date, value: mealMap.get(date) ?? 0 });
    savings.push({ label: date, value: round2(cumulative) });
  }

  return { waste, savings, meals };
}

/** Recently viewed / cooked recipes for the Profile screen. */
export async function getRecentRecipes(userId: string, limit = 6): Promise<RecipeDto[]> {
  const db = getDb();
  const rows = await db
    .select({ recipeId: recipeCookLog.recipeId, cookedAt: recipeCookLog.cookedAt })
    .from(recipeCookLog)
    .where(eq(recipeCookLog.userId, userId))
    .orderBy(desc(recipeCookLog.cookedAt))
    .limit(Math.min(20, limit));

  const out: RecipeDto[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const dto = await getRecipeForUser(row.recipeId, userId).catch(() => null);
    if (dto) out.push({ ...dto, is_cooked: true });
  }
  return out;
}

/** Expiring-soon helper re-exported for the pantry screen. */
export async function getExpiringSoonItems(userId: string, days = 5): Promise<ExpiringSoonItemDto[]> {
  return toExpiringSoonDto(await getExpiringSoon(userId, days));
}

/**
 * Pantry DTO → the compact row the Home carousel renders, enriched with a
 * recipe suggestion so the card is actionable rather than just a warning.
 */
async function toExpiringSoonDto(rows: PantryItemDto[]): Promise<ExpiringSoonItemDto[]> {
  const out: ExpiringSoonItemDto[] = [];

  for (const row of rows.slice(0, 10)) {
    let recipeId: string | null = null;
    let recipeTitle: string | null = null;
    try {
      const results = await searchRecipes({ q: normalizeIngredient(row.ingredient_name), limit: 1, sort: 'best_match' });
      const hit = results.data[0];
      if (hit) {
        recipeId = hit.id;
        recipeTitle = hit.title;
      }
    } catch {
      // A missing suggestion must never break the Home screen.
    }

    out.push({
      id: row.id,
      ingredient_name: row.ingredient_name,
      category: row.category,
      quantity: row.quantity,
      unit: row.unit,
      expiry_date: row.expiry_date,
      days_until_expiry: row.days_until_expiry ?? 0,
      urgency: row.urgency,
      expiry_label: row.expiry_label,
      location: row.location,
      photo_url: row.photo_url,
      suggested_recipe_id: recipeId,
      suggested_recipe_title: recipeTitle,
    });
  }

  return out;
}

/** Convenience: featured/public recipe of the day, stable per calendar day. */
export async function getRecipeOfTheDay(): Promise<RecipeDto | null> {
  const db = getDb();
  const cacheKey = CacheKeys.dashboard('public', `recipe-of-day:${toIsoDate(todayUtc())}`);
  const cachedId = await cache.get<string>(cacheKey);

  let recipeId = cachedId;
  if (!recipeId) {
    const rows = await db
      .select({ id: recipes.id })
      .from(recipes)
      .where(eq(recipes.isPublic, true))
      .orderBy(sql`md5(${recipes.id} || ${toIsoDate(todayUtc())})`)
      .limit(1);
    recipeId = rows[0]?.id ?? null;
    if (recipeId) await cache.set(cacheKey, recipeId, 86_400);
  }

  if (!recipeId) return null;
  const full = (await loadRecipe(recipeId).catch(() => null)) as RecipeWithChildren | null;
  if (!full) return null;

  return recipeToDto(full);
}
