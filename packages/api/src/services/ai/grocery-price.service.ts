import { CACHE_TTL_SECONDS } from '@platematch/shared';
import { env, hasKrogerKeys, hasSpoonacularKey } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { CacheKeys, cache, cached } from '../../lib/redis.js';
import { stableHash } from '../../lib/crypto.js';
import { fetchJson } from './http.js';
import { krogerCost, spoonacularCost } from './cost.js';
import { recordAiUsage } from './ledger.js';
import { estimatePriceUsd, normalizeIngredient, round2 } from '../../utils/food.js';

/**
 * Grocery price comparison (Section 2 — Grocery Price Data)
 * ===========================================================================
 * Primary:    Kroger Developer API (OAuth2 client-credentials → product search)
 * Secondary:  Spoonacular Grocery Products
 * Tertiary:   built-in price index (always available, keeps the app useful
 *             with zero credentials)
 *
 * All lookups are cached in Redis for 24 hours and refreshed by a nightly cron
 * (`jobs/crons.ts`). Prices are returned per store so the client can show the
 * "cheapest store" badge and the potential-savings banner.
 */

export interface StorePrice {
  store: string;
  price: number;
  currency: string;
  in_stock: boolean;
  url?: string | null;
  fetched_at: string;
}

export interface PriceLookupResult {
  ingredient: string;
  normalized: string;
  /** Quantity the price refers to (e.g. per kg / per piece). */
  quantity: number | null;
  unit: string | null;
  /** Price for the requested quantity, per store. */
  storePrices: StorePrice[];
  cheapest: StorePrice | null;
  /** Estimated price when no store data exists. */
  estimatedPrice: number;
  source: 'kroger' | 'spoonacular' | 'estimate' | 'mixed';
}

// ---------------------------------------------------------------------------
// Kroger
// ---------------------------------------------------------------------------

interface KrogerTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface KrogerProductResponse {
  data?: {
    items?: Array<{
      productId?: string;
      title?: string;
      brand?: string;
      favorite?: { salePrice?: string; regularPrice?: string };
      price?: { salePrice?: string; regularPrice?: string };
      inventory?: { stockLevel?: string };
      size?: string;
      temperature?: { indicator?: string };
    }>;
  };
}

let krogerToken: { token: string; expiresAt: number } | null = null;

async function getKrogerToken(): Promise<string | null> {
  if (!hasKrogerKeys) return null;
  if (krogerToken && krogerToken.expiresAt > Date.now() + 30_000) return krogerToken.token;

  const cachedToken = await cached<KrogerTokenResponse | null>(CacheKeys.krogerToken(), 30 * 60, async () => {
    const credentials = Buffer.from(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`).toString('base64');
    try {
      const { data } = await fetchJson<KrogerTokenResponse>('https://api.kroger.com/v1/connect/oauth2/token', {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}` },
        rawBody: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        timeoutMs: 15_000,
        retries: 1,
        label: 'kroger:oauth',
      });
      return data;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Kroger OAuth failed');
      return null;
    }
  });

  if (!cachedToken?.access_token) return null;

  krogerToken = {
    token: cachedToken.access_token,
    expiresAt: Date.now() + (cachedToken.expires_in ?? 1800) * 1000,
  };
  return krogerToken.token;
}

