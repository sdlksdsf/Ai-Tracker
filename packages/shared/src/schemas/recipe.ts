import { z } from 'zod';
import { DIFFICULTY_LEVELS, INGREDIENT_CATEGORIES, MEAL_TYPES } from '../constants/index.js';

// ---------------------------------------------------------------------------
// Recipe generation request
// ---------------------------------------------------------------------------

export const generateRecipesSchema = z.object({
  /** Use the user's pantry as the primary ingredient pool. */
  use_pantry: z.boolean().default(true),
  /** Ingredients the user is happy to buy in addition to the pantry. */
  extra_ingredients: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /** Ingredients to avoid (in addition to declared allergies). */
  avoid: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  cuisine: z.string().trim().max(50).optional(),
  max_time_min: z.number().int().min(5).max(240).optional(),
  difficulty: z.enum(DIFFICULTY_LEVELS).optional(),
  meal_type: z.enum(MEAL_TYPES).optional(),
  servings: z.number().int().min(1).max(12).default(2),
  count: z.number().int().min(1).max(10).default(5),
  /** Only return recipes where at least this fraction of ingredients are in the pantry. */
  min_pantry_match: z.number().min(0).max(1).default(0.3),
});
export type GenerateRecipesInput = z.infer<typeof generateRecipesSchema>;

// ---------------------------------------------------------------------------
// Recipe shape
// ---------------------------------------------------------------------------

export const recipeIngredientSchema = z.object({
  id: z.string().uuid().optional(),
  ingredient_name: z.string().min(1).max(100),
  quantity: z.number().nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  is_optional: z.boolean().default(false),
  substitutes: z.array(z.string().max(100)).default([]),
  category: z.enum(INGREDIENT_CATEGORIES).optional().nullable(),
  /** True when the user already has this at home. */
  is_in_pantry: z.boolean().default(false),
  /** Pantry item id, so "Start Cooking" can decrement it. */
  pantry_item_id: z.string().uuid().nullable().optional(),
  /** Quantity currently available at home (same unit as the recipe). */
  pantry_quantity: z.number().nullable().optional(),
});
export type RecipeIngredient = z.infer<typeof recipeIngredientSchema>;

export const recipeStepSchema = z.object({
  id: z.string().uuid().optional(),
  step_number: z.number().int().min(1),
  instruction: z.string().min(1),
  duration_min: z.number().int().min(0).nullable().optional(),
  tip: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
});
export type RecipeStep = z.infer<typeof recipeStepSchema>;

export const recipeNutritionSchema = z.object({
  calories: z.number().nullable().optional(),
  protein_g: z.number().nullable().optional(),
  carbs_g: z.number().nullable().optional(),
  fat_g: z.number().nullable().optional(),
  fiber_g: z.number().nullable().optional(),
  sugar_g: z.number().nullable().optional(),
  sodium_mg: z.number().nullable().optional(),
  cholesterol_mg: z.number().nullable().optional(),
  saturated_fat_g: z.number().nullable().optional(),
  vitamin_a_pct: z.number().nullable().optional(),
  vitamin_c_pct: z.number().nullable().optional(),
  calcium_pct: z.number().nullable().optional(),
  iron_pct: z.number().nullable().optional(),
  potassium_mg: z.number().nullable().optional(),
  per_serving: z.boolean().default(true),
});
export type RecipeNutrition = z.infer<typeof recipeNutritionSchema>;

export const recipeDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable().optional(),
  cuisine: z.string().nullable().optional(),
  difficulty: z.enum(DIFFICULTY_LEVELS).default('easy'),
  prep_time_min: z.number().int().nullable().optional(),
  cook_time_min: z.number().int().nullable().optional(),
  total_time_min: z.number().int().nullable().optional(),
  servings: z.number().int().default(2),
  image_url: z.string().nullable().optional(),
  video_url: z.string().nullable().optional(),
  source: z.string().default('ai_generated'),
  total_cost_estimate: z.number().nullable().optional(),
  rating_avg: z.number().default(0),
  rating_count: z.number().int().default(0),
  times_cooked: z.number().int().default(0),
  is_featured: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  created_at: z.string(),
  ingredients: z.array(recipeIngredientSchema).default([]),
  steps: z.array(recipeStepSchema).default([]),
  nutrition: recipeNutritionSchema.nullable().optional(),
  /** Safety strings surfaced in the UI ("Contains: peanuts"). */
  allergen_warnings: z.array(z.string()).default([]),
  storage_instructions: z.string().nullable().optional(),
  reheating_instructions: z.string().nullable().optional(),
  /** ---- Personalised fields (present on generate/search results) ---- */
  pantry_match: z
    .object({
      /** 0..1 */
      ratio: z.number().min(0).max(1),
      in_pantry: z.number().int(),
      total: z.number().int(),
      missing: z.array(z.string()),
    })
    .nullable()
    .optional(),
  is_favorite: z.boolean().default(false),
  is_cooked: z.boolean().default(false),
  /** Ingredients that are about to expire — drives "cook this now" nudges. */
  uses_expiring_items: z.array(z.string()).default([]),
});
export type RecipeDto = z.infer<typeof recipeDtoSchema>;

// ---------------------------------------------------------------------------
// Search / list queries
// ---------------------------------------------------------------------------

export const searchRecipesQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  cuisine: z.string().trim().max(50).optional(),
  diet: z.string().trim().max(50).optional(),
  maxTime: z.coerce.number().int().min(5).max(240).optional(),
  difficulty: z.enum(DIFFICULTY_LEVELS).optional(),
  meal_type: z.enum(MEAL_TYPES).optional(),
  /** When true, rank by how much of the pantry the recipe consumes. */
  use_pantry: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  sort: z.enum(['best_match', 'quickest', 'fewest_missing', 'highest_rated', 'newest']).default('best_match'),
  cursor: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchRecipesQuery = z.infer<typeof searchRecipesQuerySchema>;

export const rateRecipeSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review_text: z.string().trim().max(2000).optional().nullable(),
  photo_url: z.string().url().optional().nullable(),
});
export type RateRecipeInput = z.infer<typeof rateRecipeSchema>;

export const cookRecipeSchema = z.object({
  servings: z.number().int().min(1).max(12).optional(),
  /** When false, pantry quantities are left untouched. */
  consume_pantry: z.boolean().default(true),
  /** Ingredient ids/names the user chose NOT to consume. */
  skip_ingredients: z.array(z.string().max(100)).max(60).default([]),
  notes: z.string().trim().max(500).optional().nullable(),
});
export type CookRecipeInput = z.infer<typeof cookRecipeSchema>;

export const paginatedRecipesSchema = z.object({
  data: z.array(recipeDtoSchema),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});
export type PaginatedRecipes = z.infer<typeof paginatedRecipesSchema>;
