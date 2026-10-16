import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  CreateWasteLogInput,
  WasteImpactDto,
  WasteLogDto,
  WasteStatsDto,
} from '@platematch/shared';
import { CO2_PER_KG_BY_CATEGORY } from '@platematch/shared';
import { getDb } from '../db/index.js';
import { foodWasteLogs, pantryItems, users, type FoodWasteLog } from '../db/schema.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache, invalidateDashboardCaches } from '../lib/redis.js';
import { co2ForWaste, estimatePriceUsd, inferCategory, normalizeIngredient, round2, toGrams } from '../utils/food.js';
import {
  addDays,
  daysBetween,
  isoDatesInRange,
  localPeriodDates,
  startOfDayInTimezone,
  toIsoDate,
  todayInTimezone,
} from '../utils/dates.js';
import { wasteToDto } from './dto.js';
import { checkAndAward } from './achievement.service.js';
import { invalidatePantryCache } from './pantry.service.js';

/**
 * Food-waste service — logging plus the savings/CO₂ analytics that power the
 * Waste Dashboard (Section 6, Screen 11).
 *
 * Every log records both the environmental cost (kg CO₂e per category) and the
 * financial cost (a price index per ingredient), which together drive the
 * "money saved vs last period" comparison.
 */

export async function createWasteLog(userId: string, input: CreateWasteLogInput): Promise<WasteLogDto> {
  const db = getDb();

  const rawName = (input.ingredient_name ?? input.item_name ?? '').trim();
  if (!rawName) throw new BadRequestError('Item name is required');
  if (input.quantity != null && input.quantity <= 0) throw new BadRequestError('Quantity must be greater than zero');

  const unit = input.unit ?? 'pcs';
  const quantity = input.quantity ?? 1;
  // Normalise to grams so CO₂ maths is category-agnostic.
  const grams = Math.round(toGrams(quantity, unit) ?? quantity * 100);
  const co2 = round2(input.co2_equivalent_kg ?? co2ForWaste(quantity, unit, input.category ?? inferCategory(rawName)));
  const cost = round2(input.estimated_cost ?? estimatePriceUsd(rawName, quantity, unit));

  const [row] = await db
    .insert(foodWasteLogs)
    .values({
      userId,
      pantryItemId: input.pantry_item_id ?? null,
      ingredientName: rawName.slice(0, 100),
      normalizedKey: normalizeIngredient(rawName),
      category: input.category ?? inferCategory(rawName),
      quantity: input.quantity ?? 1,
      unit,
      reason: input.reason,
      notes: input.notes?.slice(0, 1000) ?? null,
      photoUrl: input.photo_url ?? null,
      co2EquivalentKg: co2,
      estimatedCostUsd: cost,
      grams,
      // "expired", "spoiled" and "overcooked" are all waste better planning avoids;
      // plate leftovers and taste misses are not.
      preventable: input.reason === 'expired' || input.reason === 'spoiled' || input.reason === 'overcooked',
      loggedAt: input.logged_at ? new Date(input.logged_at) : new Date(),
    })
    .returning();

  const created = row as FoodWasteLog;

  // Linking to a pantry item marks it consumed-by-waste.
  if (input.pantry_item_id) {
    await db
      .update(pantryItems)
      .set({ isUsed: true, usedAt: new Date(), freshness: 'spoiled', updatedAt: new Date() })
      .where(and(eq(pantryItems.id, input.pantry_item_id), eq(pantryItems.userId, userId)));
    await invalidatePantryCache(userId);
  }

  await cache.del(CacheKeys.wasteStats(userId));
  // The Home/Stats cards read these numbers straight back.
  await invalidateDashboardCaches(userId);
  void checkAndAward(userId).catch(() => undefined);

  logger.info({ userId, id: created.id, co2, cost, reason: input.reason }, 'Waste logged');

  return wasteToDto(created);
}

