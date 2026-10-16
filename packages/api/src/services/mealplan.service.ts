import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  CompleteMealInput,
  DailyNutrition,
  DayMealEntry,
  GenerateMealPlanInput,
  MealPlanDto,
  MealPlanEntryDto,
  NutritionBreakdownDto,
  RecipeDto,
  SwapMealInput,
  WeekOverviewDto,
} from '@platematch/shared';
import { DAY_SHORT_NAMES, MEAL_TYPES } from '@platematch/shared';
import { getDb } from '../db/index.js';
import {
  groceryListItems,
  groceryLists,
  mealPlanEntries,
  mealPlans,
  pantryItems,
  recipes,
  users,
  type GroceryList,
  type MealPlan,
  type MealPlanEntry,
  type PantryItem,
} from '../db/schema.js';
import { NotFoundError, QuotaExceededError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache, invalidateDashboardCaches } from '../lib/redis.js';
import { coerceCategory, estimatePriceUsd, normalizeIngredient, round1, round2, similarity } from '../utils/food.js';
import {
  addDays,
  dateForDayOfWeek,
  dayKeyFromDayOfWeek,
  dayShortName,
  isoWeekKey,
  monthKey,
  periodStart,
  toIsoDate,
  todayInTimezone,
} from '../utils/dates.js';
import { checkDailyMacros, percentOfTarget, scaleNutrition } from '../utils/nutrition.js';
import type { PromptPantryItem, PromptUserProfile } from '../config/prompts.js';
import type { AiMealPlan, AiRecipe } from './ai/types.js';
import {
  generateMealPlan as aiGenerateMealPlan,
  generateReplacementMeal,
  type MealPlanGenerationInput,
} from './ai/mealplan.service.js';
import { enrichRecipe } from './ai/nutrition.service.js';
import { incrementUsage, isSpendCapped } from './ai/ledger.js';
import { getAllergies, getUserById } from './user.service.js';
import { getActivePantryCached, invalidatePantryCache } from './pantry.service.js';
import { getPlanLimits } from './subscription.service.js';
import { loadRecipe, persistAiRecipe } from './recipe.service.js';
import { checkAndAward } from './achievement.service.js';
import { mealPlanEntryToDto, mealPlanToDto, recipeToDto } from './dto.js';
import type { RecipeWithChildren } from './dto.js';

/**
 * Meal-plan service (Sections 4 + 6, Screen 10).
 *
 * The AI planner returns a `day key → meal type → recipe` map. This module
 * turns that into persisted `meal_plans` / `meal_plan_entries` rows, derives a
 * grocery list from the entries, and exposes the week view and nutrition
 * breakdown the app renders.
 */

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateMealPlanResult {
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
}

