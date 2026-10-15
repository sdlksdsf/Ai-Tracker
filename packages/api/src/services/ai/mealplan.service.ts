import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { buildMealPlanPrompt, buildSwapMealPrompt, MEAL_PLAN_SYSTEM_PROMPT, type PromptPantryItem, type PromptUserProfile } from '../../config/prompts.js';
import { checkDailyMacros, type MacroCheck } from '../../utils/nutrition.js';
import { coerceCategory } from '../../utils/food.js';
import { guardBatch, type GuardContext } from './allergen-guard.js';
import { generateLocalMealPlan, type LocalMealPlanInput } from './local-engine.js';
import { recordAiUsage } from './ledger.js';
import { batchReasoningChain, reasoningMode } from './index.js';
import { normalizeBatch } from './recipe.service.js';
import type { AiMealPlan, AiRecipe } from './types.js';

/**
 * Meal-plan generation (Section 5.C)
 * ===========================================================================
 * Same provider chain as recipes, with:
 *   • higher max_tokens (8192) and a slightly lower temperature (0.6) for
 *     week-long consistency,
 *   • a post-generation verification pass that checks each day lands within
 *     ±10% of the calorie target (spec requirement), and
 *   • the built-in planner as a fallback so a plan is always produced.
 */

export interface MealPlanGenerationInput {
  profile: PromptUserProfile;
  pantry: PromptPantryItem[];
  expiringSoon: PromptPantryItem[];
  allergies: Array<{ allergen: string; severity: string }>;
  dietaryPreference: string;
  avoid: string[];
  startDate: string;
  days: number;
  mealsPerDay: number;
  mealTypes: Array<'breakfast' | 'lunch' | 'dinner' | 'snack'>;
  variety: 'low' | 'medium' | 'high';
  budget?: number | null;
  cookingTimePref: 'quick' | 'balanced' | 'elaborate';
  excludeTitles: string[];
  includeTitles: string[];
  servings: number;
  userId?: string | null;
  signal?: AbortSignal;
}

export interface MealPlanGenerationOutput {
  plan: AiMealPlan;
  modelUsed: string;
  provider: string;
  latencyMs: number;
  costUsd: number;
  usedLocalEngine: boolean;
  verification: { daysChecked: number; daysWithinTolerance: number; tolerancePct: number; warnings: string[]; perDay: MacroCheck[] };
  safetyNotes: string[];
}

export async function generateMealPlan(input: MealPlanGenerationInput): Promise<MealPlanGenerationOutput> {
  const started = Date.now();
  const guardContext: GuardContext = {
    allergies: input.allergies,
    dietaryPreference: input.dietaryPreference,
    avoid: input.avoid,
  };

  let plan: AiMealPlan | null = null;
  let modelUsed = 'local-engine';
  let providerUsed = 'local';
  let costUsd = 0;
  const safetyNotes: string[] = [];
  let usedLocalEngine = false;

  if (reasoningMode() === 'live') {
    const prompt = buildMealPlanPrompt({
      profile: input.profile,
      pantry: input.pantry,
      expiringSoon: input.expiringSoon,
      startDate: input.startDate,
      days: input.days,
      mealsPerDay: input.mealsPerDay,
      variety: input.variety,
      budget: input.budget ?? undefined,
      cookingTimePref: input.cookingTimePref,
      excludeTitles: input.excludeTitles,
      includeTitles: input.includeTitles,
      weeklyCalories: (input.profile.calories ?? 2000) * input.days,
      mealTypes: input.mealTypes,
    });

    for (const provider of batchReasoningChain()) {
      try {
        const call = await provider.generateJson<unknown>({
          system: MEAL_PLAN_SYSTEM_PROMPT,
          prompt,
          maxTokens: env.AI_MEALPLAN_MAX_TOKENS,
          temperature: env.AI_MEALPLAN_TEMPERATURE,
          signal: input.signal,
          label: `mealplan:${input.days}d`,
        });

        const normalized = normalizeMealPlan(call.data, input, guardContext, safetyNotes);

        recordAiUsage({
          userId: input.userId ?? null,
          task: 'mealplan',
          provider: call.provider,
          model: call.model,
          success: true,
          latencyMs: call.latencyMs,
          usage: call.usage,
        });

        if (normalized && countMeals(normalized) > 0) {
          plan = normalized;
          modelUsed = call.model;
          providerUsed = call.provider;
          costUsd = call.usage.costUsd;
          break;
        }
        logger.warn({ provider: provider.name }, 'Meal-plan output was unusable — trying the next provider');
      } catch (err) {
        recordAiUsage({
          userId: input.userId ?? null,
          task: 'mealplan',
          provider: provider.name,
          model: provider.model,
          success: false,
          latencyMs: 0,
          errorCode: (err as Error).name ?? 'error',
        });
        logger.warn({ provider: provider.name, err: (err as Error).message }, 'Meal-plan provider failed');
      }
    }
  }

  if (!plan) {
    usedLocalEngine = true;
    plan = buildLocalPlan(input);
    if (modelUsed !== 'local-engine') {
      safetyNotes.push('The AI plan was incomplete or unsafe, so the built-in planner produced your week.');
    }
  }

  const verification = verifyPlan(plan, input.profile.calories);

  return {
    plan,
    modelUsed,
    provider: providerUsed,
    latencyMs: Date.now() - started,
    costUsd,
    usedLocalEngine,
    verification,
    safetyNotes: [...new Set(safetyNotes)],
  };
}

