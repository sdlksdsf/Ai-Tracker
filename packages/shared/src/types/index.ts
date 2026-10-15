import type { z } from 'zod';
import type {
  DetectedItem,
  ScanDto,
  ScanStatusDto,
} from '../schemas/pantry.js';
import type { MealPlanDto } from '../schemas/mealplan.js';
import type { RecipeDto } from '../schemas/recipe.js';
import type { WasteStats } from '../schemas/waste.js';
import type { GroceryListDto } from '../schemas/grocery.js';
import type { UserDto } from '../schemas/auth.js';
import type { SubscriptionStatus } from '../schemas/subscription.js';
import type { LogWasteInput } from '../schemas/waste.js';
import type { GenerateMealPlanInput } from '../schemas/mealplan.js';
import type { PantryItemDto } from './dashboard.js';

/**
 * Re-exported inferred types. Schemas stay the single source of truth; these
 * aliases exist so call sites read naturally (`PantryItem` instead of
 * `z.infer<typeof pantryItemDtoSchema>`).
 */
export type { UserDto, RecipeDto, MealPlanDto, GroceryListDto, ScanDto, ScanStatusDto, DetectedItem, WasteStats };

// ---------------------------------------------------------------------------
// API client surface (used by apps/mobile/services/api.ts)
// ---------------------------------------------------------------------------

export interface ApiEnvelope<T> {
  data: T;
}

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    has_more: boolean;
    next_cursor?: string | null;
  };
}

export interface HomeDashboardDto {
  greeting: string;
  user: Pick<UserDto, 'id' | 'full_name' | 'avatar_url' | 'subscription_tier' | 'daily_calorie_target'>;
  expiring_soon: Array<{
    id: string;
    ingredient_name: string;
    category: string;
    expiry_date: string | null;
    days_until_expiry: number;
    urgency: 'critical' | 'warning' | 'ok';
    location: string;
    photo_url: string | null;
    suggested_recipe: Pick<RecipeDto, 'id' | 'title' | 'total_time_min' | 'image_url'> | null;
  }>;
  todays_plan: Array<{
    entry_id: string;
    meal_type: string;
    recipe: Pick<RecipeDto, 'id' | 'title' | 'total_time_min' | 'image_url' | 'difficulty'> | null;
    is_completed: boolean;
  }>;
  quick_picks: RecipeDto[];
  waste_this_week: {
    cost: number;
    co2_kg: number;
    items: number;
    trend: WasteStats['trend'];
    change_pct: number;
  };
  pantry_summary: {
    total_items: number;
    expiring_in_3_days: number;
    expired: number;
    by_location: Record<string, number>;
  };
  unread_notifications: number;
  streak_days: number;
  subscription: SubscriptionStatus;
  last_scan: ScanDto | null;
  active_meal_plan: Pick<MealPlanDto, 'id' | 'week_start_date' | 'week_end_date'> | null;
  active_grocery_list: Pick<GroceryListDto, 'id' | 'title' | 'total_estimated_cost' | 'purchased_count' | 'total_count'> | null;
}

export interface PantryStatsDto {
  total_items: number;
  by_category: Array<{ category: string; count: number }>;
  by_location: Array<{ location: string; count: number }>;
  expiring_soon: number;
  expired: number;
  fresh: number;
  total_estimated_value: number;
  items_added_this_week: number;
  items_used_this_week: number;
  oldest_item: { id: string; ingredient_name: string; days: number } | null;
}

export interface RecipeGenerationResult {
  recipes: RecipeDto[];
  ai_model_used: string;
  generation_time_ms: number;
  cached: boolean;
  /** Populated when the allergen guard rejected and re-asked the model. */
  safety_notes: string[];
}

export interface MealPlanGenerationResult {
  meal_plan: MealPlanDto;
  ai_model_used: string;
  generation_time_ms: number;
  nutrition_verification: {
    days_checked: number;
    days_within_tolerance: number;
    tolerance_pct: number;
    warnings: string[];
  };
}

export interface ScanPipelineResult {
  scan: ScanDto;
  models_tried: Array<{ model: string; ok: boolean; reason?: string; cost_usd: number; latency_ms: number }>;
  total_cost_usd: number;
}

/** Zod helpers --------------------------------------------------------------*/
export type Infer<T extends z.ZodTypeAny> = z.infer<T>;

// ---------------------------------------------------------------------------
// Aggregate read models (Home, Stats, Week view, Price comparison)
// ---------------------------------------------------------------------------
export * from './dashboard.js';

/**
 * Input aliases.
 *
 * The Zod schemas are named after the endpoint that validates them
 * (`logWasteSchema` → `LogWasteInput`). Services read more naturally against a
 * `Create*Input` name, so both spellings are exported.
 */
export type CreateWasteLogInput = LogWasteInput & {
  /** Accepted alongside `item_name` by the API for readability. */
  ingredient_name?: string;
};
export type CreateMealPlanInput = GenerateMealPlanInput;
export type ExpiringSoonDto = PantryItemDto;
export { type SubscriptionStatus };
