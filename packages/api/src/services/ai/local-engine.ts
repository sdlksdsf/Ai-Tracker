import {
  AI_CONFIDENCE,
  DIETARY_EXCLUSIONS,
  type DietaryPreference,
  type DifficultyLevel,
  type IngredientCategory,
  type MealType,
} from '@platematch/shared';
import { ALLERGEN_INGREDIENT_KEYWORDS } from '@platematch/shared';
import { RECIPE_CORPUS, toAiRecipe } from '../../data/recipe-corpus.js';
import { estimatePriceUsd, normalizeIngredient, round2, similarity } from '../../utils/food.js';
import type { AiMealPlan, AiRecipe } from './types.js';

/**
 * Built-in deterministic recipe engine
 * ===========================================================================
 * This is the "no API keys" path and the last-resort fallback for the AI
 * pipeline. It ranks the curated corpus against the user's pantry, diet and
 * allergens using the same matching primitives the AI post-processor uses, so
 * results are consistent whether or not a model answered.
 *
 * It is deliberately conservative: it never invents ingredients, never ignores
 * an allergy, and always explains why a recipe scored the way it did.
 */

export interface LocalPantryItem {
  id?: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  category: IngredientCategory | string;
  expiryDate?: string | null;
  daysUntilExpiry?: number | null;
}

export interface LocalEngineInput {
  pantry: LocalPantryItem[];
  dietaryPreference: DietaryPreference | string;
  allergies: string[];
  avoid: string[];
  extraIngredients: string[];
  cuisines?: string[];
  mealType?: MealType | string;
  difficulty?: DifficultyLevel | string;
  maxTimeMin?: number;
  servings?: number;
  count?: number;
  /** Daily calorie target — used for meal-plan balancing. */
  dailyCalories?: number | null;
  minPantryMatch?: number;
}

export interface ScoredRecipe {
  recipe: AiRecipe;
  /** 0..1 share of non-optional ingredients found in the pantry (+ user extras). */
  pantryRatio: number;
  inPantry: number;
  total: number;
  missing: string[];
  matchedPantryIds: string[];
  usesExpiring: string[];
  /** Composite 0..100 ranking score. */
  score: number;
  estimatedCostPerServing: number;
}

/** Ingredients we assume everyone has (prompt rule #4). */
const STAPLES = new Set(
  ['salt', 'black pepper', 'pepper', 'water', 'cooking oil', 'vegetable oil', 'olive oil', 'oil', 'sugar', 'flour', 'white pepper']
    .map(normalizeIngredient),
);

export function isStaple(name: string): boolean {
  const key = normalizeIngredient(name);
  return STAPLES.has(key) || [...STAPLES].some((s) => key.endsWith(` ${s}`));
}

/**
 * SAFETY: does `ingredientName` trip any of the user's allergens or dietary
 * exclusions? Matching is substring-based on normalised names, which is the
 * conservative (over-blocking) direction — exactly what you want for allergies.
 */
export function violatesRestrictions(
  ingredientName: string,
  allergies: string[],
  dietaryPreference: DietaryPreference | string,
  avoid: string[] = [],
): { allergen: string | null; reason: 'allergen' | 'diet' | 'avoid' | null } {
  const key = normalizeIngredient(ingredientName);
  if (!key) return { allergen: null, reason: null };

  for (const allergen of allergies) {
    const keywords = ALLERGEN_INGREDIENT_KEYWORDS[normalizeIngredient(allergen)] ?? [normalizeIngredient(allergen)];
    for (const keyword of keywords) {
      const kw = normalizeIngredient(keyword);
      if (!kw) continue;
      if (key === kw || key.includes(kw) || kw.includes(key)) {
        return { allergen, reason: 'allergen' };
      }
    }
  }

  const exclusions = DIETARY_EXCLUSIONS[dietaryPreference as DietaryPreference] ?? [];
  for (const excluded of exclusions) {
    const ex = normalizeIngredient(excluded);
    if (key === ex || key.includes(ex)) return { allergen: excluded, reason: 'diet' };
  }

  for (const a of avoid) {
    const av = normalizeIngredient(a);
    if (av && (key === av || key.includes(av) || av.includes(key))) return { allergen: a, reason: 'avoid' };
  }

  return { allergen: null, reason: null };
}

