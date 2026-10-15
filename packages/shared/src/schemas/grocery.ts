import { z } from 'zod';
import { INGREDIENT_CATEGORIES } from '../constants/index.js';
import { isoDate } from './mealplan.js';
import { quantitySchema, unitSchema } from './pantry.js';

export const storePriceSchema = z.object({
  store: z.string().max(100),
  price: z.number().min(0),
  currency: z.string().length(3).default('USD'),
  in_stock: z.boolean().default(true),
  url: z.string().url().optional().nullable(),
  fetched_at: z.string().optional(),
});
export type StorePrice = z.infer<typeof storePriceSchema>;

export const groceryListItemSchema = z.object({
  ingredient_name: z.string().max(100),
  quantity: quantitySchema,
  unit: unitSchema,
  category: z.enum(INGREDIENT_CATEGORIES).default('other'),
});
export type GroceryListItemInput = z.infer<typeof groceryListItemSchema>;

export const generateGroceryListSchema = z
  .object({
    /** Build from a meal plan (recommended). */
    meal_plan_id: z.string().uuid().optional(),
    /** …or from a single recipe. */
    recipe_ids: z.array(z.string().uuid()).max(30).optional(),
    /** …or from explicit items. */
    items: z.array(groceryListItemSchema).max(200).optional(),
    title: z.string().trim().max(200).optional(),
    /** Subtract what the user already has at home. */
    subtract_pantry: z.boolean().default(true),
    /** Skip live price lookups (free tier / offline). */
    skip_prices: z.boolean().default(false),
  })
  .refine((d) => d.meal_plan_id || (d.recipe_ids && d.recipe_ids.length) || (d.items && d.items.length), {
    message: 'Provide meal_plan_id, recipe_ids or items',
  });
export type GenerateGroceryListInput = z.infer<typeof generateGroceryListSchema>;

export const groceryListItemDtoSchema = z.object({
  id: z.string().uuid(),
  grocery_list_id: z.string().uuid(),
  ingredient_name: z.string(),
  quantity: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  estimated_price: z.number().nullable().optional(),
  cheapest_store: z.string().nullable().optional(),
  actual_price: z.number().nullable().optional(),
  is_purchased: z.boolean().default(false),
  needed_for_recipes: z.array(z.string()).default([]),
  store_prices: z.array(storePriceSchema).default([]),
  /** True when this item was already found in the pantry. */
  in_pantry: z.boolean().default(false),
});
export type GroceryListItemDto = z.infer<typeof groceryListItemDtoSchema>;

export const groceryListDtoSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  meal_plan_id: z.string().uuid().nullable().optional(),
  title: z.string().nullable().optional(),
  total_estimated_cost: z.number().nullable().optional(),
  total_actual_cost: z.number().nullable().optional(),
  status: z.string().default('active'),
  created_at: z.string(),
  items: z.array(groceryListItemDtoSchema).default([]),
  /** Cheapest-store routing total vs. single-store total. */
  savings: z
    .object({
      single_store_total: z.number(),
      optimized_total: z.number(),
      saved: z.number(),
      percent: z.number(),
    })
    .nullable()
    .optional(),
  purchased_count: z.number().int().default(0),
  total_count: z.number().int().default(0),
});
export type GroceryListDto = z.infer<typeof groceryListDtoSchema>;

export const updateGroceryItemSchema = z.object({
  is_purchased: z.boolean().optional(),
  actual_price: z.number().min(0).max(100000).optional().nullable(),
  quantity: quantitySchema,
  unit: unitSchema,
  ingredient_name: z.string().trim().max(100).optional(),
  cheapest_store: z.string().max(100).optional().nullable(),
});
export type UpdateGroceryItemInput = z.infer<typeof updateGroceryItemSchema>;

export const addGroceryItemSchema = groceryListItemSchema.extend({
  estimated_price: z.number().min(0).max(100000).optional().nullable(),
  needed_for_recipes: z.array(z.string().max(200)).max(20).optional(),
});
export type AddGroceryItemInput = z.infer<typeof addGroceryItemSchema>;

export const listGroceryListsQuerySchema = z.object({
  status: z.enum(['active', 'completed', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListGroceryListsQuery = z.infer<typeof listGroceryListsQuerySchema>;

export const orderGroceryListSchema = z.object({
  /** Delivery provider to deep-link into. */
  provider: z.enum(['instacart', 'amazon_fresh', 'walmart', 'kroger', 'pandago', 'generic']).default('instacart'),
  group_by: z.enum(['category', 'store']).default('store'),
});
export type OrderGroceryListInput = z.infer<typeof orderGroceryListSchema>;

export const orderGroceryListResponseSchema = z.object({
  provider: z.string(),
  url: z.string().url(),
  item_count: z.number().int(),
  estimated_total: z.number(),
  /** Plain-text list for the native share sheet / PDF export. */
  share_text: z.string(),
});
export type OrderGroceryListResponse = z.infer<typeof orderGroceryListResponseSchema>;

export const updateGroceryListSchema = z.object({
  title: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'completed']).optional(),
  /** Bulk-mark every remaining item as purchased. */
  mark_all_purchased: z.boolean().optional(),
  week_start_date: isoDate.optional(),
});
export type UpdateGroceryListInput = z.infer<typeof updateGroceryListSchema>;