/**
 * Normalise a date filter into a safe `Date`, or null.
 *
 * Callers pass either a bare date (`2026-10-15`, from `toIsoDate`) or a full
 * timestamp (`2026-10-15T21:15:50.059Z`, from `toISOString`). Appending
 * `T23:59:59.999Z` unconditionally — as this used to — turns the second form
 * into `...ZT23:59:59.999Z`, an Invalid Date, which Postgres rejects with
 * "Invalid time value" and surfaced as a 500 on every `GET /waste`.
 *
 * An unparseable bound is dropped rather than thrown: losing a filter degrades
 * the result set, while an Invalid Date takes the endpoint down.
 */
function parseDateBound(value: string | undefined | null, endOf: 'start' | 'end'): Date | null {
  if (!value) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  // Already a full timestamp (has a time component) — use it as-is.
  const hasTime = /[T ]\d{2}:\d{2}/.test(trimmed);
  const candidate = hasTime ? new Date(trimmed) : new Date(endOf === 'start' ? `${trimmed}T00:00:00.000Z` : `${trimmed}T23:59:59.999Z`);

  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

export async function listWasteLogs(
  userId: string,
  filters: { page?: number; limit?: number; from?: string; to?: string; reason?: string; category?: string } = {},
): Promise<{ data: WasteLogDto[]; total: number }> {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
  const page = Math.max(1, filters.page ?? 1);

  const conditions = [eq(foodWasteLogs.userId, userId)];

  const fromBound = parseDateBound(filters.from, 'start');
  const toBound = parseDateBound(filters.to, 'end');
  if (fromBound) conditions.push(gte(foodWasteLogs.loggedAt, fromBound));
  if (toBound) conditions.push(lte(foodWasteLogs.loggedAt, toBound));
  if (filters.reason) conditions.push(eq(foodWasteLogs.reason, filters.reason as FoodWasteLog['reason']));
  if (filters.category) conditions.push(eq(foodWasteLogs.category, filters.category as FoodWasteLog['category']));

  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db.select().from(foodWasteLogs).where(where).orderBy(desc(foodWasteLogs.loggedAt)).limit(limit).offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(foodWasteLogs).where(where),
  ]);

  return { data: rows.map((r) => wasteToDto(r as FoodWasteLog)), total: Number(countRows[0]?.count ?? 0) };
}

export async function getWasteLog(userId: string, logId: string): Promise<WasteLogDto> {
  const db = getDb();
  const rows = await db.select().from(foodWasteLogs).where(and(eq(foodWasteLogs.id, logId), eq(foodWasteLogs.userId, userId))).limit(1);
  if (!rows[0]) throw new NotFoundError('Waste log not found');
  return wasteToDto(rows[0] as FoodWasteLog);
}

