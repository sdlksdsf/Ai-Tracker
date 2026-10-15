import { z } from 'zod';
import { DAYS_OF_WEEK, MEAL_TYPES } from '../constants/index.js';
import { recipeDtoSchema } from './recipe.js';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const generateMealPlanSchema = z.object({
  start_date: isoDate,
  /** Days to plan (7 by default; 1 lets the client "regenerate a day"). */
  days: z.number().int().min(1).max(14).default(7),
  daily_calories: z.number().int().min(800).max(6000).optional(),
  meals_per_day: z.number().int().min(1).max(4).default(3),
  variety: z.enum(['low', 'medium', 'high']).default('high'),
  budget: z.number().min(0).max(100000).optional(),
  cooking_time_pref: z.enum(['quick', 'balanced', 'elaborate']).default('balanced'),
  exclude_recipe_ids: z.array(z.string().uuid()).max(100).default([]),
  include_recipe_ids: z.array(z.string().uuid()).max(100).default([]),
});
export type GenerateMealPlanInput = z.infer<typeof generateMealPlanSchema>;

export const dailyNutritionSchema = z.object({
  calories: z.number().default(0),
  protein: z.number().default(0),
  carbs: z.number().default(0),
  fat: z.number().default(0),
  cost: z.number().default(0),
});
export type DailyNutrition = z.infer<typeof dailyNutritionSchema>;

export const mealPlanEntryDtoSchema = z.object({
  id: z.string().uuid(),
  meal_plan_id: z.string().uuid(),
  recipe_id: z.string().uuid().nullable().optional(),
  day_of_week: z.number().int().min(1).max(7),
  meal_type: z.enum(MEAL_TYPES),
  is_completed: z.boolean().default(false),
  completed_at: z.string().nullable().optional(),
  user_notes: z.string().nullable().optional(),
  recipe: recipeDtoSchema.nullable().optional(),
  calories: z.number().nullable().optional(),
});
export type MealPlanEntryDto = z.infer<typeof mealPlanEntryDtoSchema>;

export const mealPlanDtoSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  week_start_date: z.string(),
  week_end_date: z.string(),
  total_calories: z.number().nullable().optional(),
  total_cost_estimate: z.number().nullable().optional(),
  ai_model_used: z.string().nullable().optional(),
  status: z.string().default('active'),
  created_at: z.string(),
  entries: z.array(mealPlanEntryDtoSchema).default([]),
  /** day_of_week -> summary */
  daily_nutrition: z.record(z.string(), dailyNutritionSchema).default({}),
  weekly_totals: dailyNutritionSchema.nullable().optional(),
  waste_reduction_tips: z.array(z.string()).default([]),
  meal_prep_suggestions: z.array(z.string()).default([]),
  pantry_items_used: z.array(z.string()).default([]),
  grocery_preview: z
    .object({
      items: z.number().int(),
      estimated_cost: z.number(),
      already_in_pantry: z.number().int(),
    })
    .nullable()
    .optional(),
  grocery_list_id: z.string().uuid().nullable().optional(),
});
export type MealPlanDto = z.infer<typeof mealPlanDtoSchema>;

export const swapMealSchema = z.object({
  day: z.number().int().min(1).max(7),
  meal_type: z.enum(MEAL_TYPES),
  /** Provide one of: an existing recipe id, or let the AI pick a replacement. */
  new_recipe_id: z.string().uuid().optional(),
  ai_replace: z.boolean().default(false),
});
export type SwapMealInput = z.infer<typeof swapMealSchema>;

export const completeMealSchema = z.object({
  day: z.number().int().min(1).max(7),
  meal_type: z.enum(MEAL_TYPES),
  is_completed: z.boolean().default(true),
  user_notes: z.string().trim().max(500).optional().nullable(),
  /** When true the recipe's pantry ingredients are consumed. */
  consume_pantry: z.boolean().default(true),
});
export type CompleteMealInput = z.infer<typeof completeMealSchema>;

export const regenerateDaySchema = z.object({
  day: z.number().int().min(1).max(7),
  keep_meals: z.array(z.enum(MEAL_TYPES)).default([]),
});
export type RegenerateDayInput = z.infer<typeof regenerateDaySchema>;

export const listMealPlansQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type ListMealPlansQuery = z.infer<typeof listMealPlansQuerySchema>;

/** Regenerate a single day (used by the "Regenerate Day" button). */
export const regenerateMealPlanSchema = regenerateDaySchema;

export const DAYS = DAYS_OF_WEEK;