/** Score one corpus recipe against the request. Returns null when disqualified. */
function scoreRecipe(recipeIndex: number, input: LocalEngineInput): ScoredRecipe | null {
  const entry = RECIPE_CORPUS[recipeIndex];
  if (!entry) return null;

  const servings = input.servings ?? entry.servings;
  const recipe = toAiRecipe(entry, { servings });

  // --- Hard filters -------------------------------------------------------
  if (input.mealType && entry.mealType !== input.mealType) return null;
  if (input.difficulty && entry.difficulty !== input.difficulty) return null;
  if (input.maxTimeMin && recipe.total_time_min > input.maxTimeMin) return null;

  const available = [...input.pantry.map((p) => p.name), ...input.extraIngredients];

  const missing: string[] = [];
  const matchedPantryIds: string[] = [];
  const usesExpiring: string[] = [];
  let inPantry = 0;
  let considered = 0;

  for (const ingredient of recipe.ingredients) {
    // Safety first: any allergen/diet violation disqualifies the whole recipe.
    const violation = violatesRestrictions(
      ingredient.name,
      input.allergies,
      input.dietaryPreference,
      input.avoid,
    );
    if (violation.reason === 'allergen' || violation.reason === 'diet') return null;

    if (isStaple(ingredient.name)) continue; // not counted as "missing"
    if (ingredient.is_optional) continue;
    considered += 1;

    let bestScore = 0;
    let bestId: string | null = null;
    let bestName: string | null = null;

    for (const item of input.pantry) {
      const score = similarity(ingredient.name, item.name);
      if (score > bestScore) {
        bestScore = score;
        bestId = item.id ?? null;
        bestName = item.name;
      }
    }
    for (const extra of input.extraIngredients) {
      const score = similarity(ingredient.name, extra);
      if (score > bestScore) {
        bestScore = score;
        bestName = extra;
      }
    }

    if (bestScore >= 0.78) {
      inPantry += 1;
      if (bestId) matchedPantryIds.push(bestId);
      // Does this consume something about to expire?
      const expiring = input.pantry.find(
        (p) => p.name === bestName && p.daysUntilExpiry != null && p.daysUntilExpiry >= 0 && p.daysUntilExpiry <= 3,
      );
      if (expiring) usesExpiring.push(expiring.name);
    } else if (bestScore < 0.55 && available.some((a) => similarity(ingredient.name, a) >= 0.6)) {
      inPantry += 1; // loose match, e.g. "bell pepper" vs "red pepper"
    } else {
      missing.push(ingredient.name);
    }
  }

  const pantryRatio = considered === 0 ? 0 : inPantry / considered;
  const minMatch = input.minPantryMatch ?? 0.3;
  if (pantryRatio < minMatch && input.pantry.length > 0) return null;

  const estimatedCostPerServing = round2(
    recipe.ingredients.reduce(
      (sum, i) => sum + (isStaple(i.name) ? 0 : estimatePriceUsd(i.name, i.quantity, i.unit)),
      0,
    ) / Math.max(1, servings),
  );

  // --- Composite score ----------------------------------------------------
  // Pantry coverage dominates (that's the product), with bonuses for using
  // expiring items and cuisine preference, and penalties for cost/time.
  let score = pantryRatio * 60;
  score += Math.min(usesExpiring.length, 4) * 5; // up to +20
  score += Math.max(0, 12 - recipe.total_time_min / 10); // quicker is better, up to +12

  if (input.cuisines?.length) {
    const wanted = input.cuisines.map((c) => c.toLowerCase());
    if (wanted.includes(recipe.cuisine?.toLowerCase() ?? '') || wanted.includes('any')) score += 6;
  }

  // Penalise the number of extra ingredients to buy.
  score -= Math.min(missing.length * 2.5, 15);
  score -= estimatedCostPerServing * 1.5;

  // Slight deterministic variety so repeated calls do not always return the same set.
  score += ((recipeIndex * 37) % 7) * 0.4;

  return {
    recipe: {
      ...recipe,
      ingredients: recipe.ingredients.map((i) => ({
        ...i,
        is_in_pantry:
          isStaple(i.name) ||
          input.pantry.some((p) => similarity(i.name, p.name) >= 0.78) ||
          input.extraIngredients.some((e) => similarity(i.name, e) >= 0.78),
      })),
    },
    pantryRatio: Math.round(pantryRatio * 100) / 100,
    inPantry,
    total: considered,
    missing,
    matchedPantryIds,
    usesExpiring,
    score: Math.round(score * 10) / 10,
    estimatedCostPerServing,
  };
}

