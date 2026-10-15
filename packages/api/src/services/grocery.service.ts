import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  AddGroceryItemInput,
  GenerateGroceryListInput,
  GroceryListDto,
  GroceryListItemDto,
  ListGroceryListsQuery,
  OrderGroceryListInput,
  OrderGroceryListResponse,
  PriceComparisonDto,
  UpdateGroceryItemInput,
  UpdateGroceryListInput,
} from '@platematch/shared';
import { CACHE_TTL_SECONDS } from '@platematch/shared';
import { getDb } from '../db/index.js';
import {
  groceryListItems,
  groceryLists,
  mealPlanEntries,
  mealPlans,
  recipeIngredients,
  recipes,
  type GroceryList,
  type GroceryListItem,
} from '../db/schema.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { estimatePriceUsd, formatQuantity, inferCategory, normalizeIngredient, round2 } from '../utils/food.js';
import { toIsoDate, todayUtc } from '../utils/dates.js';
import { computeSavings, lookupPricesBatch, type StorePrice as AiStorePrice } from './ai/grocery-price.service.js';
import { getActivePantryCached } from './pantry.service.js';
import { getUserById } from './user.service.js';
import { getPlanLimits } from './subscription.service.js';
import { groceryItemToDto, groceryListToDto } from './dto.js';

