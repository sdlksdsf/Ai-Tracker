import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { CreatePantryItemInput, UpdatePantryItemInput } from '@platematch/shared';
import { getDb } from '../db/index.js';
import { pantryItems, type PantryItem } from '../db/schema.js';
import { BadRequestError, NotFoundError, QuotaExceededError } from '../lib/errors.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { sanitizeText } from '../lib/crypto.js';
import { defaultShelfLifeDays, estimatePriceUsd, inferCategory, normalizeIngredient, round2 } from '../utils/food.js';
import { daysUntilExpiry, expiryLabel, expiryUrgency, todayUtc, toIsoDate } from '../utils/dates.js';
import { num, pantryItemToDto, type PantryItemDto } from './dto.js';
import { getPlanLimits } from './subscription.service.js';
import type { PantryStatsDto } from '@platematch/shared';
import type { PromptPantryItem } from '../config/prompts.js';

/**
 * Pantry service — CRUD, expiry queries and the stats the dashboard needs.
 *
 * Every read path derives three expiry facts (`days_until_expiry`, `urgency`,
 * `expiry_label`) so the client never does date math — this keeps the colour
 * coding on Screen 7 consistent between platforms.
 */

export interface PantryQueryOptions {
  category?: string;
  location?: string;
  expired?: boolean;
  used?: boolean;
  q?: string;
  sort?: 'expiry_date' | 'created_at' | 'name' | 'category';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
  /** Include items already consumed. Defaults to false. */
  includeUsed?: boolean;
}

/** All active (not used, not expired) pantry items for a user. */
export async function getActivePantry(userId: string): Promise<PantryItem[]> {
  const db = getDb();
  return db
    .select()
    .from(pantryItems)
    .where(and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false)))
    .orderBy(asc(pantryItems.expiryDate));
}

/** Cached active pantry for AI prompts (5-minute TTL, invalidated on write). */
export async function getActivePantryCached(userId: string): Promise<PantryItem[]> {
  const key = CacheKeys.pantry(userId);
  const hit = await cache.get<PantryItem[]>(key);
  if (hit) return hit;
  const rows = await getActivePantry(userId);
  await cache.set(key, rows, 5 * 60);
  return rows;
}

export async function listPantry(userId: string, options: PantryQueryOptions = {}): Promise<{ items: PantryItemDto[]; total: number }> {
  const db = getDb();
  const conditions = [eq(pantryItems.userId, userId)];

  if (options.category) conditions.push(eq(pantryItems.category, options.category as PantryItem['category']));
  if (options.location) conditions.push(eq(pantryItems.location, options.location as PantryItem['location']));
  if (options.expired !== undefined) conditions.push(eq(pantryItems.isExpired, options.expired));
  if (options.used !== undefined) conditions.push(eq(pantryItems.isUsed, options.used));
  else if (options.includeUsed !== true) conditions.push(eq(pantryItems.isUsed, false));
  if (options.q) conditions.push(ilike(pantryItems.ingredientName, `%${options.q}%`));

  const where = and(...conditions);

  const sortColumn = {
    expiry_date: pantryItems.expiryDate,
    created_at: pantryItems.createdAt,
    name: pantryItems.ingredientName,
    category: pantryItems.category,
  }[options.sort ?? 'expiry_date'];

  const direction = options.order === 'desc' ? desc(sortColumn) : asc(sortColumn);
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));

  const [rows, countRows] = await Promise.all([
    db.select().from(pantryItems).where(where).orderBy(direction, asc(pantryItems.ingredientName)).limit(limit).offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(pantryItems).where(where),
  ]);

  return { items: rows.map(toDto), total: Number(countRows[0]?.count ?? 0) };
}

export function toDto(item: PantryItem): PantryItemDto {
  const days = item.isExpired ? (item.expiryDate ? daysUntilExpiry(item.expiryDate) ?? 0 : -1) : daysUntilExpiry(item.expiryDate);
  return pantryItemToDto(item, {
    daysUntilExpiry: days,
    urgency: item.isUsed ? 'used' : item.isExpired ? 'expired' : expiryUrgency(days),
    expiryLabel: item.isUsed ? 'Used' : expiryLabel(days),
  });
}