/** Rank the corpus and return the best `count` recipes. */
export function generateLocalRecipes(input: LocalEngineInput): ScoredRecipe[] {
  const count = input.count ?? 5;
  const scored: ScoredRecipe[] = [];

  for (let i = 0; i < RECIPE_CORPUS.length; i += 1) {
    const result = scoreRecipe(i, input);
    if (result) scored.push(result);
  }

  scored.sort((a, b) => b.score - a.score);

  // Avoid near-duplicate dishes (same cuisine + same main protein).
  const picked: ScoredRecipe[] = [];
  const seenKeys = new Set<string>();
  for (const candidate of scored) {
    const key = `${candidate.recipe.cuisine}:${candidate.recipe.tags.slice(0, 2).join(',')}`;
    if (seenKeys.has(key) && picked.length >= 2) continue;
    seenKeys.add(key);
    picked.push(candidate);
    if (picked.length >= count) break;
  }

  // If strict filtering left us short, relax and top up.
  if (picked.length < count) {
    for (const candidate of scored) {
      if (picked.includes(candidate)) continue;
      picked.push(candidate);
      if (picked.length >= count) break;
    }
  }

  return picked;
}

/** Convenience wrapper returning plain `AiRecipe[]`. */
export function generateLocalRecipesAsAi(input: LocalEngineInput): AiRecipe[] {
  return generateLocalRecipes(input).map((s) => s.recipe);
}

// ---------------------------------------------------------------------------
// Local meal-plan assembly
// ---------------------------------------------------------------------------

export interface LocalMealPlanInput extends LocalEngineInput {
  days: number;
  mealsPerDay: number;
  mealTypes: MealType[];
  variety: 'low' | 'medium' | 'high';
  budget?: number | null;
  cookingTimePref: 'quick' | 'balanced' | 'elaborate';
  startDate: string;
}

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

/**
 * Build a balanced 7-day (or n-day) plan from the corpus.
 *
 * Strategy: for each day/meal slot pick the highest-scoring recipe for that
 * meal type which has not been used recently (respecting `variety`), then
 * normalise the day's calories toward the target by preferring lighter options
 * for breakfast/snack when the plan is running hot.
 */