export async function createMealPlan(userId: string, input: GenerateMealPlanInput): Promise<CreateMealPlanResult> {
  const db = getDb();
  const started = Date.now();

  const user = await getUserById(userId);
  if (!user) throw new NotFoundError('User not found');

  // ---- Quotas ------------------------------------------------------------
  const limits = getPlanLimits(user.subscriptionTier);
  if (limits.mealPlansPerMonth > 0) {
    const used = await countPlansThisMonth(userId);
    if (used >= limits.mealPlansPerMonth) {
      throw new QuotaExceededError(
        `You have used all ${limits.mealPlansPerMonth} free meal plans this month. Upgrade to Premium for unlimited planning.`,
        { limit: limits.mealPlansPerMonth, used },
      );
    }
  }
  if (await isSpendCapped(userId)) {
    throw new QuotaExceededError('Daily AI budget reached. Please try again tomorrow or upgrade your plan.');
  }

  // ---- Context -----------------------------------------------------------
  const [allergies, pantryRows] = await Promise.all([getAllergies(userId), getActivePantryCached(userId)]);
  const pantry = toPromptPantry(pantryRows);
  const expiringSoon = pantry.filter((p) => p.daysUntilExpiry !== null && p.daysUntilExpiry >= 0 && p.daysUntilExpiry <= 4);

  const dailyCalories = input.daily_calories ?? user.dailyCalorieTarget ?? 2000;
  const profile: PromptUserProfile = {
    dietaryPreference: user.dietaryPreference,
    allergies: allergies.map((a) => ({ allergen: a.allergen, severity: a.severity })),
    healthGoal: user.healthGoal,
    calories: dailyCalories,
    protein: user.dailyProteinTargetG ?? Math.round((dailyCalories * 0.3) / 4),
    carbs: user.dailyCarbsTargetG ?? Math.round((dailyCalories * 0.4) / 4),
    fat: user.dailyFatTargetG ?? Math.round((dailyCalories * 0.3) / 9),
    familySize: user.familySize,
    cookingSkill: user.cookingSkillLevel,
    maxTime: user.maxCookingTimeMin,
    cuisines: user.preferredCuisines,
    currency: user.currency,
  };

  const mealTypes = MEAL_TYPES.slice(0, Math.max(1, Math.min(4, input.meals_per_day))) as Array<
    'breakfast' | 'lunch' | 'dinner' | 'snack'
  >;
  // Always keep dinner when the user asked for 1–2 meals a day.
  const selectedTypes: Array<'breakfast' | 'lunch' | 'dinner' | 'snack'> =
    input.meals_per_day >= 3 ? mealTypes : input.meals_per_day === 2 ? ['lunch', 'dinner'] : ['dinner'];

  const excludedTitles = await titlesForIds(input.exclude_recipe_ids);
  const includedTitles = await titlesForIds(input.include_recipe_ids);

  const aiInput: MealPlanGenerationInput = {
    profile,
    pantry,
    expiringSoon,
    allergies: profile.allergies,
    dietaryPreference: user.dietaryPreference,
    avoid: input.exclude_recipe_ids.length ? excludedTitles : [],
    startDate: input.start_date,
    days: input.days,
    mealsPerDay: selectedTypes.length,
    mealTypes: selectedTypes,
    variety: input.variety,
    budget: input.budget ?? null,
    cookingTimePref: input.cooking_time_pref,
    excludeTitles: excludedTitles,
    includeTitles: includedTitles,
    servings: user.familySize,
    userId,
  };

  const generation = await aiGenerateMealPlan(aiInput);
  const plan = generation.plan;

  // ---- Persist the plan header ------------------------------------------
  const weekStart = input.start_date;
  const weekEnd = toIsoDate(addDays(weekStart, input.days - 1));

  const [planRow] = await db
    .insert(mealPlans)
    .values({
      userId,
      name: `Meal plan · ${weekStart}`,
      weekStartDate: weekStart,
      weekEndDate: weekEnd,
      servings: user.familySize,
      dietaryPreference: user.dietaryPreference,
      budgetPerDay: input.budget != null ? round2(input.budget / Math.max(1, input.days)) : null,
      totalCalories: round1(plan.weekly_nutrition_totals.calories),
      totalCostEstimate: round2(plan.estimated_weekly_grocery_cost),
      dailyCalorieTarget: dailyCalories,
      averageDailyCalories: Math.round(plan.weekly_nutrition_totals.calories / Math.max(1, input.days)),
      weeklyTotals: {
        calories: plan.weekly_nutrition_totals.calories,
        protein: plan.weekly_nutrition_totals.protein,
        carbs: plan.weekly_nutrition_totals.carbs,
        fat: plan.weekly_nutrition_totals.fat,
        cost_usd: plan.estimated_weekly_grocery_cost,
      },
      optimizationNotes: [...plan.waste_reduction_tips, ...plan.meal_prep_suggestions],
      aiModelUsed: generation.modelUsed,
      status: 'active',
      metadata: {
        daily_nutrition_summary: plan.daily_nutrition_summary,
        pantry_items_used: plan.pantry_items_used,
        verification: generation.verification,
        safety_notes: generation.safetyNotes,
        used_local_engine: generation.usedLocalEngine,
        generation_time_ms: Date.now() - started,
      },
    })
    .returning();

  const created = planRow as MealPlan;

  // ---- Persist entries ---------------------------------------------------
  const entries: MealPlanEntryDto[] = [];

  for (let day = 1; day <= input.days; day += 1) {
    const dayKey = dayKeyFromDayOfWeek(day);
    const slots = plan.meal_plan[dayKey] ?? {};
    const date = dateForDayOfWeek(weekStart, day);

    for (const mealType of selectedTypes) {
      const aiRecipe = slots[mealType];
      if (!aiRecipe) continue;

      // eslint-disable-next-line no-await-in-loop
      const recipe = await resolveRecipe(userId, aiRecipe, generation.modelUsed);
      if (!recipe) continue;

      const perServing = recipe.recipe.nutrition ?? null;
      const scaled = scaleNutrition(
        {
          calories: perServing?.calories ?? aiRecipe.estimated_nutrition_per_serving.calories,
          protein_g: perServing?.proteinG ?? aiRecipe.estimated_nutrition_per_serving.protein_g,
          carbs_g: perServing?.carbsG ?? aiRecipe.estimated_nutrition_per_serving.carbs_g,
          fat_g: perServing?.fatG ?? aiRecipe.estimated_nutrition_per_serving.fat_g,
        },
        user.familySize,
      );

      // eslint-disable-next-line no-await-in-loop
      const [entryRow] = await db
        .insert(mealPlanEntries)
        .values({
          mealPlanId: created.id,
          recipeId: recipe.recipe.id,
          dayOfWeek: day,
          date,
          mealType,
          servings: user.familySize,
          calories: round1(scaled.calories),
        })
        .returning();

      entries.push(mealPlanEntryToDto(entryRow as MealPlanEntry, recipe.dto));
    }
  }

  // ---- Derived grocery list ---------------------------------------------
  let groceryListId: string | null = null;
  if (entries.length) {
    groceryListId = await buildGroceryListFromPlan(created.id, userId, plan);
    if (groceryListId) {
      await db.update(mealPlans).set({ groceryListId }).where(eq(mealPlans.id, created.id));
    }
  }

  await incrementUsage(userId, 'mealplan', `plan:${isoWeekKey()}`, generation.costUsd);
  await Promise.all([cache.del(CacheKeys.mealPlan(created.id)), cache.del(CacheKeys.weekOverview(userId, weekStart))]);
  void checkAndAward(userId).catch(() => undefined);

  logger.info(
    { userId, planId: created.id, entries: entries.length, model: generation.modelUsed, ms: Date.now() - started },
    'Meal plan generated',
  );

  const dto = await getMealPlan(created.id);

  return {
    meal_plan: dto,
    grocery_list_id: groceryListId,
    ai_model_used: generation.modelUsed,
    generation_time_ms: Date.now() - started,
    used_local_engine: generation.usedLocalEngine,
    nutrition_verification: {
      days_checked: generation.verification.daysChecked,
      days_within_tolerance: generation.verification.daysWithinTolerance,
      tolerance_pct: generation.verification.tolerancePct,
      warnings: generation.verification.warnings,
    },
  };
}

