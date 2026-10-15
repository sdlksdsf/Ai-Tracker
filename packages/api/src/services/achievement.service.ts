import { and, desc, eq, sql } from 'drizzle-orm';
import type { AchievementDto, AchievementsProgress } from '@platematch/shared';
import { getDb } from '../db/index.js';
import { foodWasteLogs, pantryItems, recipeCookLog, recipes, userAchievements, userFavorites, fridgeScans, users } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { periodStart } from '../utils/dates.js';
import { sendAchievementNotification } from './notification.service.js';

/**
 * Gamification (Section 6, Screen 13 + Section 7, trigger 5).
 *
 * Achievements are evaluated lazily: `checkAndAward(userId)` recomputes every
 * progress metric from the user's own rows and awards anything newly unlocked.
 * That keeps the rules in one place and means we never need a separate
 * event-sourcing pipeline.
 */

export interface AchievementDefinition {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: AchievementDto['category'];
  target: number | null;
  unit: string | null;
  tier: AchievementDto['tier'];
  points: number;
  /** Metric key resolved from `collectMetrics`. */
  metric: keyof Metrics;
}

export const ACHIEVEMENTS: AchievementDefinition[] = [
  // ---- Waste reduction ----------------------------------------------------
  { key: 'waste_first_log', name: 'Awareness Begins', description: 'Log your first piece of food waste', icon: '🌱', category: 'waste', target: 1, unit: 'logs', tier: 'bronze', points: 10, metric: 'wasteLogs' },
  { key: 'waste_10_logs', name: 'Waste Watcher', description: 'Log 10 pieces of food waste', icon: '👀', category: 'waste', target: 10, unit: 'logs', tier: 'bronze', points: 25, metric: 'wasteLogs' },
  { key: 'waste_zero_week', name: 'Zero-Waste Week', description: 'Go 7 days without logging any waste', icon: '✨', category: 'waste', target: 7, unit: 'days', tier: 'gold', points: 100, metric: 'daysSinceWaste' },
  { key: 'waste_saved_5kg', name: 'Carbon Cutter', description: 'Avoid 5 kg of CO₂e through better planning', icon: '🌍', category: 'waste', target: 5, unit: 'kg CO₂', tier: 'silver', points: 60, metric: 'co2AvoidedKg' },
  { key: 'waste_50_logs', name: 'Waste Historian', description: 'Log 50 pieces of food waste', icon: '📚', category: 'waste', target: 50, unit: 'logs', tier: 'silver', points: 50, metric: 'wasteLogs' },

  // ---- Cooking ------------------------------------------------------------
  { key: 'cook_first_meal', name: 'First Bite', description: 'Cook your first PlateMatch recipe', icon: '🍳', category: 'cooking', target: 1, unit: 'meals', tier: 'bronze', points: 10, metric: 'mealsCooked' },
  { key: 'cook_5_meals', name: 'Getting Comfortable', description: 'Cook 5 recipes', icon: '👨‍🍳', category: 'cooking', target: 5, unit: 'meals', tier: 'bronze', points: 25, metric: 'mealsCooked' },
  { key: 'cook_20_meals', name: 'Home Chef', description: 'Cook 20 recipes', icon: '🥇', category: 'cooking', target: 20, unit: 'meals', tier: 'gold', points: 100, metric: 'mealsCooked' },
  { key: 'cook_50_meals', name: 'Kitchen Legend', description: 'Cook 50 recipes', icon: '🏆', category: 'cooking', target: 50, unit: 'meals', tier: 'platinum', points: 250, metric: 'mealsCooked' },
  { key: 'cook_5_cuisines', name: 'World Traveller', description: 'Cook recipes from 5 different cuisines', icon: '🗺️', category: 'explorer', target: 5, unit: 'cuisines', tier: 'silver', points: 60, metric: 'cuisinesCooked' },

  // ---- Saving -------------------------------------------------------------
  { key: 'save_10_dollars', name: 'Budget Hero', description: 'Save $10 by cooking what you already had', icon: '💰', category: 'saving', target: 10, unit: 'USD', tier: 'bronze', points: 30, metric: 'moneySavedUsd' },
  { key: 'save_50_dollars', name: 'Wallet Guardian', description: 'Save $50 with smarter shopping', icon: '💎', category: 'saving', target: 50, unit: 'USD', tier: 'gold', points: 120, metric: 'moneySavedUsd' },
  { key: 'pantry_master', name: 'Pantry Master', description: 'Keep 25 ingredients tracked and none expired', icon: '🧺', category: 'explorer', target: 25, unit: 'items', tier: 'silver', points: 50, metric: 'freshPantryItems' },

  // ---- Scanning & streaks -------------------------------------------------
  { key: 'scan_first', name: 'Fridge Explorer', description: 'Complete your first fridge scan', icon: '📸', category: 'explorer', target: 1, unit: 'scans', tier: 'bronze', points: 10, metric: 'scansCompleted' },
  { key: 'scan_10', name: 'Scan Pro', description: 'Complete 10 fridge scans', icon: '🔍', category: 'explorer', target: 10, unit: 'scans', tier: 'silver', points: 45, metric: 'scansCompleted' },
  { key: 'streak_3', name: 'Three-Day Streak', description: 'Open PlateMatch 3 days in a row', icon: '🔥', category: 'streak', target: 3, unit: 'days', tier: 'bronze', points: 20, metric: 'streakDays' },
  { key: 'streak_7', name: 'Week Warrior', description: 'Keep a 7-day streak', icon: '⚡', category: 'streak', target: 7, unit: 'days', tier: 'silver', points: 70, metric: 'streakDays' },
  { key: 'streak_30', name: 'Unstoppable', description: 'Keep a 30-day streak', icon: '🌟', category: 'streak', target: 30, unit: 'days', tier: 'platinum', points: 300, metric: 'streakDays' },

  // ---- Planning -----------------------------------------------------------
  { key: 'plan_first', name: 'Planner', description: 'Generate your first weekly meal plan', icon: '📅', category: 'cooking', target: 1, unit: 'plans', tier: 'bronze', points: 15, metric: 'mealPlansCreated' },
  { key: 'favorite_10', name: 'Collector', description: 'Save 10 recipes to your favorites', icon: '❤️', category: 'explorer', target: 10, unit: 'recipes', tier: 'bronze', points: 20, metric: 'favorites' },
];