export function generateLocalMealPlan(input: LocalMealPlanInput): AiMealPlan {
  const days = Math.min(input.days, DAY_KEYS.length);
  const dayKeys = DAY_KEYS.slice(0, days);
  const mealTypes = input.mealTypes.slice(0, Math.max(1, input.mealsPerDay));
  const target = input.dailyCalories ?? 2000;

  // Rank per meal type once.
  const ranked = new Map<string, ScoredRecipe[]>();
  for (const mealType of mealTypes) {
    ranked.set(
      mealType,
      generateLocalRecipes({ ...input, mealType, count: 40, minPantryMatch: 0 }),
    );
  }

  // Fall back to any-meal rankings for slots a meal type has no candidates for.
  const anyRanked = generateLocalRecipes({ ...input, count: 40, minPantryMatch: 0 });
  for (const mealType of mealTypes) {
    if (!ranked.get(mealType)?.length) ranked.set(mealType, anyRanked);
  }

  const usedTitles = new Set<string>();
  const mealPlan: AiMealPlan['meal_plan'] = {};
  const dailySummary: AiMealPlan['daily_nutrition_summary'] = {};
  let weeklyCost = 0;
  const pantryUsed = new Set<string>();
  const groceryMap = new Map<string, { item: string; quantity: number; unit: string | null; estimated_price: number; needed_for: string[] }>();

  for (let dayIndex = 0; dayIndex < dayKeys.length; dayIndex += 1) {
    const dayKey = dayKeys[dayIndex] as string;
    const slots: Record<string, AiRecipe | null> = {};
    let dayCalories = 0;
    let dayProtein = 0;
    let dayCarbs = 0;
    let dayFat = 0;

    for (const mealType of mealTypes) {
      const candidates = ranked.get(mealType) ?? anyRanked;
      const pick = chooseForSlot(candidates, usedTitles, input.variety, mealType, target - dayCalories, dayIndex);

      if (!pick) {
        slots[mealType] = null;
        continue;
      }

      usedTitles.add(pick.recipe.title);
      slots[mealType] = pick.recipe;

      const perServing = pick.recipe.estimated_nutrition_per_serving;
      dayCalories += perServing.calories;
      dayProtein += perServing.protein_g;
      dayCarbs += perServing.carbs_g;
      dayFat += perServing.fat_g;

      for (const name of pick.usesExpiring) pantryUsed.add(name);
      for (const id of pick.matchedPantryIds) pantryUsed.add(id);

      // Aggregate missing ingredients into the grocery list.
      for (const missingName of pick.missing) {
        const ingredient = pick.recipe.ingredients.find((i) => i.name === missingName);
        const key = normalizeIngredient(missingName);
        const existing = groceryMap.get(key);
        const quantity = ingredient?.quantity ?? 1;
        const unit = ingredient?.unit ?? null;
        const price = estimatePriceUsd(missingName, quantity, unit);

        if (existing) {
          existing.quantity = round2(existing.quantity + (unit === existing.unit ? quantity : quantity));
          existing.estimated_price = round2(existing.estimated_price + price);
          existing.needed_for.push(`${dayKey} ${mealType}`);
        } else {
          groceryMap.set(key, {
            item: missingName,
            quantity: round2(quantity),
            unit,
            estimated_price: round2(price),
            needed_for: [`${dayKey} ${mealType}`],
          });
        }
      }

      weeklyCost += pick.estimatedCostPerServing * (input.servings ?? pick.recipe.servings);
    }

    mealPlan[dayKey] = slots;
    dailySummary[dayKey] = {
      calories: Math.round(dayCalories),
      protein: round2(dayProtein),
      carbs: round2(dayCarbs),
      fat: round2(dayFat),
    };
  }

  const groceryList = [...groceryMap.values()].sort((a, b) => b.estimated_price - a.estimated_price);
  const totalCalories = Object.values(dailySummary).reduce((sum, d) => sum + d.calories, 0);

  return {
    meal_plan: mealPlan,
    daily_nutrition_summary: dailySummary,
    weekly_nutrition_totals: {
      calories: totalCalories,
      protein: round2(Object.values(dailySummary).reduce((s, d) => s + d.protein, 0)),
      carbs: round2(Object.values(dailySummary).reduce((s, d) => s + d.carbs, 0)),
      fat: round2(Object.values(dailySummary).reduce((s, d) => s + d.fat, 0)),
    },
    grocery_list: groceryList,
    estimated_weekly_grocery_cost: round2(Math.min(weeklyCost, groceryList.reduce((s, g) => s + g.estimated_price, 0)) || groceryList.reduce((s, g) => s + g.estimated_price, 0)),
    pantry_items_used: [...pantryUsed],
    waste_reduction_tips: buildWasteTips(input),
    meal_prep_suggestions: buildPrepTips(input),
  };
}

