import { CACHE_TTL_SECONDS } from '@platematch/shared';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { CacheKeys, cache } from '../../lib/redis.js';
import { stableHash } from '../../lib/crypto.js';
import { buildRecipePrompt, RECIPE_SYSTEM_PROMPT, type PromptPantryItem, type PromptUserProfile } from '../../config/prompts.js';
import { coerceCategory } from '../../utils/food.js';
import { guardBatch, type GuardContext } from './allergen-guard.js';
import { generateLocalRecipes, type LocalEngineInput } from './local-engine.js';
import { recordAiUsage } from './ledger.js';
import { reasoningChain, reasoningMode } from './index.js';
import type { AiRecipe, AiRecipeBatch, ReasoningProvider } from './types.js';

/**
 * Recipe generation orchestration (Section 5.B)
 * ===========================================================================
 *   1. Build the structured prompt from profile + pantry + request.
 *   2. Check the Redis generation cache (identical ingredient combos, 1 h TTL).
 *   3. Call the reasoning chain: Claude → OpenAI → Gemini.
 *   4. Validate + normalise the JSON.
 *   5. Run the allergen/diet safety guard (rejects or repairs unsafe recipes).
 *   6. If the model produced fewer recipes than requested, top up from the
 *      built-in engine so the user always sees a full set.
 */

export interface RecipeGenerationInput {
  profile: PromptUserProfile;
  pantry: PromptPantryItem[];
  expiringSoon: PromptPantryItem[];
  allergies: Array<{ allergen: string; severity: string }>;
  dietaryPreference: string;
  avoid: string[];
  extraIngredients: string[];
  cuisine?: string;
  mealType?: string;
  difficulty?: string;
  maxTimeMin?: number;
  servings: number;
  count: number;
  minPantryMatch: number;
  userId?: string | null;
  signal?: AbortSignal;
}

export interface RecipeGenerationOutput {
  recipes: AiRecipe[];
  modelUsed: string;
  provider: string;
  latencyMs: number;
  costUsd: number;
  cached: boolean;
  /** True when the built-in engine supplied any or all recipes. */
  usedLocalEngine: boolean;
  safetyNotes: string[];
}

export async function generateRecipes(input: RecipeGenerationInput): Promise<RecipeGenerationOutput> {
  const started = Date.now();

  const cacheKey = CacheKeys.recipeGeneration(
    stableHash({
      diet: input.dietaryPreference,
      allergies: input.allergies.map((a) => a.allergen).sort(),
      avoid: [...input.avoid].sort(),
      extra: [...input.extraIngredients].sort(),
      pantry: input.pantry.map((p) => p.name.toLowerCase()).sort(),
      expiring: input.expiringSoon.map((p) => p.name.toLowerCase()).sort(),
      cuisine: input.cuisine ?? null,
      meal: input.mealType ?? null,
      difficulty: input.difficulty ?? null,
      maxTime: input.maxTimeMin ?? null,
      servings: input.servings,
      count: input.count,
    }),
  );

  const hit = await cache.get<AiRecipe[]>(cacheKey);
  if (hit && hit.length) {
    logger.debug({ cacheKey, count: hit.length }, 'Recipe generation cache hit');
    return {
      recipes: hit,
      modelUsed: 'cache',
      provider: 'cache',
      latencyMs: Date.now() - started,
      costUsd: 0,
      cached: true,
      usedLocalEngine: false,
      safetyNotes: [],
    };
  }

  const guardContext: GuardContext = {
    allergies: input.allergies,
    dietaryPreference: input.dietaryPreference,
    avoid: input.avoid,
  };

  let modelRecipes: AiRecipe[] = [];
  let modelUsed = 'local-engine';
  let providerUsed = 'local';
  let costUsd = 0;
  const safetyNotes: string[] = [];
  let usedLocalEngine = false;

  // ---- Live providers -----------------------------------------------------
  if (reasoningMode() === 'live') {
    const chain = reasoningChain();
    const prompt = buildRecipePrompt({
      profile: input.profile,
      pantry: input.pantry,
      expiringSoon: input.expiringSoon,
      count: input.count,
      servings: input.servings,
      cuisine: input.cuisine,
      mealType: input.mealType,
      difficulty: input.difficulty,
      maxTimeMin: input.maxTimeMin,
      extraIngredients: input.extraIngredients,
      avoid: input.avoid,
      minPantryMatch: input.minPantryMatch,
    });

    for (const provider of chain) {
      try {
        const call = await provider.generateJson<AiRecipeBatch>({
          system: RECIPE_SYSTEM_PROMPT,
          prompt,
          maxTokens: env.AI_RECIPE_MAX_TOKENS,
          temperature: env.AI_RECIPE_TEMPERATURE,
          signal: input.signal,
          label: `recipe:${input.count}`,
        });

        const raw = normalizeBatch(call.data, input.count);
        const guarded = guardBatch(raw, guardContext);

        recordAiUsage({
          userId: input.userId ?? null,
          task: 'recipe',
          provider: call.provider,
          model: call.model,
          success: true,
          latencyMs: call.latencyMs,
          usage: call.usage,
        });

        modelRecipes = guarded.recipes;
        safetyNotes.push(...guarded.notes);
        modelUsed = call.model;
        providerUsed = call.provider;
        costUsd = call.usage.costUsd;

        if (modelRecipes.length > 0) break;
        logger.warn({ provider: provider.name }, 'Provider returned no usable recipes — trying the next one');
      } catch (err) {
        recordAiUsage({
          userId: input.userId ?? null,
          task: 'recipe',
          provider: provider.name,
          model: provider.model,
          success: false,
          latencyMs: 0,
          errorCode: (err as Error).name ?? 'error',
        });
        logger.warn({ provider: provider.name, err: (err as Error).message }, 'Recipe generation provider failed');
      }
    }
  }

  // ---- Built-in engine: primary in mock mode, top-up otherwise ------------
  if (modelRecipes.length < input.count) {
    const needed = input.count - modelRecipes.length;
    const local = generateLocalRecipes(toLocalInput(input, modelRecipes.map((r) => r.title)));

    if (local.length) {
      usedLocalEngine = true;
      if (modelRecipes.length === 0) {
        modelUsed = 'local-engine';
        providerUsed = 'local';
      } else {
        safetyNotes.push(
          `Only ${modelRecipes.length} recipe(s) passed the safety check — ${needed} more were supplied by the built-in recipe engine.`,
        );
      }
      modelRecipes = [...modelRecipes, ...local.slice(0, needed).map((s) => s.recipe)];
    } else if (modelRecipes.length === 0) {
      safetyNotes.push(
        'No recipes matched your pantry and dietary restrictions. Try adding ingredients, relaxing the filters, or increasing the maximum cooking time.',
      );
    }
  }

  const recipes = dedupeByTitle(modelRecipes).slice(0, input.count);

  if (recipes.length) {
    await cache.set(cacheKey, recipes, CACHE_TTL_SECONDS.recipeGeneration);
  }

  return {
    recipes,
    modelUsed,
    provider: providerUsed,
    latencyMs: Date.now() - started,
    costUsd,
    cached: false,
    usedLocalEngine,
    safetyNotes: [...new Set(safetyNotes)],
  };
}