export async function deleteWasteLog(userId: string, logId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .delete(foodWasteLogs)
    .where(and(eq(foodWasteLogs.id, logId), eq(foodWasteLogs.userId, userId)))
    .returning({ id: foodWasteLogs.id });
  if (!rows.length) throw new NotFoundError('Waste log not found');
  await cache.del(CacheKeys.wasteStats(userId));
  await invalidateDashboardCaches(userId);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export type WastePeriod = 'week' | 'month' | 'year';

export async function getWasteStats(userId: string, period: WastePeriod = 'week'): Promise<WasteStatsDto> {
  const cacheKey = CacheKeys.wasteStats(userId, period);
  const cached = await cache.get<WasteStatsDto>(cacheKey);
  if (cached) return cached;

  const db = getDb();
  const timezone = await userTimezone(db, userId);
  // Periods are the *user's* calendar periods. Anchoring them to UTC midnight
  // moved a Karachi user's Monday-morning waste into last week, and on the 1st
  // of the month the whole screen still showed the previous month.
  const window = localPeriodDates(period, todayInTimezone(timezone));

  const start = startOfDayInTimezone(timezone, window.startIso);
  const end = new Date();
  const previous = {
    start: startOfDayInTimezone(timezone, window.previousStartIso),
    end: endOfLocalDay(timezone, window.previousEndIso),
  };

  const [current, prev, byCategory, byReason, daily, streak] = await Promise.all([
    aggregate(db, userId, start, end),
    aggregate(db, userId, previous.start, previous.end),
    aggregateBy(db, userId, start, end, foodWasteLogs.category),
    aggregateBy(db, userId, start, end, foodWasteLogs.reason),
    dailySeries(db, userId, window.startIso, window.endIso, timezone),
    wasteFreeStreak(userId),
  ]);

  const periodDays = Math.max(1, daysBetween(window.startIso, window.endIso) + 1);

  const stats: WasteStatsDto = {
    period,
    period_start: window.startIso,
    period_end: window.endIso,
    total_logs: current.count,
    total_grams: current.grams,
    total_cost_usd: round2(current.cost),
    total_co2_kg: round2(current.co2),
    preventable_cost_usd: round2(current.preventableCost),
    preventable_co2_kg: round2(current.preventableCo2),
    average_per_day_usd: round2(current.cost / periodDays),
    average_per_day_co2_kg: round2(current.co2 / periodDays),
    previous_period_cost_usd: round2(prev.cost),
    previous_period_co2_kg: round2(prev.co2),
    cost_change_pct: pctChange(current.cost, prev.cost),
    co2_change_pct: pctChange(current.co2, prev.co2),
    money_saved_usd: round2(Math.max(0, prev.cost - current.cost)),
    co2_saved_kg: round2(Math.max(0, prev.co2 - current.co2)),
    waste_free_days: streak,
    by_category: byCategory,
    by_reason: byReason,
    daily,
  };

  await cache.set(cacheKey, stats, 300);
  return stats;
}

type Db = ReturnType<typeof getDb>;

/** The user's IANA timezone, falling back to UTC for unset/unknown values. */
async function userTimezone(db: Db, userId: string): Promise<string> {
  const [row] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  const timezone = row?.timezone?.trim();
  return timezone ? timezone : 'UTC';
}

/** The last millisecond of a local day — the inclusive end of a day range. */
function endOfLocalDay(timezone: string, isoDate: string): Date {
  return new Date(startOfDayInTimezone(timezone, isoDate).getTime() + 86_400_000 - 1);
}

interface Aggregate {
  count: number;
  grams: number;
  cost: number;
  co2: number;
  preventableCost: number;
  preventableCo2: number;
}

async function aggregate(db: Db, userId: string, start: Date, end: Date): Promise<Aggregate> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      grams: sql<number>`COALESCE(SUM(${foodWasteLogs.grams}), 0)::int`,
      cost: sql<number>`COALESCE(SUM(${foodWasteLogs.estimatedCostUsd}), 0)::numeric`,
      co2: sql<number>`COALESCE(SUM(${foodWasteLogs.co2EquivalentKg}), 0)::numeric`,
      preventableCost: sql<number>`COALESCE(SUM(CASE WHEN ${foodWasteLogs.preventable} THEN ${foodWasteLogs.estimatedCostUsd} ELSE 0 END), 0)::numeric`,
      preventableCo2: sql<number>`COALESCE(SUM(CASE WHEN ${foodWasteLogs.preventable} THEN ${foodWasteLogs.co2EquivalentKg} ELSE 0 END), 0)::numeric`,
    })
    .from(foodWasteLogs)
    .where(and(eq(foodWasteLogs.userId, userId), gte(foodWasteLogs.loggedAt, start), lte(foodWasteLogs.loggedAt, end)));

  return {
    count: Number(row?.count ?? 0),
    grams: Number(row?.grams ?? 0),
    cost: Number(row?.cost ?? 0),
    co2: Number(row?.co2 ?? 0),
    preventableCost: Number(row?.preventableCost ?? 0),
    preventableCo2: Number(row?.preventableCo2 ?? 0),
  };
}