/**
 * Grocery-list service (Sections 4, 5.D and 6, Screen 11).
 *
 * A list is built from a meal plan, from recipes, or from explicit items.
 * Anything already in the pantry is flagged `in_pantry` (and dropped when
 * `subtract_pantry` is set) so the shopper only buys what is missing.
 *
 * Price comparison: `refreshPrices` fans out to Kroger → Spoonacular → the
 * offline estimator, stores the per-store offers on each line, and writes the
 * "route each item to its cheapest store" saving onto the list header.
 */

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateGroceryList(userId: string, input: GenerateGroceryListInput): Promise<GroceryListDto> {
  const db = getDb();
  const user = await getUserById(userId);
  if (!user) throw new NotFoundError('User not found');

  const aggregated = new Map<string, AggregatedItem>();

  if (input.meal_plan_id) {
    const [plan] = await db.select().from(mealPlans).where(and(eq(mealPlans.id, input.meal_plan_id), eq(mealPlans.userId, userId))).limit(1);
    if (!plan) throw new NotFoundError('Meal plan not found');

    const entries = (await db.select().from(mealPlanEntries).where(eq(mealPlanEntries.mealPlanId, plan.id))) as Array<{
      recipeId: string | null;
      servings: number;
    }>;

    for (const entry of entries) {
      if (!entry.recipeId) continue;
      // eslint-disable-next-line no-await-in-loop
      await addRecipeIngredients(aggregated, entry.recipeId, entry.servings, userId);
    }
  }

  for (const recipeId of input.recipe_ids ?? []) {
    await addRecipeIngredients(aggregated, recipeId, null, userId);
  }

  for (const item of input.items ?? []) {
    accumulate(aggregated, {
      name: item.ingredient_name,
      quantity: item.quantity ?? 1,
      unit: item.unit ?? null,
      category: item.category ?? inferCategory(item.ingredient_name),
      recipeId: null,
      recipeTitle: null,
    });
  }

  if (!aggregated.size) throw new BadRequestError('Nothing to shop for — the source had no ingredients.');

  // ---- Pantry subtraction ------------------------------------------------
  const pantry = input.subtract_pantry ? await getActivePantryCached(userId) : [];
  const pantryKeys = new Set(pantry.filter((p) => !p.isUsed).map((p) => normalizeIngredient(p.ingredientName)));

  const items = [...aggregated.values()]
    .map((item) => ({ ...item, inPantry: pantryKeys.has(item.key) }))
    .filter((item) => !(input.subtract_pantry && item.inPantry))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.category ? a.name : b.name));

  const limits = getPlanLimits(user.subscriptionTier);
  const withPrices = !input.skip_prices && limits.priceComparison;

  for (const item of items) {
    item.estimatedCost = round2(estimatePriceUsd(item.name, item.quantity, item.unit));
  }

  // ---- Live prices (premium) --------------------------------------------
  if (withPrices && items.length) {
    const lookups = await lookupPricesBatch(
      items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      { userId },
    );

    for (const item of items) {
      const lookup = lookups.get(item.name);
      if (!lookup) continue;
      item.storePrices = lookup.storePrices;
      item.cheapest = lookup.cheapest;
      if (lookup.cheapest) item.estimatedCost = round2(lookup.cheapest.price * (item.quantity ?? 1));
      else if (lookup.estimatedPrice) item.estimatedCost = round2(lookup.estimatedPrice * (item.quantity ?? 1));
    }
  }

  const totalCost = round2(items.reduce((sum, i) => sum + i.estimatedCost, 0));
  const savings = computeSavings(items.map((i) => ({ name: i.name, prices: i.storePrices })));

  const title =
    input.title ??
    (input.meal_plan_id ? `Groceries · week of ${toIsoDate(todayUtc())}` : 'Shopping List');

  const [listRow] = await db
    .insert(groceryLists)
    .values({
      userId,
      mealPlanId: input.meal_plan_id ?? null,
      title: title.slice(0, 200),
      status: 'active',
      currency: user.currency,
      totalItems: items.length,
      totalChecked: 0,
      totalEstimatedCost: totalCost,
      savingsAmount: savings.saved,
      cheapestStore: bestStore(items),
      pricesFetchedAt: withPrices ? new Date() : null,
    })
    .returning();

  const list = listRow as GroceryList;

  if (items.length) {
    await db.insert(groceryListItems).values(
      items.map((item, index) => ({
        groceryListId: list.id,
        ingredientName: item.name.slice(0, 100),
        normalizedKey: item.key,
        category: item.category as GroceryListItem['category'],
        quantity: item.quantity,
        unit: item.unit,
        estimatedPrice: item.estimatedCost,
        estimatedCost: item.estimatedCost,
        cheapestStore: item.cheapest?.store ?? null,
        cheapestPrice: item.cheapest ? round2(item.cheapest.price) : null,
        isChecked: false,
        inPantry: item.inPantry,
        neededForRecipes: item.recipeIds,
        fromRecipes: item.recipeTitles.slice(0, 6),
        storePrices: item.storePrices,
        sortOrder: index,
      })),
    );
  }

  await cache.set(
    CacheKeys.groceryPrices(list.id),
    {
      grocery_list_id: list.id,
      meal_plan_id: input.meal_plan_id ?? null,
      checked_at: new Date().toISOString(),
      single_store_total: savings.singleStoreTotal,
      optimized_total: savings.optimizedTotal,
      saved: savings.saved,
      percent: savings.percent,
      best_store: bestStore(items),
      per_store: perStoreTotals(items),
      deals: dealsFor(items),
    } satisfies PriceComparisonDto,
    CACHE_TTL_SECONDS.groceryPrices,
  );

  logger.info({ userId, listId: list.id, items: items.length, total: totalCost, priced: withPrices }, 'Grocery list generated');

  return getGroceryList(userId, list.id);
}

interface AggregatedItem {
  key: string;
  name: string;
  quantity: number;
  unit: string | null;
  category: string;
  recipeIds: string[];
  recipeTitles: string[];
  inPantry: boolean;
  estimatedCost: number;
  storePrices: AiStorePrice[];
  cheapest: AiStorePrice | null;
}