export async function getPantryItem(userId: string, id: string): Promise<PantryItem> {
  const db = getDb();
  const rows = await db.select().from(pantryItems).where(and(eq(pantryItems.id, id), eq(pantryItems.userId, userId))).limit(1);
  const item = rows[0] as PantryItem | undefined;
  if (!item) throw new NotFoundError('Pantry item not found');
  return item;
}

export async function createPantryItem(userId: string, input: CreatePantryItemInput, tier = 'free'): Promise<PantryItemDto> {
  const db = getDb();

  // Enforce the plan's pantry cap (Section 9).
  const limits = getPlanLimits(tier);
  if (limits.maxPantryItems > 0) {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pantryItems)
      .where(and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false)));
    const count = Number(countRow?.count ?? 0);
    if (count >= limits.maxPantryItems) {
      throw new QuotaExceededError(
        `Your ${tier} plan holds up to ${limits.maxPantryItems} pantry items. Upgrade to Premium for unlimited storage.`,
        { limit: limits.maxPantryItems, current: count },
      );
    }
  }

  const name = sanitizeText(input.ingredient_name).slice(0, 100);
  if (!name) throw new BadRequestError('Ingredient name is required');

  const category = input.category === 'other' ? inferCategory(name) : input.category;
  const expiryDate = resolveExpiry(input.expiry_date, name, input.purchase_date);

  const rows = await db
    .insert(pantryItems)
    .values({
      userId,
      ingredientName: name,
      normalizedKey: normalizeIngredient(name),
      category: (category ?? 'other') as PantryItem['category'],
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
      expiryDate,
      purchaseDate: input.purchase_date ?? toIsoDate(todayUtc()),
      addedVia: input.added_via,
      aiConfidence: input.ai_confidence ?? null,
      photoUrl: input.photo_url ?? null,
      barcode: input.barcode ?? null,
      location: input.location,
      isExpired: expiryDate ? daysUntilExpiry(expiryDate)! < 0 : false,
    })
    .returning();

  await invalidatePantryCache(userId);
  return toDto(rows[0] as PantryItem);
}

export async function updatePantryItem(userId: string, id: string, input: UpdatePantryItemInput): Promise<PantryItemDto> {
  const db = getDb();
  const existing = await getPantryItem(userId, id);

  const patch: Partial<PantryItem> = { updatedAt: new Date() };

  if (input.ingredient_name !== undefined) {
    const name = sanitizeText(input.ingredient_name).slice(0, 100);
    if (!name) throw new BadRequestError('Ingredient name cannot be empty');
    patch.ingredientName = name;
    patch.normalizedKey = normalizeIngredient(name);
    if (input.category === undefined) patch.category = inferCategory(name) as PantryItem['category'];
  }
  if (input.category !== undefined) patch.category = input.category as PantryItem['category'];
  if (input.quantity !== undefined) patch.quantity = input.quantity ?? null;
  if (input.unit !== undefined) patch.unit = input.unit ?? null;
  if (input.expiry_date !== undefined) patch.expiryDate = input.expiry_date ?? null;
  if (input.purchase_date !== undefined) patch.purchaseDate = input.purchase_date ?? null;
  if (input.location !== undefined) patch.location = input.location as PantryItem['location'];
  if (input.photo_url !== undefined) patch.photoUrl = input.photo_url ?? null;
  if (input.barcode !== undefined) patch.barcode = input.barcode ?? null;
  if (input.added_via !== undefined) patch.addedVia = input.added_via as PantryItem['addedVia'];
  if (input.ai_confidence !== undefined) patch.aiConfidence = input.ai_confidence ?? null;
  if (input.is_expired !== undefined) patch.isExpired = input.is_expired;
  if (input.is_used !== undefined) {
    patch.isUsed = input.is_used;
    patch.usedAt = input.is_used ? new Date() : null;
  }

  // Recompute expiry status whenever the date changes.
  if (patch.expiryDate !== undefined) {
    const days = patch.expiryDate ? daysUntilExpiry(patch.expiryDate) : null;
    patch.isExpired = days !== null && days < 0;
  }

  const rows = await db.update(pantryItems).set(patch).where(and(eq(pantryItems.id, id), eq(pantryItems.userId, userId))).returning();
  await invalidatePantryCache(userId);
  return toDto(rows[0] as PantryItem);
}

