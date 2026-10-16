import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type {
  CookRecipeInput,
  GenerateRecipesInput,
  PaginatedRecipes,
  RateRecipeInput,
  RecipeDto,
  SearchRecipesQuery,
} from '@platematch/shared';
import { getDb } from '../db/index.js';
import {
  aiUsageLogs,
  pantryItems,
  recipeCookLog,
  recipeIngredients,
  recipeNutrition,
  recipeRatings,
  recipeSteps,
  recipes,
  userFavorites,
  users,
  type PantryItem,
  type Recipe,
} from '../db/schema.js';
import type { RecipeIngredient as RecipeIngredientRow } from '../db/schema.js';
import { NotFoundError, QuotaExceededError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache, invalidateDashboardCaches } from '../lib/redis.js';
import { stableHash } from '../lib/crypto.js';
import { estimatePriceUsd, normalizeIngredient, round2, similarity } from '../utils/food.js';
import { dayKey, daysUntilExpiry } from '../utils/dates.js';
import { generateRecipes as aiGenerateRecipes, type RecipeGenerationInput } from './ai/recipe.service.js';
import { enrichRecipe, type NutritionSummary } from './ai/nutrition.service.js';
import { incrementUsage, isSpendCapped } from './ai/ledger.js';
import { getActivePantryCached, invalidatePantryCache } from './pantry.service.js';
import { getAllergies, getUserById } from './user.service.js';
import { getPlanLimits } from './subscription.service.js';
import { checkAndAward } from './achievement.service.js';
import { applyPantryMatch, recipeToDto, type RecipeDtoExtras, type RecipeWithChildren } from './dto.js';
import type { AiRecipe } from './ai/types.js';
import type { PromptPantryItem, PromptUserProfile } from '../config/prompts.js';

/**
 * Recipe service — generation, persistence, search, ratings, cooking.
 *
 * Generation flow (Section 4 → POST /recipes/generate):
 *   1. load the user profile, allergies and pantry
 *   2. enforce plan quotas + the per-user daily AI spend cap
 *   3. call the AI chain (Claude → GPT → Gemini → built-in engine)
 *   4. enrich with nutrition data (Edamam → local table → model estimate)
 *   5. persist the recipe + ingredients + steps + nutrition
 *   6. annotate each result with pantry availability and cost of missing items
 */

export interface GenerateResult {
  recipes: RecipeDto[];
  ai_model_used: string;
  generation_time_ms: number;
  cached: boolean;
  safety_notes: string[];
  used_local_engine: boolean;
}

