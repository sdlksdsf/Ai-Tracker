import type {
  DetectedItem,
  PantryItemDto,
  GroceryListDto,
  GroceryListItemDto,
  MealPlanDto,
  MealPlanEntryDto,
  RecipeDto,
  ScanDto,
  ScanStatusDto,
  StorePrice,
  UserDto,
  WasteDto,
} from '@platematch/shared';
import type {
  FridgeScan,
  FoodWasteLog,
  GroceryList,
  GroceryListItem,
  MealPlan,
  MealPlanEntry,
  PantryItem,
  Recipe,
  RecipeIngredient,
  RecipeNutrition,
  RecipeStep,
  User,
  UserAllergy,
} from '../db/schema.js';

/**
 * Row → DTO mappers.
 *
 * Drizzle returns Postgres `date` columns as `YYYY-MM-DD` strings and
 * `timestamp` columns as `Date`. Every DTO in `@platematch/shared` uses ISO
 * strings, so this module is the single place where that conversion happens —
 * controllers never format dates inline.
 */

export function isoDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.length >= 10 ? value.slice(0, 10) : value;
  return value.toISOString().slice(0, 10);
}

export function isoDateTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.toISOString();
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function numOr(value: unknown, fallback: number): number {
  return num(value) ?? fallback;
}

export function boolOr(value: unknown, fallback = false): boolean {
  return value === null || value === undefined ? fallback : Boolean(value);
}

export function strArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export interface UserWithAllergies extends User {
  allergies?: UserAllergy[];
}