function accumulate(
  map: Map<string, AggregatedItem>,
  row: { name: string; quantity: number | null; unit: string | null; category: string | null; recipeId: string | null; recipeTitle: string | null },
): void {
  const key = normalizeIngredient(row.name);
  const quantity = round2(row.quantity ?? 1);
  const existing = map.get(key);

  if (existing) {
    // Only sum quantities that share a unit — "2 eggs" + "1 cup flour" makes no sense.
    existing.quantity = existing.unit && row.unit && existing.unit !== row.unit ? existing.quantity : round2(existing.quantity + quantity);
    if (row.recipeId && !existing.recipeIds.includes(row.recipeId)) existing.recipeIds.push(row.recipeId);
    if (row.recipeTitle && !existing.recipeTitles.includes(row.recipeTitle)) existing.recipeTitles.push(row.recipeTitle);
    return;
  }

  map.set(key, {
    key,
    name: row.name,
    quantity,
    unit: row.unit,
    category: row.category ?? inferCategory(row.name),
    recipeIds: row.recipeId ? [row.recipeId] : [],
    recipeTitles: row.recipeTitle ? [row.recipeTitle] : [],
    inPantry: false,
    estimatedCost: 0,
    storePrices: [],
    cheapest: null,
  });
}

async function addRecipeIngredients(
  map: Map<string, AggregatedItem>,
  recipeId: string,
  servings: number | null,
  userId: string,
): Promise<void> {
  const db = getDb();

  const [recipe] = await db
    .select({ id: recipes.id, title: recipes.title, servings: recipes.servings })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), sql`(${recipes.ownerId} = ${userId} OR ${recipes.isPublic} = true)`))
    .limit(1);
  if (!recipe) return;

  const rows = (await db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(asc(recipeIngredients.sortOrder))) as Array<{
    ingredientName: string;
    quantity: number | null;
    unit: string | null;
    category: string | null;
    isOptional: boolean;
  }>;

  const scale = servings && recipe.servings ? servings / recipe.servings : 1;

  for (const row of rows) {
    if (row.isOptional) continue;
    accumulate(map, {
      name: row.ingredientName,
      quantity: row.quantity != null ? round2(row.quantity * scale) : null,
      unit: row.unit,
      category: row.category,
      recipeId,
      recipeTitle: recipe.title,
    });
  }
}

function bestStore(items: AggregatedItem[]): string | null {
  const totals = perStoreTotals(items);
  return totals.length ? (totals[0]!.store ?? null) : null;
}

function perStoreTotals(items: AggregatedItem[]): Array<{ store: string; total: number; items: number }> {
  const byStore = new Map<string, { total: number; items: number }>();

  for (const item of items) {
    for (const price of item.storePrices) {
      const entry = byStore.get(price.store) ?? { total: 0, items: 0 };
      entry.total = round2(entry.total + price.price * (item.quantity ?? 1));
      entry.items += 1;
      byStore.set(price.store, entry);
    }
  }

  return [...byStore.entries()]
    .map(([store, v]) => ({ store, total: v.total, items: v.items }))
    .sort((a, b) => a.total - b.total);
}