export async function deletePantryItem(userId: string, id: string): Promise<void> {
  const db = getDb();
  const rows = await db.delete(pantryItems).where(and(eq(pantryItems.id, id), eq(pantryItems.userId, userId))).returning({ id: pantryItems.id });
  if (!rows.length) throw new NotFoundError('Pantry item not found');
  await invalidatePantryCache(userId);
}

/** Mark several items as used in one round-trip. */
export async function batchMarkUsed(userId: string, ids: string[]): Promise<{ updated: number }> {
  if (!ids.length) return { updated: 0 };
  const db = getDb();
  const rows = await db
    .update(pantryItems)
    .set({ isUsed: true, usedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(pantryItems.userId, userId), inArray(pantryItems.id, ids), eq(pantryItems.isUsed, false)))
    .returning({ id: pantryItems.id });
  await invalidatePantryCache(userId);
  return { updated: rows.length };
}

/** Items expiring within `days` (including today, excluding already-expired). */
export async function getExpiringSoon(userId: string, days = 3): Promise<PantryItemDto[]> {
  const db = getDb();
  const today = toIsoDate(todayUtc());
  const horizon = toIsoDate(new Date(todayUtc().getTime() + days * 86_400_000));

  const rows = await db
    .select()
    .from(pantryItems)
    .where(
      and(
        eq(pantryItems.userId, userId),
        eq(pantryItems.isUsed, false),
        eq(pantryItems.isExpired, false),
        isNotNull(pantryItems.expiryDate),
        gte(pantryItems.expiryDate, today),
        lte(pantryItems.expiryDate, horizon),
      ),
    )
    .orderBy(asc(pantryItems.expiryDate));

  return rows.map(toDto);
}

export async function getExpired(userId: string): Promise<PantryItemDto[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(pantryItems)
    .where(and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false), eq(pantryItems.isExpired, true)))
    .orderBy(asc(pantryItems.expiryDate));
  return rows.map(toDto);
}

export interface PantryStats extends PantryStatsDto {
  by_category: Array<{ category: string; count: number }>;
  by_location: Array<{ location: string; count: number }>;
}

export async function getPantryStats(userId: string): Promise<PantryStats> {
  const db = getDb();
  const activeWhere = and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false));

  const [totals, byCategory, byLocation, addedThisWeek, usedThisWeek] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        expiringSoon: sql<number>`count(*) FILTER (WHERE ${pantryItems.isExpired} = false AND ${pantryItems.expiryDate} IS NOT NULL AND ${pantryItems.expiryDate} <= ${toIsoDate(new Date(todayUtc().getTime() + 5 * 86_400_000))} AND ${pantryItems.expiryDate} >= ${toIsoDate(todayUtc())})::int`,
        expired: sql<number>`count(*) FILTER (WHERE ${pantryItems.isExpired} = true)::int`,
      })
      .from(pantryItems)
      .where(activeWhere),
    db
      .select({ category: pantryItems.category, count: sql<number>`count(*)::int` })
      .from(pantryItems)
      .where(activeWhere)
      .groupBy(pantryItems.category)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ location: pantryItems.location, count: sql<number>`count(*)::int` })
      .from(pantryItems)
      .where(activeWhere)
      .groupBy(pantryItems.location),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pantryItems)
      .where(and(eq(pantryItems.userId, userId), gte(pantryItems.createdAt, new Date(Date.now() - 7 * 86_400_000)))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pantryItems)
      .where(
        and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, true), gte(pantryItems.usedAt, new Date(Date.now() - 7 * 86_400_000))),
      ),
  ]);

  const row = totals[0];

  // What the shelf is worth, and which item has been sitting there longest.
  // Both were hard-coded (`0` and `null`) while the Pantry screen renders
  // "Estimated value" straight from this field, so every user saw $0.00.
  const valueRows = await db
    .select({
      id: pantryItems.id,
      name: pantryItems.ingredientName,
      quantity: pantryItems.quantity,
      unit: pantryItems.unit,
      createdAt: pantryItems.createdAt,
    })
    .from(pantryItems)
    .where(activeWhere)
    .orderBy(asc(pantryItems.createdAt));

  const totalEstimatedValue = round2(
    valueRows.reduce((sum, item) => sum + estimatePriceUsd(item.name, num(item.quantity) ?? 1, item.unit ?? 'pcs'), 0),
  );

  const oldest = valueRows[0];

  return {
    total_items: Number(row?.total ?? 0),
    by_category: byCategory.map((c) => ({ category: c.category, count: Number(c.count) })),
    by_location: byLocation.map((l) => ({ location: l.location, count: Number(l.count) })),
    expiring_soon: Number(row?.expiringSoon ?? 0),
    expired: Number(row?.expired ?? 0),
    fresh: Math.max(0, Number(row?.total ?? 0) - Number(row?.expiringSoon ?? 0) - Number(row?.expired ?? 0)),
    total_estimated_value: totalEstimatedValue,
    items_added_this_week: Number(addedThisWeek[0]?.count ?? 0),
    items_used_this_week: Number(usedThisWeek[0]?.count ?? 0),
    oldest_item: oldest
      ? {
          id: oldest.id,
          ingredient_name: oldest.name,
          days: Math.max(0, Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 86_400_000)),
        }
      : null,
  };
}