export function userToDto(user: UserWithAllergies, allergies: UserAllergy[] = user.allergies ?? []): UserDto {
  return {
    id: user.id,
    email: user.email,
    full_name: user.fullName,
    avatar_url: user.avatarUrl ?? null,
    date_of_birth: isoDate(user.dateOfBirth),
    gender: user.gender ?? null,
    height_cm: num(user.heightCm),
    weight_kg: num(user.weightKg),
    health_goal: user.healthGoal,
    activity_level: user.activityLevel,
    dietary_preference: user.dietaryPreference,
    family_size: user.familySize,
    weekly_budget: num(user.weeklyBudget),
    currency: user.currency,
    daily_calorie_target: user.dailyCalorieTarget ?? null,
    daily_protein_target_g: user.dailyProteinTargetG ?? null,
    daily_carbs_target_g: user.dailyCarbsTargetG ?? null,
    daily_fat_target_g: user.dailyFatTargetG ?? null,
    cooking_skill_level: user.cookingSkillLevel,
    preferred_cuisines: strArray(user.preferredCuisines),
    max_cooking_time_min: user.maxCookingTimeMin ?? null,
    onboarding_completed: user.onboardingCompleted,
    subscription_tier: user.subscriptionTier,
    subscription_expires_at: isoDateTime(user.subscriptionExpiresAt),
    timezone: user.timezone,
    locale: user.locale,
    created_at: user.createdAt.toISOString(),
    allergies: allergies.map((a) => ({
      id: a.id,
      allergen: a.allergen,
      severity: a.severity,
      created_at: a.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Pantry
// ---------------------------------------------------------------------------

/** Re-exported so services and routes share one definition. */
export type { PantryItemDto };

export function pantryItemToDto(item: PantryItem, extra: { daysUntilExpiry: number | null; urgency: string; expiryLabel: string }): PantryItemDto {
  return {
    id: item.id,
    ingredient_name: item.ingredientName,
    category: item.category,
    quantity: num(item.quantity),
    unit: item.unit ?? null,
    expiry_date: isoDate(item.expiryDate),
    purchase_date: isoDate(item.purchaseDate),
    added_via: item.addedVia,
    ai_confidence: num(item.aiConfidence),
    photo_url: item.photoUrl ?? null,
    barcode: item.barcode ?? null,
    freshness: item.freshness,
    is_expired: item.isExpired,
    is_used: item.isUsed,
    location: item.location,
    scan_id: item.scanId ?? null,
    days_until_expiry: extra.daysUntilExpiry,
    urgency: extra.urgency as PantryItemDto['urgency'],
    expiry_label: extra.expiryLabel,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function scanToStatusDto(scan: FridgeScan): ScanStatusDto {
  return {
    scan_id: scan.id,
    status: scan.status,
    progress: scan.progress,
    estimated_time_s: scan.status === 'completed' || scan.status === 'failed' ? 0 : 5,
    detected_items: parseJsonArray<DetectedItem>(scan.detectedItems),
    overall_fridge_status: scan.overallFridgeStatus ?? null,
    suggestions: parseJsonArray<string>(scan.suggestions),
    error: scan.errorMessage ?? null,
    ai_model_used: scan.aiModelUsed ?? null,
    processing_time_ms: scan.processingTimeMs ?? null,
  };
}

export function scanToDto(scan: FridgeScan): ScanDto {
  return {
    ...scanToStatusDto(scan),
    photo_url: scan.photoUrl ?? null,
    created_at: scan.createdAt.toISOString(),
    items_confirmed_count: scan.itemsConfirmedCount,
    items_corrected_count: scan.itemsCorrectedCount,
    items_removed_count: scan.itemsRemovedCount,
    items_added_count: scan.itemsAddedCount,
  };
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface RecipeWithChildren extends Recipe {
  ingredients?: RecipeIngredient[];
  steps?: RecipeStep[];
  nutrition?: RecipeNutrition | null;
}

export interface RecipeDtoExtras {
  is_favorite?: boolean;
  is_cooked?: boolean;
  pantry_match?: RecipeDto['pantry_match'];
  uses_expiring_items?: string[];
  allergen_warnings?: string[];
  storage_instructions?: string | null;
  reheating_instructions?: string | null;
}

export function recipeToDto(recipe: RecipeWithChildren, extras: RecipeDtoExtras = {}): RecipeDto {
  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description ?? null,
    cuisine: recipe.cuisine ?? null,
    difficulty: recipe.difficulty,
    prep_time_min: recipe.prepTimeMin ?? null,
    cook_time_min: recipe.cookTimeMin ?? null,
    total_time_min: recipe.totalTimeMin ?? null,
    servings: recipe.servings,
    image_url: recipe.imageUrl ?? null,
    video_url: recipe.videoUrl ?? null,
    source: recipe.source,
    total_cost_estimate: num(recipe.totalCostEstimate),
    rating_avg: numOr(recipe.ratingAvg, 0),
    rating_count: recipe.ratingCount,
    times_cooked: recipe.timesCooked,
    is_featured: recipe.isFeatured,
    tags: strArray(recipe.tags),
    created_at: recipe.createdAt.toISOString(),
    ingredients: (recipe.ingredients ?? []).map((i) => ({
      id: i.id,
      ingredient_name: i.ingredientName,
      quantity: num(i.quantity),
      unit: i.unit ?? null,
      is_optional: i.isOptional,
      substitutes: strArray(i.substitutes),
      category: i.category ?? null,
      is_in_pantry: false,
      pantry_item_id: null,
      pantry_quantity: null,
    })),
    steps: (recipe.steps ?? [])
      .slice()
      .sort((a, b) => a.stepNumber - b.stepNumber)
      .map((s) => ({
        id: s.id,
        step_number: s.stepNumber,
        instruction: s.instruction,
        duration_min: s.durationMin ?? null,
        tip: s.tip ?? null,
        image_url: s.imageUrl ?? null,
      })),
    nutrition: recipe.nutrition
      ? {
          calories: num(recipe.nutrition.calories),
          protein_g: num(recipe.nutrition.proteinG),
          carbs_g: num(recipe.nutrition.carbsG),
          fat_g: num(recipe.nutrition.fatG),
          fiber_g: num(recipe.nutrition.fiberG),
          sugar_g: num(recipe.nutrition.sugarG),
          sodium_mg: num(recipe.nutrition.sodiumMg),
          cholesterol_mg: num(recipe.nutrition.cholesterolMg),
          saturated_fat_g: num(recipe.nutrition.saturatedFatG),
          vitamin_a_pct: num(recipe.nutrition.vitaminAPct),
          vitamin_c_pct: num(recipe.nutrition.vitaminCPct),
          calcium_pct: num(recipe.nutrition.calciumPct),
          iron_pct: num(recipe.nutrition.ironPct),
          potassium_mg: num(recipe.nutrition.potassiumMg),
          per_serving: recipe.nutrition.perServing,
        }
      : null,
    allergen_warnings: extras.allergen_warnings ?? strArray(recipe.allergenWarnings),
    storage_instructions: extras.storage_instructions ?? recipe.storageInstructions ?? null,
    reheating_instructions: extras.reheating_instructions ?? recipe.reheatingInstructions ?? null,
    pantry_match: extras.pantry_match ?? null,
    is_favorite: extras.is_favorite ?? false,
    is_cooked: extras.is_cooked ?? false,
    uses_expiring_items: extras.uses_expiring_items ?? [],
  };
}

/** Apply per-user pantry availability to a recipe DTO's ingredients. */
export function applyPantryMatch(
  dto: RecipeDto,
  matches: Map<string, { pantryId: string; quantity: number | null; inPantry: boolean }>,
  expiringNames: string[] = [],
): RecipeDto {
  let inPantry = 0;
  const missing: string[] = [];

  const ingredients = dto.ingredients.map((ingredient) => {
    const match = matches.get(ingredient.ingredient_name.toLowerCase());
    const has = match?.inPantry ?? false;
    if (has) inPantry += 1;
    else missing.push(ingredient.ingredient_name);
    return {
      ...ingredient,
      is_in_pantry: has,
      pantry_item_id: match?.pantryId ?? null,
      pantry_quantity: match?.quantity ?? null,
    };
  });

  const total = ingredients.length || 1;
  const ratio = Math.round((inPantry / total) * 100) / 100;

  return {
    ...dto,
    ingredients,
    pantry_match: { ratio, in_pantry: inPantry, total: ingredients.length, missing },
    uses_expiring_items: expiringNames.filter((name) =>
      ingredients.some((i) => i.is_in_pantry && i.ingredient_name.toLowerCase().includes(name.toLowerCase())),
    ),
  };
}

// ---------------------------------------------------------------------------
// Meal plans
// ---------------------------------------------------------------------------

export function mealPlanEntryToDto(entry: MealPlanEntry, recipe?: RecipeDto | null): MealPlanEntryDto {
  return {
    id: entry.id,
    meal_plan_id: entry.mealPlanId,
    recipe_id: entry.recipeId ?? null,
    day_of_week: entry.dayOfWeek,
    meal_type: entry.mealType,
    is_completed: entry.isCompleted,
    completed_at: isoDateTime(entry.completedAt),
    user_notes: entry.userNotes ?? null,
    calories: num(entry.calories),
    recipe: recipe ?? null,
  };
}

export function mealPlanToDto(
  plan: MealPlan,
  entries: MealPlanEntryDto[],
  extra: Partial<Pick<MealPlanDto, 'daily_nutrition' | 'weekly_totals' | 'waste_reduction_tips' | 'meal_prep_suggestions' | 'pantry_items_used' | 'grocery_preview' | 'grocery_list_id'>> = {},
): MealPlanDto {
  return {
    id: plan.id,
    user_id: plan.userId,
    week_start_date: isoDate(plan.weekStartDate) ?? '',
    week_end_date: isoDate(plan.weekEndDate) ?? '',
    total_calories: num(plan.totalCalories),
    total_cost_estimate: num(plan.totalCostEstimate),
    ai_model_used: plan.aiModelUsed ?? null,
    status: plan.status,
    created_at: plan.createdAt.toISOString(),
    entries,
    daily_nutrition: extra.daily_nutrition ?? {},
    weekly_totals: extra.weekly_totals ?? null,
    waste_reduction_tips: extra.waste_reduction_tips ?? [],
    meal_prep_suggestions: extra.meal_prep_suggestions ?? [],
    pantry_items_used: extra.pantry_items_used ?? [],
    grocery_preview: extra.grocery_preview ?? null,
    grocery_list_id: extra.grocery_list_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Grocery lists
// ---------------------------------------------------------------------------

export function groceryItemToDto(item: GroceryListItem): GroceryListItemDto {
  const storePrices = parseJsonArray<StorePrice>(item.storePrices);
  return {
    id: item.id,
    grocery_list_id: item.groceryListId,
    ingredient_name: item.ingredientName,
    quantity: num(item.quantity),
    unit: item.unit ?? null,
    category: item.category ?? null,
    estimated_price: num(item.estimatedCost) ?? num(item.estimatedPrice),
    cheapest_store: item.cheapestStore ?? null,
    actual_price: num(item.actualPrice),
    is_purchased: item.isChecked,
    needed_for_recipes: strArray(item.neededForRecipes),
    store_prices: storePrices,
    in_pantry: item.inPantry,
  };
}

export function groceryListToDto(
  list: GroceryList,
  items: GroceryListItemDto[],
  savings?: GroceryListDto['savings'],
): GroceryListDto {
  const totalEstimated = items.reduce((sum, i) => sum + (i.estimated_price ?? 0), 0);
  const totalActual = items.reduce((sum, i) => sum + (i.actual_price ?? 0), 0);

  return {
    id: list.id,
    user_id: list.userId,
    meal_plan_id: list.mealPlanId ?? null,
    title: list.title ?? null,
    total_estimated_cost: num(list.totalEstimatedCost) ?? Math.round(totalEstimated * 100) / 100,
    total_actual_cost: num(list.totalActualCost) ?? (totalActual > 0 ? Math.round(totalActual * 100) / 100 : null),
    status: list.status,
    created_at: list.createdAt.toISOString(),
    items,
    savings: savings ?? null,
    purchased_count: items.filter((i) => i.is_purchased).length,
    total_count: items.length,
  };
}

// ---------------------------------------------------------------------------
// Waste
// ---------------------------------------------------------------------------

export function wasteToDto(log: FoodWasteLog & { notes?: string | null }): WasteDto {
  return {
    id: log.id,
    item_name: log.ingredientName,
    quantity: num(log.quantity),
    unit: log.unit ?? null,
    reason: log.reason,
    category: log.category ?? null,
    estimated_cost: num(log.estimatedCostUsd),
    co2_equivalent_kg: num(log.co2EquivalentKg),
    photo_url: log.photoUrl ?? null,
    notes: log.notes ?? null,
    logged_at: log.loggedAt.toISOString(),
  };
}