/** Normalise + safety-check a raw model response into an `AiMealPlan`. */
export function normalizeMealPlan(
  raw: unknown,
  input: MealPlanGenerationInput,
  guardContext: GuardContext,
  safetyNotes: string[],
): AiMealPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const container = raw as Record<string, unknown>;

  const rawPlan = (container.meal_plan ?? container.mealPlan ?? container.plan ?? {}) as Record<string, unknown>;
  const dayKeys = Object.keys(rawPlan);
  if (!dayKeys.length) return null;

  const mealPlan: AiMealPlan['meal_plan'] = {};
  const dailySummary: AiMealPlan['daily_nutrition_summary'] = {};

  for (const dayKey of dayKeys) {
    const slots = (rawPlan[dayKey] ?? {}) as Record<string, unknown>;
    const normalizedSlots: Record<string, AiRecipe | null> = {};
    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;

    for (const mealType of input.mealTypes) {
      const rawMeal = slots[mealType] ?? slots[titleCase(mealType)];
      if (!rawMeal || rawMeal === null) {
        normalizedSlots[mealType] = null;
        continue;
      }

      // A meal slot may be the recipe object itself, or wrapped in { recipe: … }.
      const payload = typeof rawMeal === 'object' && 'recipe' in (rawMeal as Record<string, unknown>)
        ? (rawMeal as Record<string, unknown>).recipe
        : rawMeal;

      const [recipe] = normalizeBatch({ recipes: [payload] }, 1);
      if (!recipe) {
        normalizedSlots[mealType] = null;
        continue;
      }

      const guarded = guardBatch([recipe], guardContext);
      safetyNotes.push(...guarded.notes);
      const safe = guarded.recipes[0];
      if (!safe) {
        normalizedSlots[mealType] = null;
        safetyNotes.push(`Removed ${mealType} on ${dayKey} — it did not pass the safety check.`);
        continue;
      }

      normalizedSlots[mealType] = safe;
      const n = safe.estimated_nutrition_per_serving;
      calories += n.calories;
      protein += n.protein_g;
      carbs += n.carbs_g;
      fat += n.fat_g;
    }

    mealPlan[dayKey] = normalizedSlots;
    dailySummary[dayKey] = {
      calories: Math.round(calories),
      protein: Math.round(protein * 10) / 10,
      carbs: Math.round(carbs * 10) / 10,
      fat: Math.round(fat * 10) / 10,
    };
  }

  const rawGrocery = Array.isArray(container.grocery_list) ? container.grocery_list : [];
  const groceryList = rawGrocery
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const g = entry as Record<string, unknown>;
      const item = typeof g.item === 'string' ? g.item : typeof g.name === 'string' ? g.name : null;
      if (!item) return null;
      return {
        item,
        quantity: typeof g.quantity === 'number' ? g.quantity : null,
        unit: typeof g.unit === 'string' ? g.unit : null,
        estimated_price: typeof g.estimated_price === 'number' ? g.estimated_price : null,
        needed_for: Array.isArray(g.needed_for) ? g.needed_for.map((n) => String(n)) : [],
        category: coerceCategory(g.category),
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);

  return {
    meal_plan: mealPlan,
    daily_nutrition_summary: dailySummary,
    weekly_nutrition_totals: normalizeTotals(container.weekly_nutrition_totals, dailySummary),
    grocery_list: groceryList,
    estimated_weekly_grocery_cost:
      typeof container.estimated_weekly_grocery_cost === 'number'
        ? container.estimated_weekly_grocery_cost
        : groceryList.reduce((sum, g) => sum + (g.estimated_price ?? 0), 0),
    pantry_items_used: Array.isArray(container.pantry_items_used) ? container.pantry_items_used.map(String) : [],
    waste_reduction_tips: Array.isArray(container.waste_reduction_tips) ? container.waste_reduction_tips.map(String) : [],
    meal_prep_suggestions: Array.isArray(container.meal_prep_suggestions) ? container.meal_prep_suggestions.map(String) : [],
  };
}

