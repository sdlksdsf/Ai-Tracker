import { CACHE_TTL_SECONDS } from '@platematch/shared';
import { env, hasEdamamKeys } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { CacheKeys, cached } from '../../lib/redis.js';
import { stableHash } from '../../lib/crypto.js';
import { fetchJson } from './http.js';
import { edamamCost } from './cost.js';
import { recordAiUsage } from './ledger.js';
import { formatQuantity, normalizeIngredient, round1, toGrams } from '../../utils/food.js';
import { lookupComposition, scaleComposition, type FoodComposition } from '../../data/nutrition-db.js';
import type { AiRecipe } from './types.js';

/**
 * Nutritional analysis (Section 5.D)
 * ===========================================================================
 * Primary: Edamam Nutrition Analysis API v2 — per-ingredient and per-recipe
 * accuracy, cached in Redis for 30 days because nutritional values for common
 * ingredients do not change.
 *
 * Fallback: the built-in composition table (`data/nutrition-db.ts`), so every
 * recipe always has nutrition data even with no Edamam credentials.
 *
 * Every recipe is enriched exactly once; the result is written to
 * `recipe_nutrition` with `source = 'edamam' | 'local'`.
 */

export interface NutritionSummary {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
  cholesterol_mg: number;
  saturated_fat_g: number;
  vitamin_a_pct: number;
  vitamin_c_pct: number;
  calcium_pct: number;
  iron_pct: number;
  potassium_mg: number;
  per_serving: boolean;
  source: 'edamam' | 'local' | 'ai';
  /** Per-ingredient breakdown, useful for the "Nutrition" tab detail table. */
  perIngredient?: Array<{ ingredient: string; calories: number; protein_g: number; carbs_g: number; fat_g: number }>;
}

export interface IngredientLine {
  name: string;
  quantity: number | null;
  unit: string | null;
}

// ---------------------------------------------------------------------------
// Edamam
// ---------------------------------------------------------------------------

interface EdamamResponse {
  uri?: string;
  yield?: number;
  calories?: number;
  totalWeight?: number;
  totalNutrients?: Record<string, { label: string; quantity: number; unit: string }>;
  totalDaily?: Record<string, { label: string; quantity: number; unit: string }>;
  ingredients?: Array<{ text: string; parsed?: Array<{ food?: string; measures?: unknown[] }> }>;
  error?: unknown;
}

/** Build an Edamam "ingr" line, e.g. `"500g chicken breast"`. */
export function toEdamamLine(ingredient: IngredientLine): string {
  const qty = ingredient.quantity;
  const unit = ingredient.unit;
  if (qty == null) {
    // Edamam needs a quantity; default to a modest single portion.
    return `100g ${ingredient.name}`;
  }
  return unit ? `${qty}${unit} ${ingredient.name}` : `${qty} ${ingredient.name}`;
}

/**
 * Call Edamam for a list of ingredient lines. Cached for 30 days.
 * Returns null when Edamam is unavailable so callers can fall back.
 */