async function titlesForIds(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const db = getDb();
  const rows = await db.select({ title: recipes.title }).from(recipes).where(sql`${recipes.id} = ANY(${ids})`);
  return rows.map((r) => r.title);
}

/** Turn an `AiRecipe` into a persisted recipe row + DTO, reusing on title match. */
async function resolveRecipe(
  userId: string,
  aiRecipe: AiRecipe,
  modelUsed: string,
): Promise<{ recipe: RecipeWithChildren; dto: RecipeDto } | null> {
  const db = getDb();

  const existing = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.title, aiRecipe.title), sql`(${recipes.ownerId} = ${userId} OR ${recipes.isPublic} = true)`))
    .orderBy(desc(recipes.createdAt))
    .limit(1);

  if (existing[0]) {
    const full = await loadRecipe(existing[0]!.id);
    return { recipe: full, dto: recipeToDto(full) };
  }

  const dto = await persistAiRecipe(userId, aiRecipe, await enrichRecipe(aiRecipe).catch(() => nutritionFromAi(aiRecipe)), modelUsed);
  const full = await loadRecipe(dto.id);
  return { recipe: full, dto };
}

function nutritionFromAi(recipe: AiRecipe) {
  const n = recipe.estimated_nutrition_per_serving;
  return {
    calories: n.calories,
    protein_g: n.protein_g,
    carbs_g: n.carbs_g,
    fat_g: n.fat_g,
    fiber_g: n.fiber_g,
    sugar_g: 0,
    sodium_mg: n.sodium_mg,
    cholesterol_mg: 0,
    saturated_fat_g: 0,
    vitamin_a_pct: 0,
    vitamin_c_pct: 0,
    calcium_pct: 0,
    iron_pct: 0,
    potassium_mg: 0,
    per_serving: true as const,
    source: 'ai' as const,
  };
}

export function toPromptPantry(items: PantryItem[]): PromptPantryItem[] {
  return items
    .filter((i) => !i.isUsed)
    .map((item) => ({
      name: item.ingredientName,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category,
      expiryDate: item.expiryDate ?? null,
      daysUntilExpiry: item.expiryDate ? Math.round((new Date(item.expiryDate).getTime() - Date.now()) / 86_400_000) : null,
      location: item.location,
    }));
}