async function searchKroger(query: string, userId?: string | null): Promise<StorePrice[]> {
  const token = await getKrogerToken();
  if (!token) return [];

  const started = Date.now();
  const params = new URLSearchParams({
    'filter.term': query,
    'filter.limit': '5',
    'filter.brand': 'false',
  });
  if (env.KROGER_DEFAULT_LOCATION_ID) params.set('filter.locationId', env.KROGER_DEFAULT_LOCATION_ID);

  try {
    const { data } = await fetchJson<KrogerProductResponse>(`https://api.kroger.com/v1/products?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
      retries: 1,
      label: 'kroger:products',
    });

    recordAiUsage({
      userId: userId ?? null,
      task: 'prices',
      provider: 'kroger',
      model: 'product-search',
      success: true,
      latencyMs: Date.now() - started,
      usage: { costUsd: krogerCost() },
    });

    const items = data.data?.items ?? [];
    return items
      .map((item): StorePrice | null => {
        const sale = Number.parseFloat(item.price?.salePrice ?? item.favorite?.salePrice ?? '');
        const regular = Number.parseFloat(item.price?.regularPrice ?? item.favorite?.regularPrice ?? '');
        const price = Number.isFinite(sale) && sale > 0 ? sale : Number.isFinite(regular) ? regular : NaN;
        if (!Number.isFinite(price)) return null;
        return {
          store: 'Kroger',
          price: round2(price),
          currency: 'USD',
          in_stock: (item.inventory?.stockLevel ?? 'AVAILABLE') !== 'UNAVAILABLE',
          url: item.productId ? `https://www.kroger.com/p/${item.productId}` : null,
          fetched_at: new Date().toISOString(),
        };
      })
      .filter((p): p is StorePrice => p !== null)
      .slice(0, 3);
  } catch (err) {
    logger.warn({ err: (err as Error).message, query }, 'Kroger search failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Spoonacular
// ---------------------------------------------------------------------------

interface SpoonacularProductResponse {
  products?: Array<{
    id?: number;
    title?: string;
    price?: number;
    checkedPrice?: number;
    usdaCode?: string;
  }>;
}

async function searchSpoonacular(query: string, userId?: string | null): Promise<StorePrice[]> {
  if (!hasSpoonacularKey) return [];

  const started = Date.now();
  try {
    const params = new URLSearchParams({ query, pageSize: '3', apiKey: env.SPOONACULAR_API_KEY as string });
    const { data } = await fetchJson<SpoonacularProductResponse>(
      `${env.SPOONACULAR_BASE_URL}/food/products/search?${params.toString()}`,
      { method: 'GET', timeoutMs: 15_000, retries: 1, label: 'spoonacular:products' },
    );

    recordAiUsage({
      userId: userId ?? null,
      task: 'prices',
      provider: 'spoonacular',
      model: 'grocery-products',
      success: true,
      latencyMs: Date.now() - started,
      usage: { costUsd: spoonacularCost() },
    });

    return (data.products ?? [])
      .map((product): StorePrice | null => {
        const price = product.checkedPrice ?? product.price;
        if (typeof price !== 'number' || price <= 0) return null;
        return {
          store: 'Walmart',
          price: round2(price),
          currency: 'USD',
          in_stock: true,
          url: product.id ? `https://spoonacular.com/products/${product.id}` : null,
          fetched_at: new Date().toISOString(),
        };
      })
      .filter((p): p is StorePrice => p !== null);
  } catch (err) {
    logger.warn({ err: (err as Error).message, query }, 'Spoonacular search failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Built-in estimate (always available)
// ---------------------------------------------------------------------------

/** Named stores the estimator spreads across, so the UI has a comparison. */
const ESTIMATED_STORES = [
  { store: 'Local Market', factor: 1.0 },
  { store: 'Aldi', factor: 0.86 },
  { store: 'Walmart', factor: 0.92 },
  { store: 'Whole Foods', factor: 1.18 },
];

function estimateStorePrices(name: string, quantity: number | null, unit: string | null): StorePrice[] {
  const base = estimatePriceUsd(name, quantity, unit);
  if (base <= 0) return [];
  return ESTIMATED_STORES.map(({ store, factor }) => ({
    store,
    // Small deterministic per-item variation so totals differ realistically.
    price: round2(base * factor * (1 + ((name.length % 5) - 2) / 100)),
    currency: 'USD',
    in_stock: true,
    url: null,
    fetched_at: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LookupOptions {
  quantity?: number | null;
  unit?: string | null;
  /** Skip live providers (free tier / offline). */
  skipLive?: boolean;
  /** Bypass the 24 h cache and re-query the stores. */
  force?: boolean;
  userId?: string | null;
}

/** Look up prices for a single ingredient across all configured stores. */
export async function lookupPrices(ingredient: string, options: LookupOptions = {}): Promise<PriceLookupResult> {
  const normalized = normalizeIngredient(ingredient);
  const quantity = options.quantity ?? null;
  const unit = options.unit ?? null;
  const skipLive = options.skipLive ?? false;

  const cacheKey = CacheKeys.groceryPrices(stableHash({ n: normalized, q: quantity, u: unit }));

  // An explicit refresh (the user tapped "Compare prices") must not be served
  // a 24-hour-old snapshot.
  if (options.force) await cache.del(cacheKey);

  return cached(cacheKey, CACHE_TTL_SECONDS.groceryPrices, async () => {
    const storePrices: StorePrice[] = [];

    if (!skipLive) {
      if (hasKrogerKeys) storePrices.push(...(await searchKroger(normalized, options.userId)));
      if (hasSpoonacularKey) storePrices.push(...(await searchSpoonacular(normalized, options.userId)));
    }

    // Always include estimates so the list is never empty.
    const estimates = estimateStorePrices(normalized, quantity, unit);
    const knownStores = new Set(storePrices.map((p) => p.store));
    for (const estimate of estimates) {
      if (!knownStores.has(estimate.store)) storePrices.push(estimate);
    }

    const cheapest = storePrices.length
      ? storePrices.reduce((min, p) => (p.price < min.price ? p : min), storePrices[0] as StorePrice)
      : null;

    const source: PriceLookupResult['source'] =
      storePrices.length === 0
        ? 'estimate'
        : skipLive
          ? 'estimate'
          : hasKrogerKeys || hasSpoonacularKey
            ? 'mixed'
            : 'estimate';

    return {
      ingredient,
      normalized,
      quantity,
      unit,
      storePrices: storePrices.sort((a, b) => a.price - b.price),
      cheapest,
      estimatedPrice: cheapest?.price ?? round2(estimatePriceUsd(normalized, quantity, unit)),
      source,
    } satisfies PriceLookupResult;
  });
}

export interface BatchPriceInput {
  name: string;
  quantity?: number | null;
  unit?: string | null;
}

/** Batch lookup with bounded concurrency. */
export async function lookupPricesBatch(
  items: BatchPriceInput[],
  options: LookupOptions = {},
  concurrency = 5,
): Promise<Map<string, PriceLookupResult>> {
  const results = new Map<string, PriceLookupResult>();
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index;
      index += 1;
      const item = items[current] as BatchPriceInput;
      try {
        results.set(item.name, await lookupPrices(item.name, { ...options, quantity: item.quantity, unit: item.unit }));
      } catch (err) {
        logger.warn({ err: (err as Error).message, item: item.name }, 'Price lookup failed');
        results.set(item.name, {
          ingredient: item.name,
          normalized: normalizeIngredient(item.name),
          quantity: item.quantity ?? null,
          unit: item.unit ?? null,
          storePrices: [],
          cheapest: null,
          estimatedPrice: round2(estimatePriceUsd(item.name, item.quantity ?? null, item.unit ?? null)),
          source: 'estimate',
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return results;
}

/**
 * Savings from routing each item to its cheapest store instead of buying
 * everything at one (the most expensive) store.
 */
export function computeSavings(items: Array<{ name: string; prices: StorePrice[] }>): {
  singleStoreTotal: number;
  optimizedTotal: number;
  saved: number;
  percent: number;
} {
  let singleStoreTotal = 0;
  let optimizedTotal = 0;

  for (const item of items) {
    if (!item.prices.length) continue;
    const max = Math.max(...item.prices.map((p) => p.price));
    const min = Math.min(...item.prices.map((p) => p.price));
    singleStoreTotal += max;
    optimizedTotal += min;
  }

  const saved = Math.max(0, round2(singleStoreTotal - optimizedTotal));
  return {
    singleStoreTotal: round2(singleStoreTotal),
    optimizedTotal: round2(optimizedTotal),
    saved,
    percent: singleStoreTotal > 0 ? Math.round((saved / singleStoreTotal) * 100) : 0,
  };
}

/** Invalidate the 24-hour price cache (nightly cron). */
export async function refreshPriceCache(): Promise<void> {
  const { cache } = await import('../../lib/redis.js');
  await cache.delPattern(`${CacheKeys.groceryPrices('')}*`);
  logger.info('Grocery price cache invalidated');
}