function normalizeTotals(raw: unknown, daily: AiMealPlan['daily_nutrition_summary']): AiMealPlan['weekly_nutrition_totals'] {
  if (raw && typeof raw === 'object') {
    const t = raw as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    return { calories: num(t.calories), protein: num(t.protein), carbs: num(t.carbs), fat: num(t.fat) };
  }
  const days = Object.values(daily);
  return {
    calories: days.reduce((s, d) => s + d.calories, 0),
    protein: Math.round(days.reduce((s, d) => s + d.protein, 0) * 10) / 10,
    carbs: Math.round(days.reduce((s, d) => s + d.carbs, 0) * 10) / 10,
    fat: Math.round(days.reduce((s, d) => s + d.fat, 0) * 10) / 10,
  };
}

function countMeals(plan: AiMealPlan): number {
  return Object.values(plan.meal_plan).reduce(
    (sum, day) => sum + Object.values(day).filter((r) => r !== null).length,
    0,
  );
}

function buildLocalPlan(input: MealPlanGenerationInput): AiMealPlan {
  const localInput: LocalMealPlanInput = {
    pantry: input.pantry.map((p) => ({
      name: p.name,
      quantity: p.quantity,
      unit: p.unit,
      category: p.category,
      expiryDate: p.expiryDate,
      daysUntilExpiry: p.daysUntilExpiry,
    })),
    dietaryPreference: input.dietaryPreference,
    allergies: input.allergies.map((a) => a.allergen),
    avoid: input.avoid,
    extraIngredients: [],
    cuisines: input.profile.cuisines,
    servings: input.servings,
    count: 40,
    minPantryMatch: 0,
    dailyCalories: input.profile.calories ?? 2000,
    days: input.days,
    mealsPerDay: input.mealsPerDay,
    mealTypes: input.mealTypes,
    variety: input.variety,
    budget: input.budget ?? null,
    cookingTimePref: input.cookingTimePref,
    startDate: input.startDate,
  };
  return generateLocalMealPlan(localInput);
}