export const ACHIEVEMENT_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

export interface Metrics {
  wasteLogs: number;
  mealsCooked: number;
  cuisinesCooked: number;
  scansCompleted: number;
  mealPlansCreated: number;
  favorites: number;
  freshPantryItems: number;
  moneySavedUsd: number;
  co2AvoidedKg: number;
  /** Consecutive days without a waste log (capped at 365). */
  daysSinceWaste: number;
  streakDays: number;
}

/** Recompute every achievement metric for a user from their own data. */
export async function collectMetrics(userId: string): Promise<Metrics> {
  const db = getDb();

  const [wasteAgg, cookAgg, cuisineAgg, scanAgg, favAgg, pantryAgg, userRow, lastWaste] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(foodWasteLogs)
      .where(eq(foodWasteLogs.userId, userId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(recipeCookLog)
      .where(eq(recipeCookLog.userId, userId)),
    db
      .select({ count: sql<number>`count(DISTINCT ${recipes.cuisine})::int` })
      .from(recipeCookLog)
      .innerJoin(recipes, eq(recipes.id, recipeCookLog.recipeId))
      .where(eq(recipeCookLog.userId, userId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fridgeScans)
      .where(and(eq(fridgeScans.userId, userId), eq(fridgeScans.status, 'completed'))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(userFavorites)
      .where(eq(userFavorites.userId, userId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pantryItems)
      .where(and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false), eq(pantryItems.isExpired, false))),
    db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1),
    db
      .select({ loggedAt: foodWasteLogs.loggedAt })
      .from(foodWasteLogs)
      .where(eq(foodWasteLogs.userId, userId))
      .orderBy(desc(foodWasteLogs.loggedAt))
      .limit(1),
  ]);

  // Money saved = estimated cost of meals cooked from pantry ingredients.
  // We approximate it from the recipes' own cost estimate × 60% pantry coverage.
  const [savedRow] = await db
    .select({
      saved: sql<number>`COALESCE(SUM(${recipes.totalCostEstimate} * 0.6), 0)::numeric`,
    })
    .from(recipeCookLog)
    .innerJoin(recipes, eq(recipes.id, recipeCookLog.recipeId))
    .where(eq(recipeCookLog.userId, userId));

  // CO₂ avoided: meals cooked at home instead of bought, plus waste reduction.
  const [co2Row] = await db
    .select({
      co2: sql<number>`COALESCE(SUM(${foodWasteLogs.co2EquivalentKg}), 0)::numeric`,
    })
    .from(foodWasteLogs)
    .where(eq(foodWasteLogs.userId, userId));

  const mealsCooked = Number(cookAgg[0]?.count ?? 0);
  const co2Logged = Number(co2Row?.co2 ?? 0);
  // "Avoided" is benchmarked against the average household waste of ~2.5 kg CO₂e
  // per home-cooked meal that would otherwise have been thrown away.
  const co2AvoidedKg = Math.max(0, Math.round((mealsCooked * 0.8 - co2Logged * 0.5) * 100) / 100);

  const lastWasteAt = lastWaste[0]?.loggedAt ?? null;
  const memberSince = userRow[0]?.createdAt ?? new Date();
  const daysSinceWaste = lastWasteAt
    ? Math.max(0, Math.floor((Date.now() - lastWasteAt.getTime()) / 86_400_000))
    : Math.max(0, Math.floor((Date.now() - memberSince.getTime()) / 86_400_000));

  const mealPlansCreated = await countMealPlans(userId);

  return {
    wasteLogs: Number(wasteAgg[0]?.count ?? 0),
    mealsCooked,
    cuisinesCooked: Number(cuisineAgg[0]?.count ?? 0),
    scansCompleted: Number(scanAgg[0]?.count ?? 0),
    mealPlansCreated,
    favorites: Number(favAgg[0]?.count ?? 0),
    freshPantryItems: Number(pantryAgg[0]?.count ?? 0),
    moneySavedUsd: Math.round(Number(savedRow?.saved ?? 0) * 100) / 100,
    co2AvoidedKg,
    daysSinceWaste: Math.min(365, daysSinceWaste),
    streakDays: await computeStreakDays(userId),
  };
}

