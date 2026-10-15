import { z } from 'zod';
import { INGREDIENT_CATEGORIES, WASTE_REASONS } from '../constants/index.js';
import { quantitySchema, unitSchema } from './pantry.js';

export const logWasteSchema = z.object({
  item_name: z.string().trim().min(1, 'Item name is required').max(100),
  quantity: quantitySchema,
  unit: unitSchema,
  reason: z.enum(WASTE_REASONS),
  category: z.enum(INGREDIENT_CATEGORIES).optional(),
  /** Estimated money thrown away. Auto-computed from our price index when omitted. */
  estimated_cost: z.number().min(0).max(100000).optional().nullable(),
  /** kg CO2e. Auto-computed from category when omitted. */
  co2_equivalent_kg: z.number().min(0).max(100000).optional().nullable(),
  photo_url: z.string().url().optional().nullable(),
  /** Link the log to a pantry item so it can be marked used/expired. */
  pantry_item_id: z.string().uuid().optional().nullable(),
  logged_at: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional().nullable(),
});
export type LogWasteInput = z.infer<typeof logWasteSchema>;

export const wasteDtoSchema = z.object({
  id: z.string().uuid(),
  item_name: z.string(),
  quantity: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  reason: z.enum(WASTE_REASONS),
  category: z.string().nullable().optional(),
  estimated_cost: z.number().nullable().optional(),
  co2_equivalent_kg: z.number().nullable().optional(),
  photo_url: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  logged_at: z.string(),
});
export type WasteDto = z.infer<typeof wasteDtoSchema>;

export const wasteHistoryQuerySchema = z.object({
  period: z.enum(['week', 'month', 'quarter', 'year', 'all']).default('month'),
  reason: z.enum(WASTE_REASONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type WasteHistoryQuery = z.infer<typeof wasteHistoryQuerySchema>;

export const wasteTrendPointSchema = z.object({
  /** ISO date of the bucket start. */
  date: z.string(),
  label: z.string(),
  cost: z.number(),
  co2_kg: z.number(),
  items: z.number().int(),
});
export type WasteTrendPoint = z.infer<typeof wasteTrendPointSchema>;

export const wasteStatsSchema = z.object({
  this_week: z.object({ items: z.number().int(), cost: z.number(), co2_kg: z.number() }),
  this_month: z.object({ items: z.number().int(), cost: z.number(), co2_kg: z.number() }),
  this_year: z.object({ items: z.number().int(), cost: z.number(), co2_kg: z.number() }),
  all_time: z.object({ items: z.number().int(), cost: z.number(), co2_kg: z.number() }),
  trend: z.enum(['improving', 'worsening', 'stable']),
  /** 0 = least wasteful, 100 = most wasteful vs. the PlateMatch community. */
  percentile: z.number().int().min(0).max(100),
  change_vs_last_period_pct: z.number(),
  total_saved: z.object({
    cost: z.number(),
    co2_kg: z.number(),
    items: z.number().int(),
    trees_equivalent: z.number(),
    litres_water: z.number(),
  }),
  by_reason: z.array(z.object({ reason: z.enum(WASTE_REASONS), items: z.number().int(), cost: z.number() })),
  top_wasted_items: z.array(z.object({ item_name: z.string(), count: z.number().int(), cost: z.number() })),
  trend_points: z.array(wasteTrendPointSchema).default([]),
  tips: z.array(z.string()).default([]),
});
export type WasteStats = z.infer<typeof wasteStatsSchema>;

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export const achievementSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  /** Category used to group badges in the UI. */
  category: z.enum(['waste', 'cooking', 'saving', 'explorer', 'streak']),
  /** Numeric goal, when the achievement is progress-based. */
  target: z.number().int().nullable().optional(),
  /** Unit shown next to progress ("meals", "kg CO₂", "days"). */
  unit: z.string().nullable().optional(),
  tier: z.enum(['bronze', 'silver', 'gold', 'platinum']).default('bronze'),
  /** Gamification points awarded when the badge is earned. */
  points: z.number().int().default(0),
  earned: z.boolean().default(false),
  earned_at: z.string().nullable().optional(),
  progress: z.number().min(0).max(100).default(0),
  current: z.number().default(0),
});
export type AchievementDto = z.infer<typeof achievementSchema>;

export const achievementsProgressSchema = z.object({
  total: z.number().int(),
  earned: z.number().int(),
  points: z.number().int(),
  level: z.number().int(),
  level_label: z.string(),
  next_level_points: z.number().int(),
  streak_days: z.number().int(),
  achievements: z.array(achievementSchema),
});
export type AchievementsProgress = z.infer<typeof achievementsProgressSchema>;