export async function generateRecipesForUser(userId: string, input: GenerateRecipesInput): Promise<GenerateResult> {
  const db = getDb();
  const started = Date.now();

  const user = await getUserById(userId);
  if (!user) throw new NotFoundError('User not found');

  // ---- Quota -------------------------------------------------------------
  const limits = getPlanLimits(user.subscriptionTier);
  if (limits.recipeGenerationsPerDay > 0) {
    const usedToday = await countGenerationsToday(userId);
    if (usedToday >= limits.recipeGenerationsPerDay) {
      throw new QuotaExceededError(
        `You have used all ${limits.recipeGenerationsPerDay} free AI recipe generations today. Upgrade to Premium for unlimited generations.`,
        { limit: limits.recipeGenerationsPerDay, used: usedToday },
      );
    }
  }
  if (await isSpendCapped(userId)) {
    logger.warn({ userId }, 'AI spend cap reached');
    throw new QuotaExceededError('Daily AI budget reached. Please try again tomorrow or upgrade your plan.');
  }

  // ---- Context -----------------------------------------------------------
  const [allergies, pantryRows] = await Promise.all([getAllergies(userId), getActivePantryCached(userId)]);
  const pantryPrompt = toPromptPantry(pantryRows);
  const expiringSoon = pantryPrompt.filter((p) => p.daysUntilExpiry !== null && p.daysUntilExpiry >= 0 && p.daysUntilExpiry <= 3);

  const profile: PromptUserProfile = {
    dietaryPreference: user.dietaryPreference,
    allergies: allergies.map((a) => ({ allergen: a.allergen, severity: a.severity })),
    healthGoal: user.healthGoal,
    calories: user.dailyCalorieTarget,
    protein: user.dailyProteinTargetG,
    carbs: user.dailyCarbsTargetG,
    fat: user.dailyFatTargetG,
    familySize: user.familySize,
    cookingSkill: user.cookingSkillLevel,
    maxTime: input.max_time_min ?? user.maxCookingTimeMin,
    cuisines: user.preferredCuisines,
    currency: user.currency,
  };

  const aiInput: RecipeGenerationInput = {
    profile,
    pantry: pantryPrompt,
    expiringSoon,
    allergies: profile.allergies,
    dietaryPreference: user.dietaryPreference,
    avoid: input.avoid,
    extraIngredients: input.extra_ingredients,
    cuisine: input.cuisine,
    mealType: input.meal_type,
    difficulty: input.difficulty,
    maxTimeMin: input.max_time_min ?? user.maxCookingTimeMin,
    servings: input.servings,
    count: input.count,
    minPantryMatch: input.min_pantry_match,
    userId,
  };

  // ---- Generate ----------------------------------------------------------
  const generation = await aiGenerateRecipes(aiInput);

  // ---- Persist + enrich --------------------------------------------------
  const dtos: RecipeDto[] = [];
  for (const aiRecipe of generation.recipes) {
    const nutrition = await enrichRecipe(aiRecipe, { userId, forceLocal: generation.usedLocalEngine && generation.modelUsed === 'local-engine' }).catch(
      () => null,
    );
    // eslint-disable-next-line no-await-in-loop
    const dto = await persistAiRecipe(userId, aiRecipe, nutrition ?? fallbackNutrition(aiRecipe), generation.modelUsed);
    dtos.push(annotateWithPantry(dto, pantryRows, expiringSoon.map((p) => normalizeIngredient(p.name))));
  }

  await incrementUsage(userId, 'recipe', `recipe:${dayKey()}`, generation.costUsd);

  logger.info(
    { userId, count: dtos.length, model: generation.modelUsed, ms: Date.now() - started },
    'Recipes generated',
  );

  return {
    recipes: dtos,
    ai_model_used: generation.modelUsed,
    generation_time_ms: Date.now() - started,
    cached: generation.cached,
    safety_notes: generation.safetyNotes,
    used_local_engine: generation.usedLocalEngine,
  };
}