async function countMealPlans(userId: string): Promise<number> {
  const db = getDb();
  const { mealPlans } = await import('../db/schema.js');
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(mealPlans).where(eq(mealPlans.userId, userId));
  return Number(rows[0]?.count ?? 0);
}

/** Consecutive days with meaningful activity (cook, scan, waste log or pantry edit). */
export async function computeStreakDays(userId: string): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - 366 * 86_400_000);

  const rows = await db.execute<{ day: string }>(sql`
    SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM (
      SELECT date(${recipeCookLog.cookedAt}) AS day FROM ${recipeCookLog}
        WHERE ${recipeCookLog.userId} = ${userId} AND ${recipeCookLog.cookedAt} >= ${since}
      UNION
      SELECT date(${fridgeScans.createdAt}) FROM ${fridgeScans}
        WHERE ${fridgeScans.userId} = ${userId} AND ${fridgeScans.createdAt} >= ${since}
      UNION
      SELECT date(${foodWasteLogs.loggedAt}) FROM ${foodWasteLogs}
        WHERE ${foodWasteLogs.userId} = ${userId} AND ${foodWasteLogs.loggedAt} >= ${since}
      UNION
      SELECT date(${pantryItems.createdAt}) FROM ${pantryItems}
        WHERE ${pantryItems.userId} = ${userId} AND ${pantryItems.createdAt} >= ${since}
    ) AS activity
    ORDER BY day DESC
  `);

  // `drizzle.execute` returns rows directly for pg.
  const raw = Array.isArray(rows) ? rows : ((rows as unknown as { rows?: Array<{ day: string }> }).rows ?? []);
  const days = raw.map((r) => (r as { day: string }).day);
  if (!days.length) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // A streak only counts if it includes today or yesterday.
  if (days[0] !== today && days[0] !== yesterday) return 0;

  let streak = 1;
  for (let i = 1; i < days.length; i += 1) {
    const previous = new Date(days[i - 1] as string).getTime();
    const current = new Date(days[i] as string).getTime();
    if (previous - current === 86_400_000) streak += 1;
    else break;
  }
  return streak;
}

export interface AwardResult {
  newlyEarned: AchievementDefinition[];
  progress: AchievementsProgress;
}