async function countPlansThisMonth(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mealPlans)
    .where(and(eq(mealPlans.userId, userId), sql`to_char(${mealPlans.createdAt}, 'YYYY-MM') = ${monthKey()}`));
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getMealPlan(planId: string, userId?: string | null): Promise<MealPlanDto> {
  const db = getDb();

  const cached = await cache.get<MealPlanDto>(CacheKeys.mealPlan(planId));
  if (cached && (!userId || cached.user_id === userId)) return cached;

  const [planRow] = await db.select().from(mealPlans).where(eq(mealPlans.id, planId)).limit(1);
  if (!planRow) throw new NotFoundError('Meal plan not found');
  const plan = planRow as MealPlan;
  if (userId && plan.userId !== userId) throw new NotFoundError('Meal plan not found');

  const entryRows = (await db
    .select()
    .from(mealPlanEntries)
    .where(eq(mealPlanEntries.mealPlanId, planId))
    .orderBy(asc(mealPlanEntries.dayOfWeek), asc(mealPlanEntries.mealType))) as MealPlanEntry[];

  const entries: MealPlanEntryDto[] = [];
  const dailyNutrition: Record<string, DailyNutrition> = {};

  for (const entry of entryRows) {
    const full = entry.recipeId ? await loadRecipe(entry.recipeId).catch(() => null) : null;
    const dto = full ? recipeToDto(full) : null;
    entries.push(mealPlanEntryToDto(entry, dto));

    const key = String(entry.dayOfWeek);
    const scaled = full?.nutrition
      ? scaleNutrition(
          {
            calories: full.nutrition.calories,
            protein_g: full.nutrition.proteinG,
            carbs_g: full.nutrition.carbsG,
            fat_g: full.nutrition.fatG,
          },
          entry.servings,
        )
      : { calories: Number(entry.calories ?? 0), protein_g: 0, carbs_g: 0, fat_g: 0 };

    const existing = dailyNutrition[key] ?? { calories: 0, protein: 0, carbs: 0, fat: 0, cost: 0 };
    dailyNutrition[key] = {
      calories: round1(existing.calories + scaled.calories),
      protein: round1(existing.protein + scaled.protein_g),
      carbs: round1(existing.carbs + scaled.carbs_g),
      fat: round1(existing.fat + scaled.fat_g),
      cost: round2(existing.cost + Number(full?.totalCostEstimate ?? 0)),
    };
  }

  const metadata = (plan.metadata ?? {}) as Record<string, unknown>;
  const groceryListId = plan.groceryListId ?? null;

  const groceryPreview = groceryListId ? await groceryPreviewFor(groceryListId) : null;

  const dto = mealPlanToDto(plan, entries, {
    daily_nutrition: dailyNutrition,
    weekly_totals: (plan.weeklyTotals as unknown as DailyNutrition) ?? null,
    waste_reduction_tips: stringArrayOf(metadata.waste_reduction_tips),
    meal_prep_suggestions: stringArrayOf(metadata.meal_prep_suggestions),
    pantry_items_used: stringArrayOf(metadata.pantry_items_used),
    grocery_preview: groceryPreview,
    grocery_list_id: groceryListId,
  });

  await cache.set(CacheKeys.mealPlan(planId), dto, 120);
  return dto;
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

async function groceryPreviewFor(listId: string): Promise<MealPlanDto['grocery_preview']> {
  const db = getDb();
  const [row] = await db
    .select({
      items: sql<number>`count(*)::int`,
      cost: sql<number>`COALESCE(SUM(${groceryListItems.estimatedCost}), 0)::numeric`,
      inPantry: sql<number>`count(*) FILTER (WHERE ${groceryListItems.inPantry})::int`,
    })
    .from(groceryListItems)
    .where(eq(groceryListItems.groceryListId, listId));

  if (!row) return null;
  return { items: Number(row.items), estimated_cost: round2(Number(row.cost)), already_in_pantry: Number(row.inPantry) };
}

export async function getWeekOverview(userId: string, weekStart?: string): Promise<WeekOverviewDto> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User not found');

  const timezone = user.timezone ?? 'UTC';
  const start = weekStart ?? toIsoDate(periodStart('week'));
  const end = toIsoDate(addDays(start, 6));

  const cacheKey = CacheKeys.weekOverview(userId, start);
  const cached = await cache.get<WeekOverviewDto>(cacheKey);
  if (cached) return cached;

  const [planRow] = await db
    .select()
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.userId, userId),
        eq(mealPlans.status, 'active'),
        sql`${mealPlans.weekStartDate} <= ${end}`,
        sql`${mealPlans.weekEndDate} >= ${start}`,
      ),
    )
    .orderBy(desc(mealPlans.createdAt))
    .limit(1);

  const plan = planRow as MealPlan | undefined;
  const entryRows = plan
    ? ((await db
        .select()
        .from(mealPlanEntries)
        .where(eq(mealPlanEntries.mealPlanId, plan.id))
        .orderBy(asc(mealPlanEntries.dayOfWeek))) as MealPlanEntry[])
    : [];

  const recipesById = new Map<string, RecipeWithChildren>();
  for (const entry of entryRows) {
    if (!entry.recipeId || recipesById.has(entry.recipeId)) continue;
    // eslint-disable-next-line no-await-in-loop
    const full = await loadRecipe(entry.recipeId).catch(() => null);
    if (full) recipesById.set(entry.recipeId, full);
  }

  const todayIso = toIsoDate(todayInTimezone(timezone));
  const dailyTarget = plan?.dailyCalorieTarget ?? user.dailyCalorieTarget ?? 2000;

  const days: WeekOverviewDto['days'] = [];
  const macroCheck: WeekOverviewDto['macro_check'] = [];
  let totalCalories = 0;
  let completedMeals = 0;
  let totalMeals = 0;

  for (let day = 1; day <= 7; day += 1) {
    const date = dateForDayOfWeek(start, day);
    const dayEntries = entryRows.filter((e) => e.dayOfWeek === day);

    const meals: MealPlanEntryDto[] = dayEntries.map((entry) => {
      const full = entry.recipeId ? recipesById.get(entry.recipeId) ?? null : null;
      return mealPlanEntryToDto(entry, full ? recipeToDto(full) : null);
    });

    const dayCalories = meals.reduce((sum, m) => sum + (m.calories ?? 0), 0);
    totalCalories += dayCalories;
    totalMeals += meals.length;
    completedMeals += meals.filter((m) => m.is_completed).length;

    const check = checkDailyMacros(day, dayCalories, dailyTarget);
    macroCheck.push({
      day: check.day,
      calories: check.calories,
      target: check.target,
      delta: check.delta,
      delta_pct: check.deltaPct,
      within_tolerance: check.withinTolerance,
    });

    days.push({
      date,
      day_name: dayShortName(day),
      is_today: date === todayIso,
      meals,
      total_calories: round1(dayCalories),
      completed_count: meals.filter((m) => m.is_completed).length,
    });
  }

  const overview: WeekOverviewDto = {
    week_start: start,
    week_end: end,
    meal_plan_id: plan?.id ?? null,
    grocery_list_id: plan?.groceryListId ?? null,
    days,
    total_calories: round1(totalCalories),
    average_daily_calories: Math.round(totalCalories / 7),
    targets: {
      calories: dailyTarget,
      protein: user.dailyProteinTargetG ?? 0,
      carbs: user.dailyCarbsTargetG ?? 0,
      fat: user.dailyFatTargetG ?? 0,
    },
    macro_check: macroCheck,
    completion_rate: totalMeals ? Math.round((completedMeals / totalMeals) * 100) : 0,
  };

  await cache.set(cacheKey, overview, 60);
  return overview;
}