async function aggregateBy(
  db: Db,
  userId: string,
  start: Date,
  end: Date,
  column: typeof foodWasteLogs.category | typeof foodWasteLogs.reason,
): Promise<Array<{ key: string; count: number; grams: number; cost_usd: number; co2_kg: number }>> {
  const rows = await db
    .select({
      key: sql<string>`COALESCE(${column}, 'other')`,
      count: sql<number>`count(*)::int`,
      grams: sql<number>`COALESCE(SUM(${foodWasteLogs.grams}), 0)::int`,
      cost: sql<number>`COALESCE(SUM(${foodWasteLogs.estimatedCostUsd}), 0)::numeric`,
      co2: sql<number>`COALESCE(SUM(${foodWasteLogs.co2EquivalentKg}), 0)::numeric`,
    })
    .from(foodWasteLogs)
    .where(and(eq(foodWasteLogs.userId, userId), gte(foodWasteLogs.loggedAt, start), lte(foodWasteLogs.loggedAt, end)))
    .groupBy(column)
    .orderBy(sql`count(*) DESC`);

  return rows.map((r) => ({
    key: String(r.key),
    count: Number(r.count),
    grams: Number(r.grams),
    cost_usd: round2(Number(r.cost)),
    co2_kg: round2(Number(r.co2)),
  }));
}

async function dailySeries(
  db: Db,
  userId: string,
  startIso: string,
  endIso: string,
  timezone: string,
): Promise<Array<{ date: string; cost_usd: number; co2_kg: number; count: number }>> {
  // Bucket on the user's local day, not the server's: `date(logged_at)` uses
  // the database session timezone, which put every evening's waste on the
  // following day for anyone east of Greenwich.
  const localDay = sql<string>`to_char(date(${foodWasteLogs.loggedAt} AT TIME ZONE ${timezone}), 'YYYY-MM-DD')`;

  const rows = await db
    .select({
      date: localDay.as('local_day'),
      count: sql<number>`count(*)::int`,
      cost: sql<number>`COALESCE(SUM(${foodWasteLogs.estimatedCostUsd}), 0)::numeric`,
      co2: sql<number>`COALESCE(SUM(${foodWasteLogs.co2EquivalentKg}), 0)::numeric`,
    })
    .from(foodWasteLogs)
    .where(
      and(
        eq(foodWasteLogs.userId, userId),
        gte(foodWasteLogs.loggedAt, startOfDayInTimezone(timezone, startIso)),
        lte(foodWasteLogs.loggedAt, endOfLocalDay(timezone, endIso)),
      ),
    )
    .groupBy(sql`local_day`)
    .orderBy(sql`local_day ASC`);

  // Fill gaps so the chart has a point per day.
  const byDate = new Map(rows.map((r) => [String(r.date), r]));

  return isoDatesInRange(startIso, endIso).map((key) => {
    const row = byDate.get(key);
    return {
      date: key,
      count: Number(row?.count ?? 0),
      cost_usd: round2(Number(row?.cost ?? 0)),
      co2_kg: round2(Number(row?.co2 ?? 0)),
    };
  });
}

/** Consecutive local days (including today) with no waste log. */
export async function wasteFreeStreak(userId: string): Promise<number> {
  const db = getDb();
  const timezone = await userTimezone(db, userId);
  const localToday = todayInTimezone(timezone);

  const rows = await db
    .select({ day: sql<string>`to_char(date(${foodWasteLogs.loggedAt} AT TIME ZONE ${timezone}), 'YYYY-MM-DD')`.as('local_day') })
    .from(foodWasteLogs)
    .where(eq(foodWasteLogs.userId, userId))
    .orderBy(desc(sql`local_day`))
    .limit(400);

  const wastedDays = new Set(rows.map((r) => String(r.day)));

  // If the user logged waste today (their today) the streak is zero.
  if (wastedDays.has(localToday)) return 0;

  let streak = 0;
  let cursor = localToday;

  for (let i = 0; i < 400; i += 1) {
    if (wastedDays.has(cursor)) break;
    streak += 1;
    cursor = toIsoDate(addDays(cursor, -1));
  }

  return streak;
}