/** Verify each day hits the calorie target within tolerance (spec: ±10%). */
export function verifyPlan(plan: AiMealPlan, dailyTarget: number | null): MealPlanGenerationOutput['verification'] {
  const target = dailyTarget ?? 2000;
  const perDay: MacroCheck[] = [];
  const warnings: string[] = [];

  for (const [dayKey, summary] of Object.entries(plan.daily_nutrition_summary)) {
    const check = checkDailyMacros(dayIndex(dayKey) + 1, summary.calories, target, 10);
    perDay.push(check);
    if (!check.withinTolerance) {
      warnings.push(
        `${titleCase(dayKey)} is ${check.delta > 0 ? 'over' : 'under'} target by ${Math.abs(check.delta)} kcal (${check.deltaPct > 0 ? '+' : ''}${check.deltaPct}%).`,
      );
    }
  }

  const withinTolerance = perDay.filter((d) => d.withinTolerance).length;
  if (perDay.length && withinTolerance < perDay.length) {
    warnings.push(
      `${withinTolerance}/${perDay.length} days are within ±10% of your ${target} kcal target. Tap a meal to swap it.`,
    );
  }

  return {
    daysChecked: perDay.length,
    daysWithinTolerance: withinTolerance,
    tolerancePct: 10,
    warnings,
    perDay,
  };
}

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function dayIndex(dayKey: string): number {
  const idx = DAY_ORDER.indexOf(dayKey.toLowerCase());
  return idx === -1 ? 0 : idx;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Generate a single replacement meal for swap / regenerate-day. */
export async function generateReplacementMeal(params: {
  profile: PromptUserProfile;
  pantry: PromptPantryItem[];
  dayName: string;
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  avoidTitles: string[];
  allergies: Array<{ allergen: string; severity: string }>;
  dietaryPreference: string;
  servings: number;
  userId?: string | null;
}): Promise<{ recipe: AiRecipe; modelUsed: string; costUsd: number }> {
  const guardContext: GuardContext = {
    allergies: params.allergies,
    dietaryPreference: params.dietaryPreference,
    avoid: [],
  };

  if (reasoningMode() === 'live') {
    for (const provider of batchReasoningChain()) {
      try {
        const call = await provider.generateJson<unknown>({
          system: MEAL_PLAN_SYSTEM_PROMPT,
          prompt: buildSwapMealPrompt({
            profile: params.profile,
            pantry: params.pantry,
            dayName: params.dayName,
            mealType: params.mealType,
            avoidTitles: params.avoidTitles,
          }),
          maxTokens: 2048,
          temperature: 0.8,
          label: `swap:${params.mealType}`,
        });

        const container = call.data as Record<string, unknown>;
        const payload = container.recipe ?? container;
        const [recipe] = normalizeBatch({ recipes: [payload] }, 1);
        if (!recipe) continue;

        const guarded = guardBatch([recipe], guardContext);
        const safe = guarded.recipes[0];
        if (!safe) continue;

        recordAiUsage({
          userId: params.userId ?? null,
          task: 'mealplan',
          provider: call.provider,
          model: call.model,
          success: true,
          latencyMs: call.latencyMs,
          usage: call.usage,
        });

        return { recipe: safe, modelUsed: call.model, costUsd: call.usage.costUsd };
      } catch (err) {
        logger.warn({ provider: provider.name, err: (err as Error).message }, 'Replacement meal generation failed');
      }
    }
  }

  // Built-in fallback.
  const plan = generateLocalMealPlan({
    pantry: params.pantry.map((p) => ({ name: p.name, quantity: p.quantity, unit: p.unit, category: p.category, daysUntilExpiry: p.daysUntilExpiry })),
    dietaryPreference: params.dietaryPreference,
    allergies: params.allergies.map((a) => a.allergen),
    avoid: [],
    extraIngredients: [],
    days: 1,
    mealsPerDay: 1,
    mealTypes: [params.mealType],
    variety: 'high',
    cookingTimePref: 'balanced',
    startDate: new Date().toISOString().slice(0, 10),
    servings: params.servings,
    count: 5,
    minPantryMatch: 0,
    dailyCalories: params.profile.calories ?? 2000,
  });

  const slot = Object.values(plan.meal_plan)[0]?.[params.mealType];
  if (!slot) throw new Error('Could not generate a replacement meal');
  return { recipe: slot, modelUsed: 'local-engine', costUsd: 0 };
}