/** Group the flat entry list into `day → meals` for screens that want a grid. */
export async function getPlanDays(planId: string, userId?: string | null): Promise<DayMealEntry[]> {
  const dto = await getMealPlan(planId, userId);
  const db = getDb();

  // "Today" has to be judged in the plan owner's timezone, not the server's,
  // otherwise the highlight flips over hours early for anyone east of UTC.
  let timezone = 'UTC';
  if (userId) {
    const [owner] = await db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    timezone = owner?.timezone ?? 'UTC';
  }
  const todayIso = toIsoDate(todayInTimezone(timezone));

  const days: DayMealEntry[] = [];

  for (const entry of dto.entries) {
    let day = days.find((d) => d.day === entry.day_of_week);
    if (!day) {
      const date = dateForDayOfWeek(dto.week_start_date, entry.day_of_week);
      day = {
        day: entry.day_of_week,
        date,
        meals: { breakfast: null, lunch: null, dinner: null, snack: null },
        day_name: dayShortName(entry.day_of_week),
        is_today: date === todayIso,
        total_calories: 0,
      };
      days.push(day);
    }
    day.meals[entry.meal_type] = entry;
    day.total_calories = round1((day.total_calories ?? 0) + (entry.calories ?? 0));
  }

  return days.sort((a, b) => a.day - b.day);
}

export async function listMealPlans(userId: string, page = 1, limit = 10): Promise<{ data: MealPlanDto[]; total: number }> {
  const db = getDb();
  const safeLimit = Math.min(50, Math.max(1, limit));
  const safePage = Math.max(1, page);

  const [rows, countRows] = await Promise.all([
    db.select().from(mealPlans).where(eq(mealPlans.userId, userId)).orderBy(desc(mealPlans.createdAt)).limit(safeLimit).offset((safePage - 1) * safeLimit),
    db.select({ count: sql<number>`count(*)::int` }).from(mealPlans).where(eq(mealPlans.userId, userId)),
  ]);

  return {
    data: await Promise.all((rows as MealPlan[]).map((r) => getMealPlan(r.id))),
    total: Number(countRows[0]?.count ?? 0),
  };
}

export async function updateMealPlan(
  userId: string,
  planId: string,
  patch: { name?: string; servings?: number; budget_per_day?: number },
): Promise<MealPlanDto> {
  const db = getDb();
  const plan = await assertPlanOwner(userId, planId);

  await db
    .update(mealPlans)
    .set({
      name: patch.name ?? plan.name,
      servings: patch.servings ?? plan.servings,
      budgetPerDay: patch.budget_per_day ?? plan.budgetPerDay,
      updatedAt: new Date(),
    })
    .where(eq(mealPlans.id, planId));

  await invalidatePlan(planId, userId);
  return getMealPlan(planId);
}

export async function deleteMealPlan(userId: string, planId: string): Promise<void> {
  const db = getDb();
  await assertPlanOwner(userId, planId);

  await db.transaction(async (tx) => {
    await tx.delete(mealPlanEntries).where(eq(mealPlanEntries.mealPlanId, planId));
    await tx.update(groceryLists).set({ mealPlanId: null }).where(eq(groceryLists.mealPlanId, planId));
    await tx.update(mealPlans).set({ status: 'archived', updatedAt: new Date() }).where(eq(mealPlans.id, planId));
  });

  await invalidatePlan(planId, userId);
}

async function assertPlanOwner(userId: string, planId: string): Promise<MealPlan> {
  const db = getDb();
  const [row] = await db.select().from(mealPlans).where(and(eq(mealPlans.id, planId), eq(mealPlans.userId, userId))).limit(1);
  if (!row) throw new NotFoundError('Meal plan not found');
  return row as MealPlan;
}

async function invalidatePlan(planId: string, userId: string): Promise<void> {
  await invalidateDashboardCaches(userId);
  await cache.del(CacheKeys.mealPlan(planId));
  await cache.delPattern(CacheKeys.weekOverview(userId, '*'));
}

// ---------------------------------------------------------------------------
// Swaps & completion
// ---------------------------------------------------------------------------