/** Recompute metrics, award anything new, and return the full progress view. */
export async function checkAndAward(userId: string): Promise<AwardResult> {
  const db = getDb();
  const metrics = await collectMetrics(userId);

  const existing = await db.select().from(userAchievements).where(eq(userAchievements.userId, userId));
  const earnedKeys = new Set(existing.map((a) => a.achievementKey));

  const newlyEarned: AchievementDefinition[] = [];

  for (const definition of ACHIEVEMENTS) {
    const current = metrics[definition.metric] ?? 0;
    const target = definition.target ?? 1;
    if (earnedKeys.has(definition.key)) continue;
    if (current < target) continue;

    // eslint-disable-next-line no-await-in-loop
    await db
      .insert(userAchievements)
      .values({ userId, achievementKey: definition.key, progress: Math.round((current / target) * 100) })
      .onConflictDoNothing({ target: [userAchievements.userId, userAchievements.achievementKey] });

    earnedKeys.add(definition.key);
    newlyEarned.push(definition);
  }

  if (newlyEarned.length) {
    logger.info({ userId, earned: newlyEarned.map((a) => a.key) }, 'Achievements unlocked');
    for (const definition of newlyEarned) {
      // eslint-disable-next-line no-await-in-loop
      await sendAchievementNotification(userId, definition.name, definition.description).catch(() => undefined);
    }
  }

  return { newlyEarned, progress: buildProgress(metrics, existing, newlyEarned) };
}

function buildProgress(metrics: Metrics, existing: Array<{ achievementKey: string; progress: number; earnedAt: Date }>, newlyEarned: AchievementDefinition[]): AchievementsProgress {
  const earnedMap = new Map(existing.map((e) => [e.achievementKey, e]));
  for (const definition of newlyEarned) {
    if (!earnedMap.has(definition.key)) {
      earnedMap.set(definition.key, { achievementKey: definition.key, progress: 100, earnedAt: new Date() });
    }
  }

  const achievements: AchievementDto[] = ACHIEVEMENTS.map((definition) => {
    const earned = earnedMap.get(definition.key);
    const current = metrics[definition.metric] ?? 0;
    const target = definition.target ?? 1;
    return {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      icon: definition.icon,
      category: definition.category,
      target: definition.target,
      unit: definition.unit,
      tier: definition.tier,
      points: definition.points,
      earned: Boolean(earned),
      earned_at: earned?.earnedAt ? new Date(earned.earnedAt).toISOString() : null,
      progress: Math.max(0, Math.min(100, Math.round((current / target) * 100))),
      current: Math.round(current * 100) / 100,
    };
  });

  const points = achievements.filter((a) => a.earned).reduce((sum, a) => sum + (ACHIEVEMENT_BY_KEY.get(a.key)?.points ?? 0), 0);
  const level = levelForPoints(points);

  return {
    total: ACHIEVEMENTS.length,
    earned: achievements.filter((a) => a.earned).length,
    points,
    level: level.level,
    level_label: level.label,
    next_level_points: level.nextPoints,
    streak_days: metrics.streakDays,
    achievements,
  };
}

const LEVELS = [
  { level: 1, label: 'Kitchen Novice', min: 0 },
  { level: 2, label: 'Home Cook', min: 100 },
  { level: 3, label: 'Sous Chef', min: 300 },
  { level: 4, label: 'Head Chef', min: 600 },
  { level: 5, label: 'Waste Warrior', min: 1000 },
  { level: 6, label: 'PlateMatch Legend', min: 1600 },
];

export function levelForPoints(points: number): { level: number; label: string; nextPoints: number } {
  let current = LEVELS[0]!;
  let next = LEVELS[1]!;
  for (let i = 0; i < LEVELS.length; i += 1) {
    const entry = LEVELS[i]!;
    if (points >= entry.min) {
      current = entry;
      next = (LEVELS[i + 1] ?? entry) as (typeof LEVELS)[number];
    }
  }
  return { level: current.level, label: current.label, nextPoints: next.min };
}

/** All achievements with progress for GET /achievements. */
export async function getAchievements(userId: string): Promise<AchievementDto[]> {
  return (await checkAndAward(userId)).progress.achievements;
}

/** GET /achievements/progress */
export async function getAchievementsProgress(userId: string): Promise<AchievementsProgress> {
  return (await checkAndAward(userId)).progress;
}

/** Helper used by the waste stats screen ("this week" bucket). */
export function weekStart(): Date {
  return periodStart('week');
}