/** Convert provider output into `AiRecipe[]`, tolerating common shape drift. */
export function normalizeBatch(raw: unknown, expectedCount: number): AiRecipe[] {
  if (!raw || typeof raw !== 'object') return [];

  const container = raw as Record<string, unknown>;
  const candidates = Array.isArray(container.recipes)
    ? container.recipes
    : Array.isArray(raw)
      ? (raw as unknown[])
      : Array.isArray(container.data)
        ? (container.data as unknown[])
        : [];

  const out: AiRecipe[] = [];
  for (const candidate of candidates.slice(0, Math.max(expectedCount, 1) + 2)) {
    const recipe = normalizeRecipe(candidate);
    if (recipe) out.push(recipe);
    if (out.length >= expectedCount) break;
  }
  return out;
}

function normalizeRecipe(raw: unknown): AiRecipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const title = str(r.title ?? r.name ?? r.recipe_title);
  if (!title) return null;

  const ingredientsRaw = Array.isArray(r.ingredients) ? r.ingredients : [];
  const stepsRaw = Array.isArray(r.steps ?? r.instructions ?? r.method) ? (r.steps ?? r.instructions ?? r.method) as unknown[] : [];

  const ingredients = ingredientsRaw
    .map((rawIng) => {
      if (typeof rawIng === 'string') {
        return {
          name: rawIng,
          quantity: null,
          unit: null,
          category: 'other' as const,
          is_in_pantry: false,
          is_optional: false,
          substitutes: [] as string[],
        };
      }
      if (!rawIng || typeof rawIng !== 'object') return null;
      const i = rawIng as Record<string, unknown>;
      const name = str(i.name ?? i.ingredient ?? i.item);
      if (!name) return null;
      return {
        name,
        quantity: num(i.quantity ?? i.amount),
        unit: str(i.unit ?? i.units) ?? null,
        category: coerceCategoryValue(i.category),
        is_in_pantry: Boolean(i.is_in_pantry ?? i.inPantry ?? i.isInPantry),
        is_optional: Boolean(i.is_optional ?? i.optional),
        substitutes: strArray(i.substitutes ?? i.substitutions ?? i.alternatives),
      };
    })
    .filter((i): i is NonNullable<typeof i> => i !== null);

  if (ingredients.length === 0) return null;

  const steps = stepsRaw
    .map((rawStep, index) => {
      if (typeof rawStep === 'string') {
        return { step_number: index + 1, instruction: rawStep, duration_min: null, tip: null };
      }
      if (!rawStep || typeof rawStep !== 'object') return null;
      const s = rawStep as Record<string, unknown>;
      const instruction = str(s.instruction ?? s.text ?? s.description ?? s.step);
      if (!instruction) return null;
      return {
        step_number: num(s.step_number ?? s.number) ?? index + 1,
        instruction,
        duration_min: num(s.duration_min ?? s.duration ?? s.time_min),
        tip: str(s.tip ?? s.note ?? s.pro_tip) ?? null,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s, index) => ({ ...s, step_number: index + 1 }));

  if (steps.length === 0) return null;

  const nutritionRaw = (r.estimated_nutrition_per_serving ?? r.nutrition ?? r.nutrition_per_serving ?? {}) as Record<string, unknown>;

  const prep = num(r.prep_time_min ?? r.prep_time ?? r.prepTime) ?? 10;
  const cook = num(r.cook_time_min ?? r.cook_time ?? r.cookTime) ?? 15;
  const total = num(r.total_time_min ?? r.total_time ?? r.totalTime) ?? prep + cook;
  const servings = Math.max(1, num(r.servings ?? r.serves) ?? 2);

  return {
    title: title.slice(0, 200),
    description: str(r.description ?? r.summary) ?? '',
    cuisine: str(r.cuisine) ?? 'Fusion',
    meal_type: normalizeMealType(r.meal_type ?? r.mealType),
    difficulty: normalizeDifficulty(r.difficulty),
    prep_time_min: Math.max(0, Math.round(prep)),
    cook_time_min: Math.max(0, Math.round(cook)),
    total_time_min: Math.max(1, Math.round(total)),
    servings: Math.min(12, servings),
    tags: strArray(r.tags),
    ingredients,
    steps,
    estimated_nutrition_per_serving: {
      calories: Math.max(0, num(nutritionRaw.calories ?? nutritionRaw.kcal) ?? 0),
      protein_g: Math.max(0, num(nutritionRaw.protein_g ?? nutritionRaw.protein) ?? 0),
      carbs_g: Math.max(0, num(nutritionRaw.carbs_g ?? nutritionRaw.carbohydrates ?? nutritionRaw.carbs) ?? 0),
      fat_g: Math.max(0, num(nutritionRaw.fat_g ?? nutritionRaw.fat) ?? 0),
      fiber_g: Math.max(0, num(nutritionRaw.fiber_g ?? nutritionRaw.fibre) ?? 0),
      sodium_mg: Math.max(0, num(nutritionRaw.sodium_mg ?? nutritionRaw.sodium) ?? 0),
    },
    allergen_warnings: strArray(r.allergen_warnings ?? r.warnings),
    storage_instructions: str(r.storage_instructions ?? r.storage) ?? 'Refrigerate leftovers in an airtight container for up to 3 days.',
    reheating_instructions: str(r.reheating_instructions ?? r.reheating),
  };
}