export async function swapMeal(userId: string, planId: string, entryId: string, input: SwapMealInput): Promise<MealPlanDto> {
  const db = getDb();
  const plan = await assertPlanOwner(userId, planId);

  const [entryRow] = await db
    .select()
    .from(mealPlanEntries)
    .where(and(eq(mealPlanEntries.id, entryId), eq(mealPlanEntries.mealPlanId, planId)))
    .limit(1);
  if (!entryRow) throw new NotFoundError('Meal not found in this plan');
  const entry = entryRow as MealPlanEntry;

  let nextRecipeId = input.new_recipe_id ?? null;

  if (!nextRecipeId || input.ai_replace) {
    const user = await getUserById(userId);
    if (!user) throw new NotFoundError('User not found');
    const [allergies, pantryRows] = await Promise.all([getAllergies(userId), getActivePantryCached(userId)]);

    const existingTitles = await titlesInPlan(planId);
    const replacement = await generateReplacementMeal({
      profile: {
        dietaryPreference: user.dietaryPreference,
        allergies: allergies.map((a) => ({ allergen: a.allergen, severity: a.severity })),
        healthGoal: user.healthGoal,
        calories: plan.dailyCalorieTarget ?? user.dailyCalorieTarget ?? 2000,
        protein: user.dailyProteinTargetG ?? 80,
        carbs: user.dailyCarbsTargetG ?? 250,
        fat: user.dailyFatTargetG ?? 70,
        familySize: plan.servings,
        cookingSkill: user.cookingSkillLevel,
        maxTime: user.maxCookingTimeMin,
        cuisines: user.preferredCuisines,
        currency: user.currency,
      },
      pantry: toPromptPantry(pantryRows),
      dayName: dayKeyFromDayOfWeek(entry.dayOfWeek),
      mealType: entry.mealType as 'breakfast' | 'lunch' | 'dinner' | 'snack',
      avoidTitles: existingTitles,
      allergies: allergies.map((a) => ({ allergen: a.allergen, severity: a.severity })),
      dietaryPreference: user.dietaryPreference,
      servings: entry.servings,
      userId,
    });

    const persisted = await resolveRecipe(userId, replacement.recipe, replacement.modelUsed);
    if (!persisted) throw new NotFoundError('Could not generate a replacement meal');
    nextRecipeId = persisted.recipe.id;

    await incrementUsage(userId, 'mealplan', `swap:${isoWeekKey()}`, replacement.costUsd);
    logger.info({ userId, planId, entryId, model: replacement.modelUsed }, 'Meal swapped by AI');
  } else {
    // Swapping in a recipe the user picked — make sure it exists and is visible.
    const [recipe] = await db
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.id, nextRecipeId), sql`(${recipes.ownerId} = ${userId} OR ${recipes.isPublic} = true)`))
      .limit(1);
    if (!recipe) throw new NotFoundError('Recipe not found');
  }

  const full = await loadRecipe(nextRecipeId!);
  const scaled = full.nutrition
    ? scaleNutrition(
        { calories: full.nutrition.calories, protein_g: full.nutrition.proteinG, carbs_g: full.nutrition.carbsG, fat_g: full.nutrition.fatG },
        entry.servings,
      )
    : null;

  await db
    .update(mealPlanEntries)
    .set({
      recipeId: nextRecipeId,
      calories: scaled ? round1(scaled.calories) : entry.calories,
      isCompleted: false,
      completedAt: null,
      actualServings: null,
      updatedAt: new Date(),
    })
    .where(eq(mealPlanEntries.id, entryId));

  await rebuildGroceryList(planId, userId);
  await invalidatePlan(planId, userId);

  return getMealPlan(planId);
}

export async function completeMeal(
  userId: string,
  planId: string,
  entryId: string,
  input: CompleteMealInput,
): Promise<MealPlanDto> {
  const db = getDb();
  await assertPlanOwner(userId, planId);

  const [entryRow] = await db
    .select()
    .from(mealPlanEntries)
    .where(and(eq(mealPlanEntries.id, entryId), eq(mealPlanEntries.mealPlanId, planId)))
    .limit(1);
  if (!entryRow) throw new NotFoundError('Meal not found in this plan');
  const entry = entryRow as MealPlanEntry;

  await db
    .update(mealPlanEntries)
    .set({
      isCompleted: input.is_completed,
      completedAt: input.is_completed ? new Date() : null,
      actualServings: input.is_completed ? entry.servings : null,
      userNotes: input.user_notes ?? entry.userNotes,
      updatedAt: new Date(),
    })
    .where(eq(mealPlanEntries.id, entryId));

  if (input.is_completed && input.consume_pantry !== false && entry.recipeId) {
    const consumed = await consumePantryForRecipe(userId, entry.recipeId, entry.servings);
    logger.info({ userId, planId, entryId, consumed }, 'Planned meal cooked — pantry consumed');
  }

  await invalidatePlan(planId, userId);
  void checkAndAward(userId).catch(() => undefined);

  return getMealPlan(planId);
}

async function titlesInPlan(planId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ title: recipes.title })
    .from(mealPlanEntries)
    .innerJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(eq(mealPlanEntries.mealPlanId, planId));
  return rows.map((r) => r.title);
}

/** Mark the pantry items a recipe used as consumed. */
export async function consumePantryForRecipe(userId: string, recipeId: string, servings: number): Promise<number> {
  const db = getDb();
  const full = await loadRecipe(recipeId).catch(() => null);
  if (!full) return 0;

  const pantry = await getActivePantryCached(userId);
  const scale = servings / Math.max(1, full.servings);
  const updates: Array<{ id: string; remaining: number | null }> = [];

  for (const ingredient of full.ingredients ?? []) {
    const match = pantry.find((p) => !p.isUsed && similarity(p.ingredientName, ingredient.ingredientName) >= 0.72);
    if (!match) continue;

    const needed = ingredient.quantity != null ? ingredient.quantity * scale : null;
    const have = match.quantity;

    if (needed == null || have == null || have <= needed * 1.05) updates.push({ id: match.id, remaining: null });
    else updates.push({ id: match.id, remaining: round2(have - needed) });
  }

  for (const update of updates) {
    if (update.remaining === null) {
      // eslint-disable-next-line no-await-in-loop
      await db.update(pantryItems).set({ isUsed: true, usedAt: new Date(), updatedAt: new Date() }).where(eq(pantryItems.id, update.id));
    } else {
      // eslint-disable-next-line no-await-in-loop
      await db.update(pantryItems).set({ quantity: update.remaining, updatedAt: new Date() }).where(eq(pantryItems.id, update.id));
    }
  }

  if (updates.length) await invalidatePantryCache(userId);
  return updates.length;
}