function pctChange(current: number, previous: number): number {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Impact calculator for the Waste Dashboard hero cards. */
export async function getWasteImpact(userId: string): Promise<WasteImpactDto> {
  const db = getDb();
  const timezone = await userTimezone(db, userId);
  const localToday = todayInTimezone(timezone);

  // "Your weekly waste" is a *recent* rate, over at most four weeks — the
  // account's whole lifetime, divided by its age, decayed towards zero as the
  // account got older and told a heavy waster they beat the average.
  const [memberRow] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const daysActive = Math.max(1, daysBetween(toIsoDate(memberRow?.createdAt ?? new Date()), localToday) + 1);
  const weeks = Math.min(4, Math.max(1, Math.ceil(daysActive / 7)));
  const recentStart = startOfDayInTimezone(timezone, toIsoDate(addDays(localToday, -7 * weeks)));

  const [[lifetime], [recent]] = await Promise.all([
    db
      .select({
        co2: sql<number>`COALESCE(SUM(${foodWasteLogs.co2EquivalentKg}), 0)::numeric`,
        cost: sql<number>`COALESCE(SUM(${foodWasteLogs.estimatedCostUsd}), 0)::numeric`,
        grams: sql<number>`COALESCE(SUM(${foodWasteLogs.grams}), 0)::int`,
      })
      .from(foodWasteLogs)
      .where(eq(foodWasteLogs.userId, userId)),
    db
      .select({ grams: sql<number>`COALESCE(SUM(${foodWasteLogs.grams}), 0)::int` })
      .from(foodWasteLogs)
      .where(and(eq(foodWasteLogs.userId, userId), gte(foodWasteLogs.loggedAt, recentStart))),
  ]);

  const co2 = Number(lifetime?.co2 ?? 0);
  const userKgPerWeek = round2(Number(recent?.grams ?? 0) / 1000 / weeks);
  // UNEP Food Waste Index: ~1.5 kg of household food waste per person per week.
  const nationalAverage = 1.5;

  return {
    lifetime_co2_kg: round2(co2),
    lifetime_cost_usd: round2(Number(lifetime?.cost ?? 0)),
    // One mature tree absorbs ~21 kg CO₂ per year.
    equivalent_trees: round2(co2 / 21),
    // An average home-cooked meal is ~600 g.
    equivalent_meals: Math.round(Number(lifetime?.grams ?? 0) / 600),
    national_average_kg_per_week: nationalAverage,
    user_kg_per_week: userKgPerWeek,
    better_than_average: userKgPerWeek < nationalAverage,
  };
}

/** Category reference with the CO₂ factors used, for the log sheet UI. */
export function getWasteCategories(): Array<{ key: string; label: string; co2_per_kg: number; examples: string[] }> {
  const EXAMPLES: Record<string, string[]> = {
    produce: ['Wilted spinach', 'Mouldy strawberries', 'Sprouted potatoes'],
    dairy: ['Sour milk', 'Expired yoghurt', 'Mouldy cheese'],
    meat: ['Expired chicken', 'Leftover steak'],
    seafood: ['Smelly fish', 'Thawed shrimp'],
    bakery: ['Stale bread', 'Mouldy rolls'],
    grains: ['Old rice', 'Weevils in flour'],
    prepared: ['Uneaten takeaway', 'Burnt dinner'],
    condiments: ['Separated sauce', 'Expired spices'],
    beverages: ['Flat soda', 'Expired juice'],
    other: ['Unidentified'],
  };

  return Object.entries(CO2_PER_KG_BY_CATEGORY).map(([key, co2]) => ({
    key,
    label: key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    co2_per_kg: co2,
    examples: EXAMPLES[key] ?? [],
  }));
}

