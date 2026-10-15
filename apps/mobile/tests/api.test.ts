import { describe, expect, it, vi } from 'vitest';

/**
 * HTTP-client helpers that decide whether a list screen renders anything.
 *
 * These two functions are the whole reason a screen either shows its data or
 * silently shows an empty state, so they are pinned here:
 *
 * - `buildQuery` must turn a boolean into `true`/`false`, because the API's
 *   `use_pantry` filter is an *enum of strings* — sending `1`/`0` would 422.
 * - `normalizePage` must read the `{ data, meta }` envelope every list endpoint
 *   returns. When `/recipes` flattened its pagination instead, screens reading
 *   `page.items` got `undefined` and rendered an empty list forever.
 *
 * `lib/api.ts` pulls in `react-native` through the storage modules, so those are
 * mocked; the functions under test are pure and touch neither.
 */

vi.mock('../lib/config.js', () => ({
  config: { apiUrl: 'https://api.test/api/v1', timeoutMs: 1000, aiTimeoutMs: 1000, uploadTimeoutMs: 1000 },
  endpointUrl: (path: string) => `https://api.test/api/v1${path.startsWith('/') ? path : `/${path}`}`,
}));

vi.mock('../lib/kv.js', () => ({
  kv: { getString: () => null, set: () => undefined, delete: () => undefined },
  StorageKeys: {},
}));

vi.mock('../lib/secure-storage.js', () => ({
  secureStorage: { getTokens: async () => null, clearTokens: async () => undefined },
}));

const { buildQuery, normalizePage } = await import('../lib/api.js');

describe('buildQuery', () => {
  it('serialises booleans as true/false, which is what the API enums expect', () => {
    expect(buildQuery({ use_pantry: true })).toBe('?use_pantry=true');
    expect(buildQuery({ use_pantry: false })).toBe('?use_pantry=false');
  });

  it('drops undefined, null and empty-string values', () => {
    expect(buildQuery({ q: '', cuisine: undefined, diet: null, sort: 'newest' })).toBe('?sort=newest');
  });

  it('repeats a key for array values', () => {
    expect(buildQuery({ ids: ['a', 'b'] })).toBe('?ids=a&ids=b');
  });

  it('URL-encodes free text', () => {
    expect(buildQuery({ q: 'chicken & rice' })).toBe('?q=chicken+%26+rice');
  });

  it('returns an empty string when there is nothing to send', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery({})).toBe('');
  });
});

describe('normalizePage', () => {
  it('reads the standard { data, meta } envelope', () => {
    const page = normalizePage<{ id: string }>({
      data: [{ id: '1' }, { id: '2' }],
      meta: { page: 2, limit: 20, total: 41, has_more: true, next_cursor: 'abc' },
    });

    expect(page.items).toHaveLength(2);
    expect(page.page).toBe(2);
    expect(page.limit).toBe(20);
    expect(page.total).toBe(41);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('abc');
  });

  it('still reads a flattened payload, so an older server cannot blank a screen', () => {
    const page = normalizePage<{ id: string }>({
      data: [{ id: '1' }],
      page: 1,
      limit: 5,
      total: 1,
      has_more: false,
      next_cursor: null,
    } as never);

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('never returns undefined items, even for an empty envelope', () => {
    const page = normalizePage<{ id: string }>({ data: undefined, meta: undefined } as never);
    expect(page.items).toEqual([]);
    expect(page.page).toBe(1);
    expect(page.total).toBe(0);
  });
});
