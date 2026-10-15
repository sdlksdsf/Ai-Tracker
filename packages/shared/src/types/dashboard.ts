import type { RecipeDto } from '../schemas/recipe.js';
import type { MealPlanEntryDto } from '../schemas/mealplan.js';
import type { GroceryListItemDto } from '../schemas/grocery.js';
import type { WasteDto, WasteTrendPoint } from '../schemas/waste.js';
import type { SubscriptionStatus } from '../schemas/subscription.js';
import type { ScanSource, SubscriptionTier } from '../constants/index.js';

/**
 * Dashboard, stats and cross-screen aggregate DTOs.
 *
 * These are the read models for the Home screen (Section 6, Screen 5), the
 * Savings/Stats screen (Screen 12) and the weekly report push (Section 7,
 * trigger 3). They are hand-written interfaces rather than Zod schemas because
 * they are server → client only and never need to be validated on the way in.
 */

// ---------------------------------------------------------------------------
// Pantry (mirrors the API's pantry DTO)
// ---------------------------------------------------------------------------

export interface PantryItemDto {
  id: string;
  ingredient_name: string;
  category: string;
  quantity: number | null;
  unit: string | null;
  expiry_date: string | null;
  purchase_date: string | null;
  // A real enum column (`added_via_scan_source`), and the create payload
  // requires the enum — a loose string here could not be fed back into it.
  added_via: ScanSource;
  ai_confidence: number | null;
  photo_url: string | null;
  barcode: string | null;
  freshness: string;
  is_expired: boolean;
  is_used: boolean;
  location: string;
  scan_id: string | null;
  days_until_expiry: number | null;
  urgency: 'expired' | 'critical' | 'warning' | 'soon' | 'ok' | 'none';
  expiry_label: string;
  created_at: string;
  updated_at: string;
}

/** Compact pantry row used by the Home "Expiring Soon" carousel. */
export interface ExpiringSoonItemDto {
  id: string;
  ingredient_name: string;
  category: string;
  quantity: number | null;
  unit: string | null;
  expiry_date: string | null;
  days_until_expiry: number;
  urgency: PantryItemDto['urgency'];
  expiry_label: string;
  location: string;
  photo_url: string | null;
  suggested_recipe_id: string | null;
  suggested_recipe_title: string | null;
}

// ---------------------------------------------------------------------------
// Grocery item alias + price comparison
// ---------------------------------------------------------------------------

export type GroceryItemDto = GroceryListItemDto;

export interface StorePriceDto {
  store: string;
  price: number;
  currency: string;
  in_stock: boolean;
  url: string | null;
  fetched_at: string;
}