export async function analyseWithEdamam(
  lines: string[],
  userId?: string | null,
): Promise<NutritionSummary | null> {
  if (!hasEdamamKeys || !lines.length) return null;

  const cacheKey = CacheKeys.nutrition(stableHash(lines.slice().sort()));

  return cached(cacheKey, CACHE_TTL_SECONDS.nutrition, async () => {
    const url = `${env.EDAMAM_BASE_URL}?app_id=${encodeURIComponent(env.EDAMAM_APP_ID as string)}&app_key=${encodeURIComponent(env.EDAMAM_APP_KEY as string)}`;
    const started = Date.now();

    try {
      const { data } = await fetchJson<EdamamResponse>(url, {
        method: 'POST',
        body: { ingr: lines },
        timeoutMs: 20_000,
        retries: 1,
        label: 'edamam:nutrition-details',
      });

      const nutrients = data.totalNutrients ?? {};
      const daily = data.totalDaily ?? {};
      const servings = data.yield && data.yield > 0 ? data.yield : 1;

      const value = (code: string): number | undefined => nutrients[code]?.quantity;
      const dailyValue = (code: string): number | undefined => daily[code]?.quantity;

      const summary: NutritionSummary = {
        calories: round1((data.calories ?? 0) / servings),
        protein_g: round1((value('PROCNT') ?? 0) / servings),
        carbs_g: round1((value('CHOCDF') ?? 0) / servings),
        fat_g: round1((value('FAT') ?? 0) / servings),
        fiber_g: round1((value('FIBTG') ?? 0) / servings),
        sugar_g: round1((value('SUGAR') ?? 0) / servings),
        sodium_mg: round1((value('NA') ?? 0) / servings),
        cholesterol_mg: round1((value('CHOLE') ?? 0) / servings),
        saturated_fat_g: round1((value('FASAT') ?? 0) / servings),
        potassium_mg: round1((value('K') ?? 0) / servings),
        vitamin_a_pct: round1(dailyValue('VITA_RAE') ?? 0),
        vitamin_c_pct: round1(dailyValue('VITC') ?? 0),
        calcium_pct: round1(dailyValue('CA') ?? 0),
        iron_pct: round1(dailyValue('FE') ?? 0),
        per_serving: true,
        source: 'edamam',
      };

      recordAiUsage({
        userId: userId ?? null,
        task: 'nutrition',
        provider: 'edamam',
        model: 'nutrition-analysis-v2',
        success: true,
        latencyMs: Date.now() - started,
        usage: { costUsd: edamamCost() },
      });

      return summary;
    } catch (err) {
      recordAiUsage({
        userId: userId ?? null,
        task: 'nutrition',
        provider: 'edamam',
        model: 'nutrition-analysis-v2',
        success: false,
        latencyMs: Date.now() - started,
        errorCode: 'edamam_error',
      });
      logger.warn({ err: (err as Error).message, ingredients: lines.length }, 'Edamam analysis failed — using the local table');
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Local composition table
// ---------------------------------------------------------------------------

/** Compute nutrition offline from the built-in composition table. */
export function analyseLocally(ingredients: IngredientLine[], servings = 1): NutritionSummary {
  const totals: FoodComposition = {
    kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodiumMg: 0,
  };
  const perIngredient: NutritionSummary['perIngredient'] = [];
  let matched = 0;

  for (const ingredient of ingredients) {
    const comp = lookupComposition(ingredient.name);
    if (!comp) continue;

    matched += 1;
    // Assume a sensible default portion for unquantified ingredients.
    const grams = toGrams(ingredient.quantity, ingredient.unit) ?? 100;
    const scaled = scaleComposition(comp, grams);

    totals.kcal += scaled.kcal;
    totals.protein += scaled.protein;
    totals.carbs += scaled.carbs;
    totals.fat += scaled.fat;
    totals.fiber += scaled.fiber;
    totals.sugar += scaled.sugar;
    totals.sodiumMg += scaled.sodiumMg;

    perIngredient.push({
      ingredient: ingredient.name,
      calories: Math.round(scaled.kcal),
      protein_g: round1(scaled.protein),
      carbs_g: round1(scaled.carbs),
      fat_g: round1(scaled.fat),
    });
  }

  // Ingredients we could not identify still contribute energy; assume ~60 kcal
  // per unquantified item so the total is never wildly under-reported.
  const unmatched = ingredients.length - matched;
  totals.kcal += unmatched * 60;

  const safeServings = Math.max(1, servings);

  return {
    calories: round1(totals.kcal / safeServings),
    protein_g: round1(totals.protein / safeServings),
    carbs_g: round1(totals.carbs / safeServings),
    fat_g: round1(totals.fat / safeServings),
    fiber_g: round1(totals.fiber / safeServings),
    sugar_g: round1(totals.sugar / safeServings),
    sodium_mg: round1(totals.sodiumMg / safeServings),
    cholesterol_mg: 0,
    saturated_fat_g: 0,
    vitamin_a_pct: 0,
    vitamin_c_pct: 0,
    calcium_pct: 0,
    iron_pct: 0,
    potassium_mg: 0,
    per_serving: true,
    source: 'local',
    perIngredient: perIngredient.sort((a, b) => b.calories - a.calories).slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  /** Force the local table (tests / offline mode). */
  forceLocal?: boolean;
  userId?: string | null;
}

/**
 * Enrich a generated recipe with nutrition data.
 *
 * Order of preference:
 *   1. Edamam (verified)
 *   2. Local composition table
 *   3. The model's own estimate (marked `source: 'ai'`)
 */
export async function enrichRecipe(recipe: AiRecipe, options: EnrichOptions = {}): Promise<NutritionSummary> {
  const lines = recipe.ingredients.map((i) => toEdamamLine({ name: i.name, quantity: i.quantity, unit: i.unit }));

  if (!options.forceLocal) {
    const edamam = await analyseWithEdamam(lines, options.userId);
    if (edamam && edamam.calories > 0) return edamam;
  }

  const local = analyseLocally(
    recipe.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
    recipe.servings,
  );

  // If the local table matched nothing, trust the model's estimate.
  if (local.calories === 0 || local.protein_g + local.carbs_g + local.fat_g === 0) {
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
      per_serving: true,
      source: 'ai',
    };
  }

  return local;
}

/** Batch enrichment — used after meal-plan generation (bounded concurrency). */
export async function enrichRecipes(
  recipes: AiRecipe[],
  options: EnrichOptions = {},
  concurrency = 4,
): Promise<Map<AiRecipe, NutritionSummary>> {
  const out = new Map<AiRecipe, NutritionSummary>();
  let index = 0;

  async function worker(): Promise<void> {
    while (index < recipes.length) {
      const current = index;
      index += 1;
      const recipe = recipes[current] as AiRecipe;
      try {
        out.set(recipe, await enrichRecipe(recipe, options));
      } catch (err) {
        logger.warn({ err: (err as Error).message, recipe: recipe.title }, 'Nutrition enrichment failed');
        out.set(recipe, {
          calories: recipe.estimated_nutrition_per_serving.calories,
          protein_g: recipe.estimated_nutrition_per_serving.protein_g,
          carbs_g: recipe.estimated_nutrition_per_serving.carbs_g,
          fat_g: recipe.estimated_nutrition_per_serving.fat_g,
          fiber_g: recipe.estimated_nutrition_per_serving.fiber_g,
          sugar_g: 0,
          sodium_mg: recipe.estimated_nutrition_per_serving.sodium_mg,
          cholesterol_mg: 0,
          saturated_fat_g: 0,
          vitamin_a_pct: 0,
          vitamin_c_pct: 0,
          calcium_pct: 0,
          iron_pct: 0,
          potassium_mg: 0,
          per_serving: true,
          source: 'ai',
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, recipes.length) }, worker));
  return out;
}

/** Human-readable ingredient line for logs/debugging. */
export function describeIngredients(ingredients: IngredientLine[]): string {
  return ingredients.map((i) => `${formatQuantity(i.quantity, i.unit)} ${normalizeIngredient(i.name)}`).join(', ');
}