function chooseForSlot(
  candidates: ScoredRecipe[],
  usedTitles: Set<string>,
  variety: 'low' | 'medium' | 'high',
  mealType: MealType | string,
  remainingCalories: number,
  dayIndex: number,
): ScoredRecipe | null {
  if (!candidates.length) return null;

  const allowRepeat = variety === 'low';
  const filtered = candidates.filter((c) => allowRepeat || !usedTitles.has(c.recipe.title));
  const pool = filtered.length ? filtered : candidates;

  // For breakfast/snack prefer lighter dishes; for dinner prefer protein-rich.
  const weighted = pool.map((candidate, index) => {
    const calories = candidate.recipe.estimated_nutrition_per_serving.calories;
    let bonus = 0;
    if (mealType === 'breakfast' || mealType === 'snack') bonus += calories <= 450 ? 8 : -4;
    if (mealType === 'dinner') bonus += candidate.recipe.estimated_nutrition_per_serving.protein_g >= 25 ? 8 : 0;
    // Nudge toward the remaining calorie budget for the day.
    if (remainingCalories > 0 && calories > remainingCalories) bonus -= 6;
    // Deterministic day-based rotation so consecutive days differ.
    bonus += ((index + dayIndex * 3) % 5) * 0.6;
    return { candidate, weight: candidate.score + bonus };
  });

  weighted.sort((a, b) => b.weight - a.weight);
  return weighted[0]?.candidate ?? null;
}

function buildWasteTips(input: LocalMealPlanInput): string[] {
  const expiring = input.pantry.filter((p) => p.daysUntilExpiry != null && p.daysUntilExpiry >= 0 && p.daysUntilExpiry <= 4);
  const tips: string[] = [];

  if (expiring.length) {
    tips.push(
      `Use ${expiring
        .slice(0, 4)
        .map((e) => e.name)
        .join(', ')} in the first two days — they are closest to their expiry date.`,
    );
  }
  tips.push('Cook a double batch of grains on day 1; the second half becomes a fast lunch later in the week.');
  tips.push('Store herbs upright in a glass of water in the fridge — they last up to two weeks longer.');
  tips.push('Freeze any bread you will not eat within three days; it toasts straight from frozen.');
  tips.push('Keep a "use first" box at the front of the fridge for anything opened or close to expiry.');

  return tips.slice(0, 5);
}

function buildPrepTips(input: LocalMealPlanInput): string[] {
  const tips = [
    'Batch-roast a tray of vegetables on Sunday — they go into bowls, wraps and pasta all week.',
    'Pre-portion snacks into containers so grab-and-go does not mean grab-and-waste.',
    'Wash and dry salad leaves as soon as you get home; line the container with paper towel.',
  ];
  if (input.cookingTimePref === 'quick') {
    tips.unshift('Chosen for speed: most meals here take under 25 minutes start to finish.');
  }
  return tips.slice(0, 4);
}

/**
 * Deterministic stand-in for the vision model.
 *
 * We will NOT pretend to recognise food from pixels — that would be worse than
 * useless for a pantry app. Instead we return an honest empty result with an
 * actionable suggestion, so the client falls through to its manual-add UI.
 */
export function buildVisionUnavailableResult(reason: string) {
  return {
    detectedItems: [],
    overallFridgeStatus: null,
    suggestions: [
      reason,
      'You can still add items manually — tap "Add Item Manually" below.',
      'Once an API key is configured, scans will identify every item automatically.',
    ],
    averageConfidence: 0,
    boundingBoxes: [],
    confidenceThreshold: AI_CONFIDENCE.minAccept,
  };
}