function normalizeMealType(value: unknown): AiRecipe['meal_type'] {
  const v = str(value)?.toLowerCase();
  if (v === 'breakfast' || v === 'lunch' || v === 'dinner' || v === 'snack') return v;
  return null;
}

function normalizeDifficulty(value: unknown): AiRecipe['difficulty'] {
  const v = str(value)?.toLowerCase();
  if (v === 'hard' || v === 'difficult' || v === 'advanced') return 'hard';
  if (v === 'medium' || v === 'moderate' || v === 'intermediate') return 'medium';
  return 'easy';
}

function coerceCategoryValue(value: unknown): AiRecipe['ingredients'][number]['category'] {
  return coerceCategory(value);
}

function dedupeByTitle(recipes: AiRecipe[]): AiRecipe[] {
  const seen = new Set<string>();
  const out: AiRecipe[] = [];
  for (const recipe of recipes) {
    const key = recipe.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(recipe);
  }
  return out;
}

function toLocalInput(input: RecipeGenerationInput, excludeTitles: string[]): LocalEngineInput & { excludeTitles: string[] } {
  return {
    pantry: input.pantry.map((p) => ({
      id: undefined,
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
    extraIngredients: input.extraIngredients,
    cuisines: input.cuisine ? [input.cuisine] : input.profile.cuisines,
    mealType: input.mealType,
    difficulty: input.difficulty,
    maxTimeMin: input.maxTimeMin ?? input.profile.maxTime,
    servings: input.servings,
    count: input.count,
    minPantryMatch: input.minPantryMatch,
    excludeTitles,
  };
}

// ---- tiny coercion helpers ------------------------------------------------

function str(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

export type { ReasoningProvider };