function fallbackNutrition(recipe: AiRecipe): NutritionSummary {
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

/** Write an `AiRecipe` into the database and return its DTO. */
export async function persistAiRecipe(
  userId: string,
  recipe: AiRecipe,
  nutrition: NutritionSummary,
  modelUsed: string,
  options: { isPublic?: boolean; promptHash?: string } = {},
): Promise<RecipeDto> {
  const db = getDb();

  const promptHash = options.promptHash ?? stableHash({ title: recipe.title, ingredients: recipe.ingredients.map((i) => normalizeIngredient(i.name)).sort() });

  const totalCost = round2(
    recipe.ingredients.reduce(
      (sum, i) => sum + (i.is_in_pantry ? 0 : estimatePriceUsd(i.name, i.quantity, i.unit)),
      0,
    ) / Math.max(1, recipe.servings) * Math.max(1, recipe.servings),
  );

  const dietTags = deriveDietTags(recipe);

  const [row] = await db
    .insert(recipes)
    .values({
      ownerId: userId,
      title: recipe.title.slice(0, 200),
      description: recipe.description?.slice(0, 4000) ?? null,
      cuisine: recipe.cuisine?.slice(0, 50) ?? null,
      mealType: recipe.meal_type ?? null,
      difficulty: recipe.difficulty,
      prepTimeMin: recipe.prep_time_min,
      cookTimeMin: recipe.cook_time_min,
      totalTimeMin: recipe.total_time_min,
      servings: recipe.servings,
      source: modelUsed === 'local-engine' ? 'curated' : 'ai_generated',
      aiModelUsed: modelUsed,
      aiPromptHash: promptHash,
      totalCostEstimate: totalCost,
      isPublic: options.isPublic ?? false,
      tags: [...new Set(recipe.tags)].slice(0, 20),
      dietTags,
      allergenWarnings: recipe.allergen_warnings.slice(0, 10),
      storageInstructions: recipe.storage_instructions?.slice(0, 1000) ?? null,
      reheatingInstructions: recipe.reheating_instructions?.slice(0, 500) ?? null,
      searchBlob: buildSearchBlob(recipe),
      usesExpiringFriendly: (recipe.uses_expiring_items?.length ?? 0) > 0,
    })
    .returning();

  const created = row as Recipe;

  if (recipe.ingredients.length) {
    await db.insert(recipeIngredients).values(
      recipe.ingredients.map((ingredient, index) => ({
        recipeId: created.id,
        ingredientName: ingredient.name.slice(0, 100),
        normalizedKey: normalizeIngredient(ingredient.name),
        quantity: ingredient.quantity,
        unit: ingredient.unit?.slice(0, 20) ?? null,
        isOptional: ingredient.is_optional,
        substitutes: ingredient.substitutes.slice(0, 6),
        category: ingredient.category ?? null,
        unitPriceUsd: round2(estimatePriceUsd(ingredient.name, 1, ingredient.unit) / 100),
        sortOrder: index,
      })),
    );
  }

  if (recipe.steps.length) {
    await db.insert(recipeSteps).values(
      recipe.steps.map((step, index) => ({
        recipeId: created.id,
        stepNumber: step.step_number || index + 1,
        instruction: step.instruction,
        durationMin: step.duration_min ?? null,
        tip: step.tip ?? null,
      })),
    );
  }

  await db.insert(recipeNutrition).values({
    recipeId: created.id,
    calories: nutrition.calories,
    proteinG: nutrition.protein_g,
    carbsG: nutrition.carbs_g,
    fatG: nutrition.fat_g,
    fiberG: nutrition.fiber_g,
    sugarG: nutrition.sugar_g,
    sodiumMg: nutrition.sodium_mg,
    cholesterolMg: nutrition.cholesterol_mg,
    saturatedFatG: nutrition.saturated_fat_g,
    vitaminAPct: nutrition.vitamin_a_pct,
    vitaminCPct: nutrition.vitamin_c_pct,
    calciumPct: nutrition.calcium_pct,
    ironPct: nutrition.iron_pct,
    potassiumMg: nutrition.potassium_mg,
    source: nutrition.source,
    perServing: nutrition.per_serving,
  });

  const full = await loadRecipe(created.id);
  return recipeToDto(full, {
    allergen_warnings: recipe.allergen_warnings,
    storage_instructions: recipe.storage_instructions,
    reheating_instructions: recipe.reheating_instructions,
    uses_expiring_items: recipe.uses_expiring_items ?? [],
  });
}

function buildSearchBlob(recipe: AiRecipe): string {
  return [recipe.title, recipe.description, recipe.cuisine, recipe.tags.join(' '), recipe.ingredients.map((i) => i.name).join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .slice(0, 4000);
}

/** Derive dietary tags from the ingredient list. */
export function deriveDietTags(recipe: AiRecipe): string[] {
  const keys = recipe.ingredients.map((i) => normalizeIngredient(i.name)).join(' ');
  const tags: string[] = [];

  const hasAnimal = /chicken|beef|pork|lamb|mutton|goat|turkey|duck|bacon|ham|sausage|fish|salmon|tuna|shrimp|prawn|crab|lobster/.test(keys);
  const hasDairy = /milk|cheese|butter|cream|yogurt|yoghurt|ghee|paneer|mozzarella|parmesan|feta|cheddar/.test(keys);
  const hasEgg = /\begg/.test(keys);
  const hasHoney = /honey/.test(keys);
  const hasGluten = /wheat|flour|bread|pasta|barley|rye|naan|tortilla|soy sauce/.test(keys);
  const hasMeatOrFish = hasAnimal;

  if (!hasAnimal && !hasDairy && !hasEgg && !hasHoney) tags.push('vegan');
  if (!hasAnimal) tags.push('vegetarian');
  if (!hasGluten) tags.push('gluten-free');
  if (!hasDairy) tags.push('dairy-free');
  if (hasMeatOrFish && /fish|salmon|tuna|shrimp|prawn/.test(keys) && !/chicken|beef|pork|lamb/.test(keys)) tags.push('pescatarian');
  if (recipe.total_time_min <= 20) tags.push('quick');
  if (recipe.total_time_min <= 30 && recipe.ingredients.length <= 8) tags.push('easy-weeknight');
  if (recipe.estimated_nutrition_per_serving.protein_g >= 25) tags.push('high-protein');
  if (recipe.estimated_nutrition_per_serving.fiber_g >= 8) tags.push('high-fiber');
  if (recipe.estimated_nutrition_per_serving.carbs_g <= 20) tags.push('low-carb');

  return [...new Set(tags)];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Load a recipe with ingredients, steps and nutrition in one shot. */
export async function loadRecipe(recipeId: string): Promise<RecipeWithChildren> {
  const db = getDb();
  const [recipeRow, ingredientRows, stepRows, nutritionRows] = await Promise.all([
    db.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1),
    db.select().from(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId)).orderBy(recipeIngredients.sortOrder),
    db.select().from(recipeSteps).where(eq(recipeSteps.recipeId, recipeId)).orderBy(recipeSteps.stepNumber),
    db.select().from(recipeNutrition).where(eq(recipeNutrition.recipeId, recipeId)).limit(1),
  ]);

  const recipe = recipeRow[0] as Recipe | undefined;
  if (!recipe) throw new NotFoundError('Recipe not found');

  return {
    ...recipe,
    ingredients: ingredientRows as RecipeIngredientRow[],
    steps: stepRows,
    nutrition: nutritionRows[0] ?? null,
  };
}

/** Recipe detail, personalised for a user (favorites, pantry match, cooked). */
export async function getRecipeForUser(recipeId: string, userId?: string | null): Promise<RecipeDto> {
  const db = getDb();
  const full = await loadRecipe(recipeId);

  const extras: RecipeDtoExtras = {};

  if (userId) {
    const [favorite, cooked, pantry] = await Promise.all([
      db.select({ id: userFavorites.id }).from(userFavorites).where(and(eq(userFavorites.userId, userId), eq(userFavorites.recipeId, recipeId))).limit(1),
      db.select({ id: recipeCookLog.id }).from(recipeCookLog).where(and(eq(recipeCookLog.userId, userId), eq(recipeCookLog.recipeId, recipeId))).limit(1),
      getActivePantryCached(userId),
    ]);
    extras.is_favorite = Boolean(favorite);
    extras.is_cooked = cooked.length > 0;

    const dto = recipeToDto(full, extras);
    return annotateWithPantry(dto, pantry, expiringNames(pantry));
  }

  return recipeToDto(full, extras);
}

export interface SearchFilters extends Partial<SearchRecipesQuery> {
  userId?: string | null;
}

/**
 * Recipe search with pantry-aware ranking.
 *
 * `sort=best_match` / `fewest_missing` require the pantry, so those two paths
 * fetch the user's pantry and rank in memory after the DB filters. The others
 * are pure SQL sorts and scale to a large catalogue.
 */
export async function searchRecipes(filters: SearchFilters): Promise<PaginatedRecipes> {
  const db = getDb();
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(50, Math.max(1, filters.limit ?? 20));

  const conditions = [
    or(eq(recipes.isPublic, true), filters.userId ? eq(recipes.ownerId, filters.userId) : sql`false`),
  ];

  if (filters.q) conditions.push(ilike(recipes.searchBlob, `%${filters.q.toLowerCase()}%`));
  if (filters.cuisine && filters.cuisine.toLowerCase() !== 'any') conditions.push(ilike(recipes.cuisine, `%${filters.cuisine}%`));
  if (filters.maxTime) conditions.push(sql`${recipes.totalTimeMin} <= ${filters.maxTime}`);
  if (filters.difficulty) conditions.push(eq(recipes.difficulty, filters.difficulty));
  if (filters.meal_type) conditions.push(eq(recipes.mealType, filters.meal_type));
  if (filters.diet && filters.diet !== 'none') {
    conditions.push(sql`${filters.diet.toLowerCase()} = ANY(${recipes.dietTags})`);
  }

  const where = and(...conditions);

  const needsPantryRanking = filters.sort === 'best_match' || filters.sort === 'fewest_missing' || filters.use_pantry === true;
  const order = sqlOrderFor(filters.sort);

  const [rows, countRows] = await Promise.all([
    db.select().from(recipes).where(where).orderBy(order).limit(needsPantryRanking ? 200 : limit).offset(needsPantryRanking ? 0 : (page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(recipes).where(where),
  ]);

  const total = Number(countRows[0]?.count ?? 0);
  const pantry = filters.userId ? await getActivePantryCached(filters.userId) : [];

  let dtos: RecipeDto[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const full = await loadRecipe((row as Recipe).id);
    dtos.push(recipeToDto(full));
  }

  if (filters.userId && pantry.length) {
    const expiring = expiringNames(pantry);
    dtos = dtos.map((dto) => annotateWithPantry(dto, pantry, expiring));
  }

  if (filters.userId) {
    const favoriteRows = await db
      .select({ recipeId: userFavorites.recipeId })
      .from(userFavorites)
      .where(and(eq(userFavorites.userId, filters.userId), inArray(userFavorites.recipeId, dtos.map((d) => d.id))));
    const favoriteIds = new Set(favoriteRows.map((f) => f.recipeId));
    dtos = dtos.map((dto) => ({ ...dto, is_favorite: favoriteIds.has(dto.id) }));
  }

  if (needsPantryRanking) {
    dtos = rankByPantry(dtos, filters.sort === 'fewest_missing' ? 'fewest_missing' : 'best_match');
    const sliced = dtos.slice((page - 1) * limit, page * limit);
    return {
      data: sliced,
      page,
      limit,
      total: filters.userId ? dtos.length : total,
      has_more: page * limit < (filters.userId ? dtos.length : total),
      next_cursor: null,
    };
  }

  return {
    data: dtos,
    page,
    limit,
    total,
    has_more: page * limit < total,
    next_cursor: null,
  };
}

function sqlOrderFor(sort?: SearchRecipesQuery['sort']) {
  switch (sort) {
    case 'quickest':
      return sql`${recipes.totalTimeMin} ASC NULLS LAST`;
    case 'highest_rated':
      return sql`${recipes.ratingAvg} DESC, ${recipes.ratingCount} DESC`;
    case 'newest':
      return sql`${recipes.createdAt} DESC`;
    case 'fewest_missing':
    case 'best_match':
    default:
      return sql`${recipes.isFeatured} DESC, ${recipes.ratingAvg} DESC, ${recipes.createdAt} DESC`;
  }
}

function rankByPantry(dtos: RecipeDto[], sort: 'best_match' | 'fewest_missing'): RecipeDto[] {
  return [...dtos].sort((a, b) => {
    const aRatio = a.pantry_match?.ratio ?? 0;
    const bRatio = b.pantry_match?.ratio ?? 0;
    if (sort === 'fewest_missing') {
      const aMissing = a.pantry_match?.missing.length ?? 99;
      const bMissing = b.pantry_match?.missing.length ?? 99;
      if (aMissing !== bMissing) return aMissing - bMissing;
    }
    if (bRatio !== aRatio) return bRatio - aRatio;
    return (b.rating_avg ?? 0) - (a.rating_avg ?? 0);
  });
}

/** Annotate a recipe DTO with per-ingredient pantry availability. */
export function annotateWithPantry(dto: RecipeDto, pantry: PantryItem[], expiring: string[] = []): RecipeDto {
  const matches = new Map<string, { pantryId: string; quantity: number | null; inPantry: boolean }>();

  for (const ingredient of dto.ingredients) {
    const key = ingredient.ingredient_name.toLowerCase();
    let best: { item: PantryItem; score: number } | null = null;

    for (const item of pantry) {
      if (item.isUsed) continue;
      const score = similarity(ingredient.ingredient_name, item.ingredientName);
      if (score >= 0.72 && (!best || score > best.score)) best = { item, score };
    }

    matches.set(key, best ? { pantryId: best.item.id, quantity: best.item.quantity, inPantry: true } : { pantryId: '', quantity: null, inPantry: false });
  }

  return applyPantryMatch(dto, matches, expiring);
}

function expiringNames(pantry: PantryItem[]): string[] {
  return pantry
    .filter((item) => {
      const days = daysUntilExpiry(item.expiryDate);
      return days !== null && days >= 0 && days <= 3;
    })
    .map((item) => normalizeIngredient(item.ingredientName));
}

function toPromptPantry(items: PantryItem[]): PromptPantryItem[] {
  return items
    .filter((i) => !i.isUsed)
    .map((item) => ({
      name: item.ingredientName,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category,
      expiryDate: item.expiryDate ?? null,
      daysUntilExpiry: daysUntilExpiry(item.expiryDate),
      location: item.location,
    }));
}

/**
 * Generations are tracked in the append-only `ai_usage_logs` ledger, so the
 * quota check is a single indexed count for today's successful recipe calls.
 */
async function countGenerationsToday(userId: string): Promise<number> {
  const db = getDb();
  const today = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiUsageLogs)
    .where(
      and(
        eq(aiUsageLogs.userId, userId),
        eq(aiUsageLogs.task, 'recipe'),
        eq(aiUsageLogs.success, true),
        sql`${aiUsageLogs.createdAt} >= date_trunc('day', now())`,
      ),
    );
  return Number(today[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Trending / history / favorites
// ---------------------------------------------------------------------------

export async function getTrendingRecipes(limit = 12): Promise<RecipeDto[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(recipes)
    .where(eq(recipes.isPublic, true))
    .orderBy(sql`${recipes.ratingAvg} DESC, ${recipes.timesCooked} DESC, ${recipes.isFeatured} DESC`)
    .limit(Math.min(50, limit));

  const out: RecipeDto[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    out.push(recipeToDto(await loadRecipe((row as Recipe).id)));
  }
  return out;
}

export async function getCookHistory(userId: string, page = 1, limit = 20): Promise<{ data: RecipeDto[]; total: number }> {
  const db = getDb();
  const safeLimit = Math.min(50, Math.max(1, limit));

  const rows = await db
    .select({
      recipeId: recipeCookLog.recipeId,
      cookedAt: recipeCookLog.cookedAt,
      rating: recipeCookLog.rating,
    })
    .from(recipeCookLog)
    .where(eq(recipeCookLog.userId, userId))
    .orderBy(desc(recipeCookLog.cookedAt))
    .limit(safeLimit)
    .offset((Math.max(1, page) - 1) * safeLimit);

  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(recipeCookLog).where(eq(recipeCookLog.userId, userId));

  const out: RecipeDto[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const dto = await getRecipeForUser(row.recipeId, userId);
    out.push({ ...dto, is_cooked: true });
  }

  return { data: out, total: Number(countRows[0]?.count ?? 0) };
}

export async function getFavoriteRecipes(userId: string, page = 1, limit = 20): Promise<{ data: RecipeDto[]; total: number }> {
  const db = getDb();
  const safeLimit = Math.min(50, Math.max(1, limit));

  const rows = await db
    .select({ recipeId: userFavorites.recipeId })
    .from(userFavorites)
    .where(eq(userFavorites.userId, userId))
    .orderBy(desc(userFavorites.createdAt))
    .limit(safeLimit)
    .offset((Math.max(1, page) - 1) * safeLimit);

  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(userFavorites).where(eq(userFavorites.userId, userId));
  const pantry = await getActivePantryCached(userId);
  const expiring = expiringNames(pantry);

  const out: RecipeDto[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const full = await loadRecipe(row.recipeId);
    out.push(annotateWithPantry(recipeToDto(full, { is_favorite: true }), pantry, expiring));
  }

  return { data: out, total: Number(countRows[0]?.count ?? 0) };
}

export async function toggleFavorite(userId: string, recipeId: string, favorite: boolean): Promise<{ is_favorite: boolean }> {
  const db = getDb();
  await loadRecipe(recipeId); // throws NotFoundError for an unknown recipe

  if (favorite) {
    await db
      .insert(userFavorites)
      .values({ userId, recipeId })
      .onConflictDoNothing({ target: [userFavorites.userId, userFavorites.recipeId] });
  } else {
    await db.delete(userFavorites).where(and(eq(userFavorites.userId, userId), eq(userFavorites.recipeId, recipeId)));
  }
  await cache.del(CacheKeys.recipeDetail(recipeId));
  return { is_favorite: favorite };
}

// ---------------------------------------------------------------------------
// Ratings & cooking
// ---------------------------------------------------------------------------

export async function rateRecipe(userId: string, recipeId: string, input: RateRecipeInput): Promise<{ rating_avg: number; rating_count: number }> {
  const db = getDb();
  await loadRecipe(recipeId);

  await db
    .insert(recipeRatings)
    .values({
      recipeId,
      userId,
      rating: input.rating,
      reviewText: input.review_text ?? null,
      photoUrl: input.photo_url ?? null,
    })
    .onConflictDoUpdate({
      target: [recipeRatings.recipeId, recipeRatings.userId],
      set: { rating: input.rating, reviewText: input.review_text ?? null, photoUrl: input.photo_url ?? null, createdAt: new Date() },
    });

  const [summary] = await db
    .select({ avg: sql<number>`round(avg(${recipeRatings.rating})::numeric, 1)`, count: sql<number>`count(*)::int` })
    .from(recipeRatings)
    .where(eq(recipeRatings.recipeId, recipeId));

  const avg = Number(summary?.avg ?? 0);
  const count = Number(summary?.count ?? 0);

  await db.update(recipes).set({ ratingAvg: avg, ratingCount: count, updatedAt: new Date() }).where(eq(recipes.id, recipeId));
  await cache.del(CacheKeys.recipeDetail(recipeId));

  void checkAndAward(userId).catch(() => undefined);

  return { rating_avg: avg, rating_count: count };
}

export async function getRecipeRatings(recipeId: string, limit = 20) {
  const db = getDb();
  const rows = await db
    .select({
      id: recipeRatings.id,
      rating: recipeRatings.rating,
      review_text: recipeRatings.reviewText,
      photo_url: recipeRatings.photoUrl,
      created_at: recipeRatings.createdAt,
      user_name: users.fullName,
      user_avatar: users.avatarUrl,
    })
    .from(recipeRatings)
    .innerJoin(users, eq(users.id, recipeRatings.userId))
    .where(eq(recipeRatings.recipeId, recipeId))
    .orderBy(desc(recipeRatings.createdAt))
    .limit(Math.min(50, limit));

  return rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    review_text: r.review_text,
    photo_url: r.photo_url,
    created_at: r.created_at.toISOString(),
    user: { name: r.user_name, avatar_url: r.user_avatar },
  }));
}

/**
 * "Start Cooking" → completed.
 *
 * Consumes the matched pantry ingredients (proportionally, or fully when no
 * quantity is recorded), bumps the recipe's cooked counter, logs the session
 * and triggers the achievement check.
 */
export async function markRecipeCooked(
  userId: string,
  recipeId: string,
  input: CookRecipeInput,
  source = 'recipe_detail',
  mealPlanEntryId?: string | null,
): Promise<{ consumed: number; recipe: RecipeDto }> {
  const db = getDb();
  const full = await loadRecipe(recipeId);
  const servingsCooked = input.servings ?? full.servings;
  const skip = new Set(input.skip_ingredients.map((s) => normalizeIngredient(s)));

  const pantry = await getActivePantryCached(userId);
  const scale = servingsCooked / Math.max(1, full.servings);

  const toConsume: Array<{ id: string; remaining: number | null }> = [];

  if (input.consume_pantry === false) return { consumed: 0, recipe: annotateWithPantry(recipeToDto(full, { is_cooked: true }), pantry) };

  for (const ingredient of full.ingredients ?? []) {
    if (skip.has(normalizeIngredient(ingredient.ingredientName))) continue;

    const match = pantry.find((p) => !p.isUsed && similarity(p.ingredientName, ingredient.ingredientName) >= 0.72);
    if (!match) continue;

    const needed = ingredient.quantity != null ? ingredient.quantity * scale : null;
    const have = match.quantity;

    if (needed == null || have == null) {
      toConsume.push({ id: match.id, remaining: null });
    } else if (have <= needed * 1.05) {
      toConsume.push({ id: match.id, remaining: null });
    } else {
      toConsume.push({ id: match.id, remaining: round2(have - needed) });
    }
  }

  for (const entry of toConsume) {
    if (entry.remaining === null) {
      // eslint-disable-next-line no-await-in-loop
      await db.update(pantryItems).set({ isUsed: true, usedAt: new Date(), updatedAt: new Date() }).where(eq(pantryItems.id, entry.id));
    } else {
      // eslint-disable-next-line no-await-in-loop
      await db.update(pantryItems).set({ quantity: entry.remaining, updatedAt: new Date() }).where(eq(pantryItems.id, entry.id));
    }
  }

  await db.transaction(async (tx) => {
    await tx.update(recipes).set({ timesCooked: sql`${recipes.timesCooked} + 1`, updatedAt: new Date() }).where(eq(recipes.id, recipeId));
    await tx.insert(recipeCookLog).values({
      userId,
      recipeId,
      servingsCooked,
      notes: input.notes ?? null,
      source,
      mealPlanEntryId: mealPlanEntryId ?? null,
    });
  });

  await invalidatePantryCache(userId);
  await cache.del(CacheKeys.recipeDetail(recipeId));
  // Cooking is a savings event: the Stats screen must not keep the old total.
  await invalidateDashboardCaches(userId);
  void checkAndAward(userId).catch(() => undefined);

  const dto = annotateWithPantry(recipeToDto(full, { is_cooked: true }), await getActivePantryCached(userId));
  return { consumed: toConsume.length, recipe: dto };
}

/** Quick "cook now" from the Expiring Soon carousel — same as above. */
export async function cookNowFromExpiring(userId: string, pantryItemId: string): Promise<{ recipe: RecipeDto | null }> {
  const db = getDb();
  const [item] = await db.select().from(pantryItems).where(and(eq(pantryItems.id, pantryItemId), eq(pantryItems.userId, userId))).limit(1);
  if (!item) throw new NotFoundError('Pantry item not found');

  const results = await searchRecipes({ userId, q: normalizeIngredient(item.ingredientName), limit: 1, sort: 'best_match' });
  return { recipe: results.data[0] ?? null };
}