/** Output of POST /grocery-lists/:id/prices. */
export interface PriceComparisonDto {
  grocery_list_id: string;
  meal_plan_id: string | null;
  checked_at: string;
  /** Everything bought at the single most expensive store. */
  single_store_total: number;
  /** Each item routed to its own cheapest store. */
  optimized_total: number;
  saved: number;
  percent: number;
  /** Store that wins most often across the list. */
  best_store: string | null;
  per_store: Array<{ store: string; total: number; items: number }>;
  /** Items where routing actually saves money. */
  deals: Array<{
    item_id: string;
    ingredient_name: string;
    cheapest_store: string;
    cheapest_price: number;
    most_expensive_store: string;
    most_expensive_price: number;
    save: number;
  }>;
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

export interface TodaysMealDto {
  entry_id: string;
  plan_id: string;
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  recipe_id: string | null;
  title: string;
  total_time_min: number | null;
  image_url: string | null;
  difficulty: string | null;
  servings: number;
  completed: boolean;
}

export interface HomeSummaryDto {
  greeting: string;
  date: string;
  timezone: string;
  streak_days: number;
  waste_free_days: number;
  money_saved_this_week: number;
  co2_saved_this_week: number;
  points: number;
  level: number;
  level_label: string;
  expiring_soon: ExpiringSoonItemDto[];
  todays_meals: TodaysMealDto[];
  quick_recipes: RecipeDto[];
  pantry_summary: {
    total_items: number;
    expiring_soon_count: number;
    expired_count: number;
    estimated_value: number;
  };
  stats_snapshot: {
    scans_completed: number;
    meals_cooked: number;
    achievements_earned: number;
    achievements_total: number;
  };
  subscription_tier: SubscriptionTier | string;
  show_upgrade_prompt: boolean;
  unread_notifications?: number;
}

// ---------------------------------------------------------------------------
// Stats / savings
// ---------------------------------------------------------------------------

export interface TrendPoint {
  /** Bucket label — an ISO date for daily series, "Mon" for weekly bars. */
  label: string;
  value: number;
}

export interface SavingsStatsDto {
  period: 'week' | 'month' | 'year';
  total_saved_usd: number;
  breakdown: {
    grocery_savings_usd: number;
    cooking_savings_usd: number;
    waste_reduction_usd: number;
  };
  co2_saved_kg: number;
  lifetime_co2_kg: number;
  equivalent_trees: number;
  equivalent_meals: number;
  waste_reduced_pct: number;
  meals_cooked: number;
  pantry_value_usd: number;
  streak_days: number;
  waste_free_days: number;
  points: number;
  level: number;
  level_label: string;
  better_than_average: boolean;
  national_average_kg_per_week: number;
  user_kg_per_week: number;
  trend: TrendPoint[];
}

export interface WasteStatsDto {
  period: 'week' | 'month' | 'year';
  period_start: string;
  period_end: string;
  total_logs: number;
  total_grams: number;
  total_cost_usd: number;
  total_co2_kg: number;
  preventable_cost_usd: number;
  preventable_co2_kg: number;
  average_per_day_usd: number;
  average_per_day_co2_kg: number;
  previous_period_cost_usd: number;
  previous_period_co2_kg: number;
  cost_change_pct: number;
  co2_change_pct: number;
  money_saved_usd: number;
  co2_saved_kg: number;
  waste_free_days: number;
  by_category: Array<{ key: string; count: number; grams: number; cost_usd: number; co2_kg: number }>;
  by_reason: Array<{ key: string; count: number; grams: number; cost_usd: number; co2_kg: number }>;
  daily: Array<{ date: string; count: number; cost_usd: number; co2_kg: number }>;
}

/**
 * Lifetime environmental and financial impact of the food a user wasted.
 *
 * Every figure is paired with an equivalent the user can picture — a raw
 * "12.4 kg CO₂e" is meaningless next to "0.6 trees a year".
 */
export interface WasteImpactDto {
  lifetime_co2_kg: number;
  lifetime_cost_usd: number;
  /** Mature trees needed to absorb the lifetime CO₂ (21 kg/tree/year). */
  equivalent_trees: number;
  /** Home-cooked meals' worth of food (600 g/meal). */
  equivalent_meals: number;
  /** UNEP Food Waste Index household average, kg per person per week. */
  national_average_kg_per_week: number;
  /** This user's weekly average since joining. */
  user_kg_per_week: number;
  /** True when the user wastes less than the average household. */
  better_than_average: boolean;
}

/** Aliases kept for symmetry with the other `*Dto` names. */
export type WasteLogDto = WasteDto;
export type { WasteTrendPoint };

// ---------------------------------------------------------------------------
// Meal-plan week views
// ---------------------------------------------------------------------------

export interface DayMeals {
  breakfast: MealPlanEntryDto | null;
  lunch: MealPlanEntryDto | null;
  dinner: MealPlanEntryDto | null;
  snack: MealPlanEntryDto | null;
}

export interface DayMealEntry {
  /** 1 = Monday … 7 = Sunday. */
  day: number;
  date: string | null;
  meals: DayMeals;
  /** Short day label ("Mon") so a card can render a header without recomputing. */
  day_name?: string;
  /** True when `date` is today *in the plan owner's timezone*. */
  is_today?: boolean;
  /** Sum of the day's meal calories, when the caller has them. */
  total_calories?: number;
}

export interface WeekOverviewDto {
  week_start: string;
  week_end: string;
  meal_plan_id: string | null;
  /**
   * Shopping list generated for this week's plan, if there is one.
   *
   * The Plan screen links straight to it, so the overview has to carry the id —
   * without it the "open your shopping list" shortcut has nothing to open.
   */
  grocery_list_id: string | null;
  days: Array<{
    date: string;
    day_name: string;
    is_today: boolean;
    meals: MealPlanEntryDto[];
    total_calories: number;
    completed_count: number;
  }>;
  total_calories: number;
  average_daily_calories: number;
  targets: { calories: number; protein: number; carbs: number; fat: number };
  macro_check: Array<{
    day: number;
    calories: number;
    target: number;
    delta: number;
    delta_pct: number;
    within_tolerance: boolean;
  }>;
  completion_rate: number;
}

export interface NutritionBreakdownDto {
  plan_id: string;
  days: Array<{
    date: string;
    day_name: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    meals: Record<
      string,
      {
        name: string;
        calories: number;
        protein: number;
        carbs: number;
        fat: number;
        recipe_id: string;
        entry_id: string;
      } | null
    >;
  }>;
  totals: { calories: number; protein: number; carbs: number; fat: number };
  daily_average: { calories: number; protein: number; carbs: number; fat: number };
  targets: { calories: number; protein: number; carbs: number; fat: number };
  compliance: { calories: number; protein: number; carbs: number; fat: number };
  macro_check: Array<{
    day: number;
    calories: number;
    target: number;
    delta: number;
    delta_pct: number;
    within_tolerance: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Combined dashboard
// ---------------------------------------------------------------------------

export interface DashboardDto {
  home: HomeSummaryDto;
  savings: SavingsStatsDto;
  subscription: SubscriptionStatus;
  expiring_soon: ExpiringSoonItemDto[];
  generated_at: string;
}