// ---------------------------------------------------------------------------
// Grocery list derived from the plan
// ---------------------------------------------------------------------------

interface AggregatedItem {
  key: string;
  name: string;
  quantity: number;
  unit: string | null;
  category: string;
  recipeIds: string[];
  fromRecipes: string[];
  inPantry: boolean;
  estimatedCost: number;
}

/** Rebuild the plan's grocery list from its current entries. */
async function rebuildGroceryList(planId: string, userId: string): Promise<string | null> {
  const db = getDb();
  const [listRow] = await db.select({ id: groceryLists.id }).from(groceryLists).where(eq(groceryLists.mealPlanId, planId)).limit(1);
  if (!listRow) return null;
  return buildGroceryListFromPlan(planId, userId, null, listRow.id);
}

export async function buildGroceryListFromPlan(
  planId: string,
  userId: string,
  aiPlan: AiMealPlan | null,
  existingListId?: string,
): Promise<string> {
  const db = getDb();

  const entryRows = (await db.select().from(mealPlanEntries).where(eq(mealPlanEntries.mealPlanId, planId))) as MealPlanEntry[];
  const pantry = await getActivePantryCached(userId);
  const map = new Map<string, AggregatedItem>();

  for (const entry of entryRows) {
    if (!entry.recipeId) continue;
    // eslint-disable-next-line no-await-in-loop
    const full = await loadRecipe(entry.recipeId).catch(() => null);
    if (!full) continue;

    const scale = entry.servings / Math.max(1, full.servings);

    for (const ingredient of full.ingredients ?? []) {
      const key = normalizeIngredient(ingredient.ingredientName);
      const quantity = round1((ingredient.quantity ?? 1) * scale);
      const inPantry = pantry.some((p) => !p.isUsed && normalizeIngredient(p.ingredientName) === key);

      const existing = map.get(key);
      if (existing) {
        existing.quantity = round1(existing.quantity + quantity);
        if (!existing.recipeIds.includes(full.id)) existing.recipeIds.push(full.id);
        if (!existing.fromRecipes.includes(full.title)) existing.fromRecipes.push(full.title);
        existing.inPantry = existing.inPantry && inPantry;
      } else {
        map.set(key, {
          key,
          name: ingredient.ingredientName,
          quantity,
          unit: ingredient.unit ?? null,
          category: ingredient.category ?? 'other',
          recipeIds: [full.id],
          fromRecipes: [full.title],
          inPantry,
          estimatedCost: 0,
        });
      }
    }
  }

  // The planner's own grocery list can name items no recipe listed (staples).
  for (const row of aiPlan?.grocery_list ?? []) {
    const key = normalizeIngredient(row.item);
    if (map.has(key)) continue;
    map.set(key, {
      key,
      name: row.item,
      quantity: round1(row.quantity ?? 1),
      unit: row.unit ?? null,
      category: 'other',
      recipeIds: [],
      fromRecipes: row.needed_for ?? [],
      inPantry: pantry.some((p) => !p.isUsed && normalizeIngredient(p.ingredientName) === key),
      estimatedCost: 0,
    });
  }

  const items = [...map.values()]
    .map((item) => ({
      ...item,
      estimatedCost: round2(estimatePriceUsd(item.name, item.quantity, item.unit)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const totalCost = round2(items.reduce((sum, i) => sum + i.estimatedCost, 0));

  return db.transaction(async (tx) => {
    let listId = existingListId;

    if (listId) {
      await tx.delete(groceryListItems).where(eq(groceryListItems.groceryListId, listId));
      await tx
        .update(groceryLists)
        .set({ totalItems: items.length, totalChecked: 0, totalEstimatedCost: totalCost, updatedAt: new Date() })
        .where(eq(groceryLists.id, listId));
    } else {
      const [row] = await tx
        .insert(groceryLists)
        .values({
          userId,
          mealPlanId: planId,
          title: 'Weekly Grocery List',
          status: 'active',
          totalItems: items.length,
          totalChecked: 0,
          totalEstimatedCost: totalCost,
        })
        .returning();
      listId = (row as GroceryList).id;
    }

    if (items.length) {
      await tx.insert(groceryListItems).values(
        items.map((item, index) => ({
          groceryListId: listId!,
          ingredientName: item.name.slice(0, 100),
          normalizedKey: item.key,
          // Coerced onto the stored enum. The old double cast through
          // `GroceryList['status']` (… as never) switched type checking off for
          // this column entirely, so a free-form category the enum did not know
          // would have reached Postgres and failed the insert.
          category: coerceCategory(item.category),
          quantity: item.quantity,
          unit: item.unit,
          estimatedCost: item.estimatedCost,
          estimatedPrice: item.estimatedCost,
          isChecked: false,
          inPantry: item.inPantry,
          neededForRecipes: item.recipeIds,
          fromRecipes: item.fromRecipes.slice(0, 6),
          sortOrder: index,
        })),
      );
    }

    await tx.update(mealPlans).set({ groceryListId: listId!, totalCostEstimate: totalCost, updatedAt: new Date() }).where(eq(mealPlans.id, planId));
    await cache.del(CacheKeys.groceryList(listId!));

    return listId!;
  });
}

// ---------------------------------------------------------------------------
// Nutrition breakdown
// ---------------------------------------------------------------------------

export async function getNutritionBreakdown(userId: string, planId: string): Promise<NutritionBreakdownDto> {
  const db = getDb();
  const plan = await assertPlanOwner(userId, planId);

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const targets = {
    calories: plan.dailyCalorieTarget ?? user?.dailyCalorieTarget ?? 2000,
    protein: user?.dailyProteinTargetG ?? 0,
    carbs: user?.dailyCarbsTargetG ?? 0,
    fat: user?.dailyFatTargetG ?? 0,
  };

  const entryRows = (await db
    .select()
    .from(mealPlanEntries)
    .where(eq(mealPlanEntries.mealPlanId, planId))
    .orderBy(asc(mealPlanEntries.dayOfWeek))) as MealPlanEntry[];

  const days: NutritionBreakdownDto['days'] = [];
  let totalCalories = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;

  for (const entry of entryRows) {
    if (!entry.recipeId) continue;
    // eslint-disable-next-line no-await-in-loop
    const full = await loadRecipe(entry.recipeId).catch(() => null);
    if (!full?.nutrition) continue;

    const scaled = scaleNutrition(
      { calories: full.nutrition.calories, protein_g: full.nutrition.proteinG, carbs_g: full.nutrition.carbsG, fat_g: full.nutrition.fatG },
      entry.servings,
    );

    const key = entry.date ?? `day-${entry.dayOfWeek}`;
    let day = days.find((d) => d.date === key);
    if (!day) {
      day = { date: key, day_name: dayShortName(entry.dayOfWeek), calories: 0, protein: 0, carbs: 0, fat: 0, meals: {} };
      days.push(day);
    }

    day.calories = round1(day.calories + scaled.calories);
    day.protein = round1(day.protein + scaled.protein_g);
    day.carbs = round1(day.carbs + scaled.carbs_g);
    day.fat = round1(day.fat + scaled.fat_g);
    day.meals[entry.mealType] = {
      name: full.title,
      calories: round1(scaled.calories),
      protein: round1(scaled.protein_g),
      carbs: round1(scaled.carbs_g),
      fat: round1(scaled.fat_g),
      recipe_id: full.id,
      entry_id: entry.id,
    };

    totalCalories += scaled.calories;
    totalProtein += scaled.protein_g;
    totalCarbs += scaled.carbs_g;
    totalFat += scaled.fat_g;
  }

  const dayCount = Math.max(1, days.length);
  const macroCheck: NutritionBreakdownDto['macro_check'] = days.map((day, index) => {
    const check = checkDailyMacros(index + 1, day.calories, targets.calories);
    return {
      day: check.day,
      calories: check.calories,
      target: check.target,
      delta: check.delta,
      delta_pct: check.deltaPct,
      within_tolerance: check.withinTolerance,
    };
  });

  return {
    plan_id: planId,
    days,
    totals: { calories: round1(totalCalories), protein: round1(totalProtein), carbs: round1(totalCarbs), fat: round1(totalFat) },
    daily_average: {
      calories: round1(totalCalories / dayCount),
      protein: round1(totalProtein / dayCount),
      carbs: round1(totalCarbs / dayCount),
      fat: round1(totalFat / dayCount),
    },
    targets,
    compliance: {
      calories: percentOfTarget(totalCalories / dayCount, targets.calories),
      protein: percentOfTarget(totalProtein / dayCount, targets.protein),
      carbs: percentOfTarget(totalCarbs / dayCount, targets.carbs),
      fat: percentOfTarget(totalFat / dayCount, targets.fat),
    },
    macro_check: macroCheck,
  };
}

/** Convenience for the "what's for dinner" quick links. */
export async function getActivePlan(userId: string): Promise<MealPlanDto | null> {
  const db = getDb();

  // "Today" is the plan owner's today. Using UTC here dropped the plan that
  // covers the user's current day for anyone whose local date had already
  // rolled over — a Karachi user at 02:00 Monday saw last week's plan.
  const [owner] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  const today = todayInTimezone(owner?.timezone ?? 'UTC');
  const [row] = await db
    .select()
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.userId, userId),
        eq(mealPlans.status, 'active'),
        sql`${mealPlans.weekStartDate} <= ${today}`,
        sql`${mealPlans.weekEndDate} >= ${today}`,
      ),
    )
    .orderBy(desc(mealPlans.createdAt))
    .limit(1);

  return row ? getMealPlan((row as MealPlan).id) : null;
}