function dealsFor(items: AggregatedItem[]): PriceComparisonDto['deals'] {
  const deals: PriceComparisonDto['deals'] = [];

  for (const item of items) {
    if (item.storePrices.length < 2) continue;
    const sorted = [...item.storePrices].sort((a, b) => a.price - b.price);
    const cheapest = sorted[0]!;
    const priciest = sorted[sorted.length - 1]!;
    if (cheapest.store === priciest.store) continue;

    deals.push({
      item_id: '',
      ingredient_name: item.name,
      cheapest_store: cheapest.store,
      cheapest_price: round2(cheapest.price * (item.quantity ?? 1)),
      most_expensive_store: priciest.store,
      most_expensive_price: round2(priciest.price * (item.quantity ?? 1)),
      save: round2((priciest.price - cheapest.price) * (item.quantity ?? 1)),
    });
  }

  return deals.sort((a, b) => b.save - a.save).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getGroceryList(userId: string, listId: string): Promise<GroceryListDto> {
  const db = getDb();
  const list = await assertListOwner(userId, listId);

  const itemRows = (await db
    .select()
    .from(groceryListItems)
    .where(eq(groceryListItems.groceryListId, listId))
    .orderBy(asc(groceryListItems.isChecked), asc(groceryListItems.sortOrder))) as GroceryListItem[];

  const items = itemRows.map(groceryItemToDto);
  const cached = await cache.get<PriceComparisonDto>(CacheKeys.groceryPrices(listId));

  const savings =
    cached && cached.single_store_total > 0
      ? {
          single_store_total: cached.single_store_total,
          optimized_total: cached.optimized_total,
          saved: cached.saved,
          percent: cached.percent,
        }
      : Number(list.savingsAmount) > 0
        ? {
            single_store_total: round2(Number(list.totalEstimatedCost ?? 0) + Number(list.savingsAmount)),
            optimized_total: round2(Number(list.totalEstimatedCost ?? 0)),
            saved: round2(Number(list.savingsAmount)),
            percent: Number(list.totalEstimatedCost) > 0 ? Math.round((Number(list.savingsAmount) / Number(list.totalEstimatedCost)) * 100) : 0,
          }
        : null;

  return groceryListToDto(list, items, savings);
}

export async function listGroceryLists(userId: string, query: ListGroceryListsQuery): Promise<{ data: GroceryListDto[]; total: number }> {
  const db = getDb();
  const conditions = [eq(groceryLists.userId, userId)];
  if (query.status !== 'all') conditions.push(eq(groceryLists.status, query.status));

  const where = and(...conditions);
  const limit = Math.min(50, Math.max(1, query.limit));
  const page = Math.max(1, query.page);

  const [rows, countRows] = await Promise.all([
    db.select().from(groceryLists).where(where).orderBy(desc(groceryLists.createdAt)).limit(limit).offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(groceryLists).where(where),
  ]);

  return {
    data: await Promise.all((rows as GroceryList[]).map((r) => getGroceryList(userId, r.id))),
    total: Number(countRows[0]?.count ?? 0),
  };
}

/** The most recent active list, used by the Home screen shortcut. */
export async function getActiveGroceryList(userId: string): Promise<GroceryListDto | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(groceryLists)
    .where(and(eq(groceryLists.userId, userId), eq(groceryLists.status, 'active')))
    .orderBy(desc(groceryLists.createdAt))
    .limit(1);
  return row ? getGroceryList(userId, (row as GroceryList).id) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function addGroceryItem(userId: string, listId: string, input: AddGroceryItemInput): Promise<GroceryListItemDto> {
  const db = getDb();
  await assertListOwner(userId, listId);

  const key = normalizeIngredient(input.ingredient_name);

  // Merge into an existing unchecked line for the same ingredient.
  const [existing] = (await db
    .select()
    .from(groceryListItems)
    .where(and(eq(groceryListItems.groceryListId, listId), eq(groceryListItems.normalizedKey, key), eq(groceryListItems.isChecked, false)))
    .limit(1)) as GroceryListItem[];

  if (existing) {
    const merged =
      existing.quantity != null && input.quantity != null && (existing.unit ?? null) === (input.unit ?? null)
        ? round2(existing.quantity + input.quantity)
        : existing.quantity;

    const [updated] = await db
      .update(groceryListItems)
      .set({
        quantity: merged,
        unit: input.unit ?? existing.unit,
        estimatedCost: round2(estimatePriceUsd(existing.ingredientName, merged, input.unit ?? existing.unit)),
        updatedAt: new Date(),
      })
      .where(eq(groceryListItems.id, existing.id))
      .returning();

    await afterItemsChanged(listId);
    return groceryItemToDto(updated as GroceryListItem);
  }

  const quantity = input.quantity ?? 1;
  const estimated = input.estimated_price ?? round2(estimatePriceUsd(input.ingredient_name, quantity, input.unit ?? null));

  const [row] = await db
    .insert(groceryListItems)
    .values({
      groceryListId: listId,
      ingredientName: input.ingredient_name.slice(0, 100),
      normalizedKey: key,
      category: (input.category ?? inferCategory(input.ingredient_name)) as GroceryListItem['category'],
      quantity,
      unit: input.unit ?? null,
      estimatedPrice: estimated,
      estimatedCost: estimated,
      isChecked: false,
      inPantry: false,
      neededForRecipes: (input.needed_for_recipes ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
      fromRecipes: (input.needed_for_recipes ?? []).filter((id) => !/^[0-9a-f-]{36}$/i.test(id)).slice(0, 6),
      sortOrder: await countItems(listId),
    })
    .returning();

  await afterItemsChanged(listId);
  return groceryItemToDto(row as GroceryListItem);
}

export async function updateGroceryItem(
  userId: string,
  listId: string,
  itemId: string,
  input: UpdateGroceryItemInput,
): Promise<GroceryListItemDto> {
  const db = getDb();
  await assertListOwner(userId, listId);

  const [row] = (await db
    .select()
    .from(groceryListItems)
    .where(and(eq(groceryListItems.id, itemId), eq(groceryListItems.groceryListId, listId)))
    .limit(1)) as GroceryListItem[];
  if (!row) throw new NotFoundError('Item not found');

  const quantity = input.quantity ?? row.quantity;
  const unit = input.unit !== undefined ? input.unit : row.unit;
  const name = input.ingredient_name ?? row.ingredientName;
  const checked = input.is_purchased ?? row.isChecked;

  const [updated] = await db
    .update(groceryListItems)
    .set({
      ingredientName: name.slice(0, 100),
      normalizedKey: normalizeIngredient(name),
      quantity,
      unit,
      cheapestStore: input.cheapest_store ?? row.cheapestStore,
      actualPrice: input.actual_price ?? row.actualPrice,
      estimatedCost: round2(estimatePriceUsd(name, quantity, unit)),
      isChecked: checked,
      purchasedAt: checked && !row.isChecked ? new Date() : checked ? row.purchasedAt : null,
      updatedAt: new Date(),
    })
    .where(eq(groceryListItems.id, itemId))
    .returning();

  await afterItemsChanged(listId);
  return groceryItemToDto(updated as GroceryListItem);
}

export async function toggleGroceryItem(userId: string, listId: string, itemId: string, checked: boolean): Promise<GroceryListItemDto> {
  return updateGroceryItem(userId, listId, itemId, { is_purchased: checked });
}

export async function removeGroceryItem(userId: string, listId: string, itemId: string): Promise<{ deleted: boolean }> {
  const db = getDb();
  await assertListOwner(userId, listId);
  const rows = await db
    .delete(groceryListItems)
    .where(and(eq(groceryListItems.id, itemId), eq(groceryListItems.groceryListId, listId)))
    .returning({ id: groceryListItems.id });
  await afterItemsChanged(listId);
  return { deleted: rows.length > 0 };
}

export async function removeCheckedItems(userId: string, listId: string): Promise<GroceryListDto> {
  const db = getDb();
  await assertListOwner(userId, listId);
  await db.delete(groceryListItems).where(and(eq(groceryListItems.groceryListId, listId), eq(groceryListItems.isChecked, true)));
  await afterItemsChanged(listId);
  return getGroceryList(userId, listId);
}

export async function updateGroceryList(userId: string, listId: string, input: UpdateGroceryListInput): Promise<GroceryListDto> {
  const db = getDb();
  await assertListOwner(userId, listId);

  await db
    .update(groceryLists)
    .set({
      title: input.title ?? undefined,
      status: input.status ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(groceryLists.id, listId));

  if (input.mark_all_purchased !== undefined) {
    await db
      .update(groceryListItems)
      .set({ isChecked: input.mark_all_purchased, purchasedAt: input.mark_all_purchased ? new Date() : null, updatedAt: new Date() })
      .where(eq(groceryListItems.groceryListId, listId));
  }

  await afterItemsChanged(listId);
  return getGroceryList(userId, listId);
}

export async function clearGroceryList(userId: string, listId: string): Promise<GroceryListDto> {
  const db = getDb();
  await assertListOwner(userId, listId);
  await db.delete(groceryListItems).where(eq(groceryListItems.groceryListId, listId));
  await afterItemsChanged(listId);
  return getGroceryList(userId, listId);
}

export async function deleteGroceryList(userId: string, listId: string): Promise<void> {
  const db = getDb();
  await assertListOwner(userId, listId);
  await db.transaction(async (tx) => {
    await tx.delete(groceryListItems).where(eq(groceryListItems.groceryListId, listId));
    await tx.delete(groceryLists).where(eq(groceryLists.id, listId));
  });
  await Promise.all([cache.del(CacheKeys.groceryList(listId)), cache.del(CacheKeys.groceryPrices(listId))]);
}

async function assertListOwner(userId: string, listId: string): Promise<GroceryList> {
  const db = getDb();
  const [row] = await db.select().from(groceryLists).where(and(eq(groceryLists.id, listId), eq(groceryLists.userId, userId))).limit(1);
  if (!row) throw new NotFoundError('Grocery list not found');
  return row as GroceryList;
}

async function countItems(listId: string): Promise<number> {
  const db = getDb();
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(groceryListItems).where(eq(groceryListItems.groceryListId, listId));
  return Number(rows[0]?.count ?? 0);
}

/** Keep the header counters in sync after any item mutation. */
async function afterItemsChanged(listId: string): Promise<void> {
  const db = getDb();
  const [summary] = await db
    .select({
      total: sql<number>`count(*)::int`,
      checked: sql<number>`count(*) FILTER (WHERE ${groceryListItems.isChecked})::int`,
      cost: sql<number>`COALESCE(SUM(${groceryListItems.estimatedCost}), 0)::numeric`,
    })
    .from(groceryListItems)
    .where(eq(groceryListItems.groceryListId, listId));

  await db
    .update(groceryLists)
    .set({
      totalItems: Number(summary?.total ?? 0),
      totalChecked: Number(summary?.checked ?? 0),
      totalEstimatedCost: round2(Number(summary?.cost ?? 0)),
      updatedAt: new Date(),
    })
    .where(eq(groceryLists.id, listId));

  await cache.del(CacheKeys.groceryList(listId));
}

// ---------------------------------------------------------------------------
// Price comparison
// ---------------------------------------------------------------------------

/** Force a fresh multi-store price pass over every line of the list. */
export async function refreshPrices(userId: string, listId: string): Promise<PriceComparisonDto> {
  const db = getDb();
  const list = await assertListOwner(userId, listId);

  const user = await getUserById(userId);
  const limits = getPlanLimits(user?.subscriptionTier ?? 'free');
  if (!limits.priceComparison) {
    throw new BadRequestError('Price comparison is a Premium feature. Upgrade to compare prices across stores.');
  }

  const itemRows = (await db
    .select()
    .from(groceryListItems)
    .where(eq(groceryListItems.groceryListId, listId))
    .orderBy(asc(groceryListItems.sortOrder))) as GroceryListItem[];

  if (!itemRows.length) {
    return {
      grocery_list_id: listId,
      meal_plan_id: list.mealPlanId ?? null,
      checked_at: new Date().toISOString(),
      single_store_total: 0,
      optimized_total: 0,
      saved: 0,
      percent: 0,
      best_store: null,
      per_store: [],
      deals: [],
    };
  }

  const lookups = await lookupPricesBatch(
    itemRows.map((i) => ({ name: i.ingredientName, quantity: i.quantity, unit: i.unit })),
    { userId, force: true },
  );

  const aggregated: AggregatedItem[] = [];

  for (const row of itemRows) {
    const lookup = lookups.get(row.ingredientName);
    const storePrices = lookup?.storePrices ?? [];
    const cheapest = lookup?.cheapest ?? null;
    const lineCost = cheapest ? round2(cheapest.price * (row.quantity ?? 1)) : round2(estimatePriceUsd(row.ingredientName, row.quantity, row.unit));

    // eslint-disable-next-line no-await-in-loop
    await db
      .update(groceryListItems)
      .set({
        storePrices,
        cheapestStore: cheapest?.store ?? row.cheapestStore,
        cheapestPrice: cheapest ? round2(cheapest.price) : row.cheapestPrice,
        estimatedCost: lineCost,
        estimatedPrice: lineCost,
        priceCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(groceryListItems.id, row.id));

    aggregated.push({
      key: row.normalizedKey,
      name: row.ingredientName,
      quantity: row.quantity ?? 1,
      unit: row.unit,
      category: row.category ?? 'other',
      recipeIds: [],
      recipeTitles: [],
      inPantry: row.inPantry,
      estimatedCost: lineCost,
      storePrices,
      cheapest,
    });
  }

  const savings = computeSavings(aggregated.map((i) => ({ name: i.name, prices: i.storePrices })));
  const totalCost = round2(aggregated.reduce((sum, i) => sum + i.estimatedCost, 0));

  await db
    .update(groceryLists)
    .set({
      totalEstimatedCost: totalCost,
      savingsAmount: savings.saved,
      cheapestStore: bestStore(aggregated),
      pricesFetchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(groceryLists.id, listId));

  const comparison: PriceComparisonDto = {
    grocery_list_id: listId,
    meal_plan_id: list.mealPlanId ?? null,
    checked_at: new Date().toISOString(),
    single_store_total: savings.singleStoreTotal,
    optimized_total: savings.optimizedTotal,
    saved: savings.saved,
    percent: savings.percent,
    best_store: bestStore(aggregated),
    per_store: perStoreTotals(aggregated),
    deals: dealsFor(aggregated).map((deal, index) => ({ ...deal, item_id: itemRows[index]?.id ?? '' })),
  };

  await cache.set(CacheKeys.groceryPrices(listId), comparison, CACHE_TTL_SECONDS.groceryPrices);
  await cache.del(CacheKeys.groceryList(listId));

  logger.info({ userId, listId, items: aggregated.length, saved: savings.saved, best: comparison.best_store }, 'Grocery prices refreshed');

  return comparison;
}

// ---------------------------------------------------------------------------
// Export / hand-off to a delivery provider
// ---------------------------------------------------------------------------

const PROVIDER_URLS: Record<OrderGroceryListInput['provider'], string> = {
  instacart: 'https://www.instacart.com/store?query=',
  amazon_fresh: 'https://www.amazon.com/fresh?k=',
  walmart: 'https://www.walmart.com/search?q=',
  kroger: 'https://www.kroger.com/search?query=',
  pandago: 'https://pandago.ph/search?q=',
  generic: 'https://www.google.com/search?q=grocery+delivery+',
};

export async function buildOrderHandoff(
  userId: string,
  listId: string,
  input: OrderGroceryListInput,
): Promise<OrderGroceryListResponse> {
  const db = getDb();
  const list = await assertListOwner(userId, listId);

  const itemRows = (await db
    .select()
    .from(groceryListItems)
    .where(and(eq(groceryListItems.groceryListId, listId), eq(groceryListItems.isChecked, false)))
    .orderBy(asc(groceryListItems.sortOrder))) as GroceryListItem[];

  const grouped =
    input.group_by === 'store'
      ? groupBy(itemRows, (i) => i.cheapestStore ?? 'Any store')
      : groupBy(itemRows, (i) => (i.category ?? 'other').replace(/_/g, ' '));

  const shareText = [
    `${list.title ?? 'Shopping list'} — ${toIsoDate(todayUtc())}`,
    '',
    ...[...grouped.entries()].flatMap(([heading, rows]) => [
      heading.toUpperCase(),
      ...rows.map((row) => `☐ ${formatQuantity(row.quantity, row.unit)} ${row.ingredientName}`),
      '',
    ]),
    `Estimated total: $${round2(Number(list.totalEstimatedCost ?? 0)).toFixed(2)}`,
    Number(list.savingsAmount) > 0 ? `You could save $${round2(Number(list.savingsAmount)).toFixed(2)} by splitting stores.` : '',
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')
    .trim();

  const query = itemRows.map((i) => i.ingredientName).join(', ');
  const base = PROVIDER_URLS[input.provider] ?? PROVIDER_URLS.generic;

  return {
    provider: input.provider,
    url: `${base}${encodeURIComponent(query).slice(0, 1800)}`,
    item_count: itemRows.length,
    estimated_total: round2(Number(list.totalEstimatedCost ?? 0)),
    share_text: shareText,
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** Nightly cron helper: drop price caches so tomorrow's lookups are fresh. */
export async function invalidatePriceCaches(): Promise<void> {
  await cache.delPattern('prices:*');
}

