import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PantryItemDto, PantryStatsDto } from '@platematch/shared';
import {
  createTestUser,
  data,
  isDatabaseAvailable,
  seedPantry,
  startHarness,
  stopHarness,
  type Harness,
  type TestUser,
} from './helpers/harness.js';

/**
 * Pantry CRUD, expiry maths and quota enforcement.
 *
 * The pantry is the input to everything else — recipe ranking, meal planning,
 * grocery subtraction, expiry alerts — so the invariants tested here (urgency
 * buckets, estimated expiry dates, the free-tier item cap) propagate everywhere.
 */

let harness: Harness | null = null;
const available = await isDatabaseAvailable();

describe.skipIf(!available)('pantry', () => {
  let user: TestUser;

  beforeAll(async () => {
    harness = await startHarness();
    user = await createTestUser(harness!);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  describe('POST /pantry', () => {
    it('creates an item and computes the expiry fields', async () => {
      const expiry = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

      const response = await harness!.post(
        '/api/v1/pantry',
        {
          ingredient_name: 'Baby Spinach',
          quantity: 200,
          unit: 'g',
          category: 'vegetable',
          expiry_date: expiry,
          location: 'fridge',
          added_via: 'manual',
        },
        user.accessToken,
      );

      expect(response.statusCode).toBe(201);

      const item = data<PantryItemDto>(response);
      expect(item.id).toBeTruthy();
      expect(item.ingredient_name).toBe('Baby Spinach');
      expect(item.quantity).toBe(200);
      expect(item.unit).toBe('g');
      expect(item.category).toBe('vegetable');
      expect(item.expiry_date).toBe(expiry);
      expect(item.location).toBe('fridge');

      // Derived, not supplied by the client.
      expect(item.days_until_expiry).toBe(3);
      expect(item.urgency).toBe('soon');
      expect(item.expiry_label).toMatch(/3 days/i);
      expect(item.is_expired).toBe(false);
      expect(item.is_used).toBe(false);
    });

    it('estimates an expiry date when none is given', async () => {
      // The whole point of the shelf-life table: a user adds "milk" and still
      // gets an expiry alert in a week rather than never.
      const response = await harness!.post(
        '/api/v1/pantry',
        { ingredient_name: 'whole milk', quantity: 1, unit: 'l', category: 'dairy', location: 'fridge' },
        user.accessToken,
      );

      expect(response.statusCode).toBe(201);
      const item = data<PantryItemDto>(response);

      expect(item.expiry_date).toBeTruthy();
      expect(item.days_until_expiry).not.toBeNull();
      expect(item.days_until_expiry!).toBeGreaterThan(0);
      expect(item.days_until_expiry!).toBeLessThanOrEqual(14);
    });

    it('infers the category when the client does not send one', async () => {
      const response = await harness!.post(
        '/api/v1/pantry',
        { ingredient_name: 'chicken breast', quantity: 500, unit: 'g', location: 'fridge' },
        user.accessToken,
      );

      expect(response.statusCode).toBe(201);
      expect(data<PantryItemDto>(response).category).toBe('meat');
    });

    it('marks a past date as already expired', async () => {
      const past = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

      const response = await harness!.post(
        '/api/v1/pantry',
        { ingredient_name: 'old yoghurt', quantity: 1, unit: 'pieces', expiry_date: past, location: 'fridge' },
        user.accessToken,
      );

      expect(response.statusCode).toBe(201);
      const item = data<PantryItemDto>(response);

      expect(item.is_expired).toBe(true);
      expect(item.urgency).toBe('expired');
      expect(item.days_until_expiry!).toBeLessThan(0);
      expect(item.expiry_label).toMatch(/ago/i);
    });

    it('rejects an empty name with 422', async () => {
      const response = await harness!.post(
        '/api/v1/pantry',
        { ingredient_name: '   ', quantity: 1, unit: 'pieces' },
        user.accessToken,
      );
      expect(response.statusCode).toBe(422);
    });

    it('rejects a negative quantity with 422', async () => {
      const response = await harness!.post(
        '/api/v1/pantry',
        { ingredient_name: 'rice', quantity: -5, unit: 'g' },
        user.accessToken,
      );
      expect(response.statusCode).toBe(422);
    });

    it('rejects an unknown category with 422', async () => {
      const response = await harness!.post(
        '/api/v1/pantry',
        { ingredient_name: 'mystery', quantity: 1, unit: 'pieces', category: 'unobtainium' },
        user.accessToken,
      );
      expect(response.statusCode).toBe(422);
    });

    it('requires authentication', async () => {
      const response = await harness!.post('/api/v1/pantry', { ingredient_name: 'rice', quantity: 1, unit: 'g' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /pantry', () => {
    it('returns only the caller’s items', async () => {
      const other = await createTestUser(harness!);
      await seedPantry(harness!, other.accessToken, [{ name: 'someone elses caviar' }]);

      const list = data<PantryItemDto[]>(await harness!.get('/api/v1/pantry', user.accessToken));

      expect(list.length).toBeGreaterThan(0);
      expect(list.some((item) => item.ingredient_name.includes('caviar'))).toBe(false);
    });

    it('paginates with the documented meta envelope', async () => {
      const response = await harness!.get('/api/v1/pantry?page=1&limit=2', user.accessToken);
      expect(response.statusCode).toBe(200);

      const body = response.json() as { data: PantryItemDto[]; meta: { page: number; limit: number; total: number; has_more: boolean } };
      expect(body.data.length).toBeLessThanOrEqual(2);
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(2);
      expect(body.meta.total).toBeGreaterThanOrEqual(body.data.length);
    });

    it('filters by search term', async () => {
      await seedPantry(harness!, user.accessToken, [{ name: 'unique testcardamom pod' }]);

      const list = data<PantryItemDto[]>(await harness!.get('/api/v1/pantry?q=testcardamom', user.accessToken));
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((item) => item.ingredient_name.toLowerCase().includes('testcardamom'))).toBe(true);
    });

    it('filters by location', async () => {
      await seedPantry(harness!, user.accessToken, [{ name: 'frozen testpeas', unit: 'g', quantity: 300 }]);

      const list = data<PantryItemDto[]>(await harness!.get('/api/v1/pantry?location=freezer', user.accessToken));
      expect(list.every((item) => item.location === 'freezer')).toBe(true);
    });

    it('rejects an out-of-range limit instead of returning the whole table', async () => {
      // `listPantryQuerySchema` caps limit at 200 and OpenAPI documents that
      // maximum, so an out-of-range value is a client bug. Saying so explicitly
      // beats silently clamping and hiding the mistake.
      const response = await harness!.get('/api/v1/pantry?limit=100000', user.accessToken);
      expect(response.statusCode).toBe(422);

      // The documented maximum itself must still be accepted.
      const atMax = await harness!.get('/api/v1/pantry?limit=200', user.accessToken);
      expect(atMax.statusCode).toBe(200);
      expect((atMax.json() as { meta: { limit: number } }).meta.limit).toBe(200);
    });

    it('sorts by expiry ascending by default', async () => {
      const list = data<PantryItemDto[]>(await harness!.get('/api/v1/pantry?sort=expiry_date&order=asc', user.accessToken));
      const dates = list.map((item) => item.expiry_date).filter((value): value is string => Boolean(value));

      for (let i = 1; i < dates.length; i += 1) {
        expect(dates[i]! >= dates[i - 1]!).toBe(true);
      }
    });
  });

  describe('GET /pantry/expiring-soon and /expired', () => {
    it('returns only items inside the horizon', async () => {
      const fresh = await createTestUser(harness!);
      await seedPantry(harness!, fresh.accessToken, [
        { name: 'expires tomorrow milk', expiresInDays: 1 },
        { name: 'expires next year rice', expiresInDays: 300 },
      ]);

      const list = data<PantryItemDto[]>(await harness!.get('/api/v1/pantry/expiring-soon?days=3', fresh.accessToken));

      expect(list.some((item) => item.ingredient_name.includes('tomorrow'))).toBe(true);
      expect(list.some((item) => item.ingredient_name.includes('next year'))).toBe(false);
      expect(list.every((item) => (item.days_until_expiry ?? 99) <= 3)).toBe(true);
    });

    it('lists expired items separately', async () => {
      const list = data<PantryItemDto[]>(await harness!.get('/api/v1/pantry/expired', user.accessToken));
      expect(list.every((item) => item.is_expired)).toBe(true);
    });
  });

  describe('GET /pantry/stats', () => {
    it('reports counts and estimated value', async () => {
      const stats = data<PantryStatsDto>(await harness!.get('/api/v1/pantry/stats', user.accessToken));

      expect(stats.total_items).toBeGreaterThan(0);
      expect(stats.expiring_soon).toBeGreaterThanOrEqual(0);
      expect(stats.expired).toBeGreaterThanOrEqual(0);
      // Priced from the shared price index. The Pantry screen renders this as
      // "Estimated value", and it used to be a hard-coded 0 — every user saw
      // $0.00 no matter what was on their shelves.
      expect(stats.total_estimated_value).toBeGreaterThan(0);
      // The screen's "oldest item" line reads this; it was hard-coded null.
      expect(stats.oldest_item).not.toBeNull();
      expect(stats.oldest_item!.ingredient_name).toBeTruthy();
      expect(stats.oldest_item!.days).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(stats.by_category)).toBe(true);
      expect(Array.isArray(stats.by_location)).toBe(true);
    });
  });

  describe('PATCH /pantry/:id', () => {
    it('updates quantity and expiry together', async () => {
      const [id] = await seedPantry(harness!, user.accessToken, [{ name: 'patchable eggs', quantity: 6, unit: 'pieces' }]);
      const nextExpiry = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);

      const response = await harness!.patch(
        `/api/v1/pantry/${id}`,
        { quantity: 3, expiry_date: nextExpiry },
        user.accessToken,
      );

      expect(response.statusCode).toBe(200);
      const item = data<PantryItemDto>(response);
      expect(item.quantity).toBe(3);
      expect(item.expiry_date).toBe(nextExpiry);
      // Derived fields must be recomputed, not left stale.
      expect(item.days_until_expiry).toBe(9);
      expect(item.urgency).toBe('ok');
    });

    it('marks an item used', async () => {
      const [id] = await seedPantry(harness!, user.accessToken, [{ name: 'use me butter' }]);

      const response = await harness!.patch(`/api/v1/pantry/${id}`, { is_used: true }, user.accessToken);
      expect(response.statusCode).toBe(200);

      const item = data<PantryItemDto>(response);
      expect(item.is_used).toBe(true);

      // The change must be persisted, not just echoed back in the response.
      const list = (await harness!.get('/api/v1/pantry?used=true&limit=100', user.accessToken)).json() as {
        data: PantryItemDto[];
      };
      expect(list.data.some((row) => row.id === id && row.is_used)).toBe(true);
    });

    it('returns 404 for another user’s item', async () => {
      const other = await createTestUser(harness!);
      const [theirId] = await seedPantry(harness!, other.accessToken, [{ name: 'not yours saffron' }]);

      const response = await harness!.patch(`/api/v1/pantry/${theirId}`, { quantity: 99 }, user.accessToken);

      // 404, not 403: revealing that the row exists leaks another user's data.
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for a nonexistent id', async () => {
      const response = await harness!.patch('/api/v1/pantry/00000000-0000-4000-8000-000000000000', { quantity: 1 }, user.accessToken);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /pantry/:id', () => {
    it('removes the item', async () => {
      const [id] = await seedPantry(harness!, user.accessToken, [{ name: 'delete me bay leaf' }]);

      const removed = await harness!.delete(`/api/v1/pantry/${id}`, user.accessToken);
      expect([200, 204]).toContain(removed.statusCode);

      const gone = await harness!.patch(`/api/v1/pantry/${id}`, { quantity: 1 }, user.accessToken);
      expect(gone.statusCode).toBe(404);
    });
  });

  describe('POST /pantry/batch-use', () => {
    it('marks several items used at once', async () => {
      const ids = await seedPantry(harness!, user.accessToken, [
        { name: 'batch tomato one' },
        { name: 'batch tomato two' },
      ]);

      const response = await harness!.post('/api/v1/pantry/batch-use', { ids }, user.accessToken);
      expect(response.statusCode).toBe(200);

      const body = data<{ updated: number }>(response);
      expect(body.updated).toBe(2);
    });

    it('ignores ids belonging to another user', async () => {
      const other = await createTestUser(harness!);
      const [theirId] = await seedPantry(harness!, other.accessToken, [{ name: 'untouchable truffle' }]);

      const response = await harness!.post('/api/v1/pantry/batch-use', { ids: [theirId] }, user.accessToken);
      expect(response.statusCode).toBe(200);
      expect(data<{ updated: number }>(response).updated).toBe(0);
    });

    it('rejects an empty id list with 422', async () => {
      const response = await harness!.post('/api/v1/pantry/batch-use', { ids: [] }, user.accessToken);
      expect(response.statusCode).toBe(422);
    });
  });

  describe('free-tier quota', () => {
    it('enforces the pantry item cap for free users', async () => {
      const capped = await createTestUser(harness!, { fullName: 'Capped User' });

      // PLAN_LIMITS.free.maxPantryItems is 50; seed to the cap and then one more.
      const many = Array.from({ length: 50 }, (_, index) => ({ name: `quota filler ${index}` }));
      await seedPantry(harness!, capped.accessToken, many);

      const over = await harness!.post(
        '/api/v1/pantry',
        { ingredient_name: 'one too many', quantity: 1, unit: 'pieces' },
        capped.accessToken,
      );

      expect(over.statusCode).toBe(402);
      const body = over.json() as { error: string; message: string };
      expect(body.error).toBe('quota_exceeded');
      // The message must tell the user how to fix it, not just that they failed.
      expect(body.message.toLowerCase()).toMatch(/upgrade|premium|limit/);
    });
  });
});