/** Convert pantry rows into the prompt shape the AI services expect. */
export function toPromptPantry(items: PantryItem[], maxDays = 90): PromptPantryItem[] {
  return items
    .filter((item) => {
      const days = daysUntilExpiry(item.expiryDate);
      return days === null || days >= -1 || days > -maxDays;
    })
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

/** Items expiring within N days, in prompt shape. */
export function pickExpiring(items: PantryItem[], days = 3): PantryItem[] {
  return items.filter((item) => {
    const d = daysUntilExpiry(item.expiryDate);
    return d !== null && d >= 0 && d <= days && !item.isUsed;
  });
}

/**
 * Refresh `is_expired` flags for a user. Called by the nightly cron and lazily
 * whenever the pantry is read with an expiry filter.
 */
export async function refreshExpiredFlags(userId?: string): Promise<number> {
  const db = getDb();
  const today = toIsoDate(todayUtc());
  const condition = and(
    eq(pantryItems.isUsed, false),
    eq(pantryItems.isExpired, false),
    isNotNull(pantryItems.expiryDate),
    lt(pantryItems.expiryDate, today),
    ...(userId ? [eq(pantryItems.userId, userId)] : []),
  );

  const rows = await db
    .update(pantryItems)
    .set({ isExpired: true, updatedAt: new Date() })
    .where(condition)
    .returning({ id: pantryItems.id, userId: pantryItems.userId });

  for (const row of new Set(rows.map((r) => r.userId))) {
    await invalidatePantryCache(row);
  }
  return rows.length;
}

/** Find the pantry items that cover a recipe ingredient name. */
export async function findMatchingPantryItems(
  userId: string,
  ingredientNames: string[],
): Promise<Map<string, PantryItem>> {
  const pantry = await getActivePantryCached(userId);
  const out = new Map<string, PantryItem>();

  for (const name of ingredientNames) {
    const key = normalizeIngredient(name);
    let best: { item: PantryItem; score: number } | null = null;

    for (const item of pantry) {
      if (item.normalizedKey === key) {
        best = { item, score: 1 };
        break;
      }
      const itemKey = item.normalizedKey || normalizeIngredient(item.ingredientName);
      if (!itemKey) continue;
      if (itemKey.includes(key) || key.includes(itemKey)) {
        const shorter = Math.min(itemKey.length, key.length);
        const longer = Math.max(itemKey.length, key.length);
        const score = shorter / longer;
        if (score >= 0.6 && (!best || score > best.score)) best = { item, score };
      }
    }

    if (best) out.set(name.toLowerCase(), best.item);
  }

  return out;
}

export async function invalidatePantryCache(userId: string): Promise<void> {
  await Promise.all([cache.del(CacheKeys.pantry(userId)), cache.delPattern(CacheKeys.pantryList(userId))]);
}

function resolveExpiry(expiryDate: string | null | undefined, name: string, purchaseDate: string | null | undefined): string | null {
  if (expiryDate) return expiryDate;
  // No expiry supplied → estimate from the item's typical shelf life.
  const base = purchaseDate ?? toIsoDate(todayUtc());
  const [y, m, d] = base.split('-').map(Number) as [number, number, number];
  const startDate = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return toIsoDate(new Date(startDate.getTime() + defaultShelfLifeDays(name) * 86_400_000));
}
