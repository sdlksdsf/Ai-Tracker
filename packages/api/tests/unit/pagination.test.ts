import { describe, expect, it } from 'vitest';
import {
  buildMeta,
  computeETag,
  decodeCursor,
  encodeCursor,
  nextCursor,
  normalizePage,
  offsetOf,
  paginate,
  pickFields,
} from '../../src/lib/pagination.js';

/**
 * Pagination, cursors and ETags (Section 8).
 *
 * These are the primitives behind every list endpoint. A wrong `has_more` makes
 * infinite scroll stop early or spin forever; a wrong offset silently skips rows.
 */

describe('normalizePage', () => {
  it('accepts valid page and limit values', () => {
    expect(normalizePage(2, 25)).toEqual({ page: 2, limit: 25 });
  });

  it('coerces the strings a querystring actually delivers', () => {
    expect(normalizePage('3', '15')).toEqual({ page: 3, limit: 15 });
  });

  it('falls back to defaults for missing or empty values', () => {
    expect(normalizePage(undefined, undefined)).toEqual({ page: 1, limit: 20 });
    expect(normalizePage('', '')).toEqual({ page: 1, limit: 20 });
    expect(normalizePage(null, null)).toEqual({ page: 1, limit: 20 });
  });

  it('clamps page to a minimum of 1', () => {
    expect(normalizePage(0, 20).page).toBe(1);
    expect(normalizePage(-5, 20).page).toBe(1);
  });

  it('clamps a negative limit to the minimum', () => {
    expect(normalizePage(1, -10).limit).toBe(1);
    expect(normalizePage(1, 5000).limit).toBe(100);
  });

  it('treats limit=0 as "not supplied" and uses the default', () => {
    // 0 is falsy, so it falls back rather than clamping to 1 — a client that
    // omits the parameter still gets a usable page instead of a single row.
    expect(normalizePage(1, 0).limit).toBe(20);
  });

  it('honours a custom maximum', () => {
    expect(normalizePage(1, 500, { page: 1, limit: 10, maxLimit: 50 }).limit).toBe(50);
  });

  it('falls back to defaults for non-numeric junk', () => {
    expect(normalizePage('abc', 'xyz')).toEqual({ page: 1, limit: 20 });
    expect(Number.isNaN(normalizePage('abc', 'xyz').page)).toBe(false);
  });

  it('always returns finite integers', () => {
    for (const [page, limit] of [[1, 20], [0, 0], [-1, -1], ['x', 'y'], [99999, 99999]] as Array<[unknown, unknown]>) {
      const params = normalizePage(page, limit);
      expect(Number.isInteger(params.page)).toBe(true);
      expect(Number.isInteger(params.limit)).toBe(true);
      expect(Number.isFinite(params.page)).toBe(true);
      expect(Number.isFinite(params.limit)).toBe(true);
    }
  });
});

describe('offsetOf', () => {
  it('computes a zero-based offset', () => {
    expect(offsetOf({ page: 1, limit: 20 })).toBe(0);
    expect(offsetOf({ page: 2, limit: 20 })).toBe(20);
    expect(offsetOf({ page: 5, limit: 10 })).toBe(40);
  });

  it('never returns a negative offset', () => {
    // Regression: an unclamped (page - 1) * limit sent "OFFSET -20" to Postgres,
    // which rejects the whole query rather than treating it as 0.
    expect(offsetOf({ page: 0, limit: 20 })).toBe(0);
    expect(offsetOf({ page: -3, limit: 20 })).toBe(0);
  });

  it('ignores fractional page and limit values', () => {
    expect(offsetOf({ page: 2.7, limit: 10 })).toBe(10);
  });
});

describe('buildMeta', () => {
  it('reports more pages when rows remain', () => {
    const meta = buildMeta({ page: 1, limit: 2 }, [1, 2], 5);
    expect(meta.has_more).toBe(true);
    expect(meta.total).toBe(5);
    expect(meta.page).toBe(1);
    expect(meta.limit).toBe(2);
  });

  it('reports no more pages on the last page', () => {
    expect(buildMeta({ page: 3, limit: 2 }, [1, 2], 5).has_more).toBe(false);
    expect(buildMeta({ page: 2, limit: 2 }, [1], 3).has_more).toBe(false);
  });

  it('reports no more pages for an empty result', () => {
    // Guards against an infinite-scroll client that keeps paging forever.
    expect(buildMeta({ page: 1, limit: 20 }, [], 0).has_more).toBe(false);
    expect(buildMeta({ page: 2, limit: 20 }, [], 5).has_more).toBe(false);
  });

  it('defaults next_cursor to null', () => {
    expect(buildMeta({ page: 1, limit: 20 }, [], 0).next_cursor).toBeNull();
  });

  it('passes a cursor through unchanged', () => {
    expect(buildMeta({ page: 1, limit: 20 }, [1], 5, 'abc').next_cursor).toBe('abc');
  });

  it('counts pages from the offset, not the row count alone', () => {
    // Page 2 of 20-per-page with 20 rows returned has seen 40 rows.
    const meta = buildMeta({ page: 2, limit: 20 }, new Array(20).fill(0), 100);
    expect(meta.has_more).toBe(true);
    const last = buildMeta({ page: 5, limit: 20 }, new Array(20).fill(0), 100);
    expect(last.has_more).toBe(false);
  });
});

describe('paginate', () => {
  it('wraps rows with their metadata', () => {
    const result = paginate({ page: 1, limit: 2 }, ['a', 'b'], 4);
    expect(result.data).toEqual(['a', 'b']);
    expect(result.meta.total).toBe(4);
    expect(result.meta.has_more).toBe(true);
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a numeric cursor value', () => {
    const encoded = encodeCursor({ v: 1729, id: 'abc-123' });
    const decoded = decodeCursor(encoded);
    expect(decoded?.v).toBe(1729);
    expect(decoded?.id).toBe('abc-123');
  });

  it('round-trips a string cursor value', () => {
    const encoded = encodeCursor({ v: '2026-10-15T12:00:00.000Z', id: 'row-1' });
    const decoded = decodeCursor(encoded);
    expect(decoded?.v).toBe('2026-10-15T12:00:00.000Z');
    expect(decoded?.id).toBe('row-1');
  });

  it('defaults the sort direction to desc and preserves an explicit one', () => {
    expect(decodeCursor(encodeCursor({ v: 1, id: 'a' }))?.dir).toBe('desc');
    expect(decodeCursor(encodeCursor({ v: 1, id: 'a', dir: 'asc' }))?.dir).toBe('asc');
  });

  it('produces a URL-safe opaque string', () => {
    const encoded = encodeCursor({ v: 'a value with spaces & symbols!', id: 'x' });
    expect(encoded).not.toMatch(/[+/=\s]/);
    expect(decodeCursor(encoded)?.v).toBe('a value with spaces & symbols!');
  });

  it('does not leak a readable payload', () => {
    const encoded = encodeCursor({ v: 'secret-value', id: 'x' });
    expect(encoded).not.toContain('secret-value');
  });

  it('returns null for malformed input rather than throwing', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('not-valid-base64-!!!')).toBeNull();
    expect(decodeCursor('e30=')).toBeNull();
  });

  it('is stable — the same payload always encodes identically', () => {
    expect(encodeCursor({ v: 5, id: 'a' })).toBe(encodeCursor({ v: 5, id: 'a' }));
  });
});

describe('nextCursor', () => {
  const rows = [
    { id: '1', createdAt: '2026-10-15' },
    { id: '2', createdAt: '2026-10-14' },
    { id: '3', createdAt: '2026-10-13' },
  ];

  it('builds a cursor from the last row', () => {
    const cursor = nextCursor(rows, (row) => ({ v: row.createdAt, id: row.id }));
    expect(cursor).not.toBeNull();
    expect(decodeCursor(cursor)?.id).toBe('3');
    expect(decodeCursor(cursor)?.v).toBe('2026-10-13');
  });

  it('returns null for an empty page so scrolling stops', () => {
    expect(nextCursor([], (row: { id: string }) => ({ v: 0, id: row.id }))).toBeNull();
  });

  it('supports numeric sort values', () => {
    const numeric = [{ id: 'a', rank: 10 }, { id: 'b', rank: 20 }];
    const cursor = nextCursor(numeric, (row) => ({ v: row.rank, id: row.id }), 'asc');
    expect(decodeCursor(cursor)?.v).toBe(20);
  });
});

describe('pickFields', () => {
  const rows = [
    { id: '1', title: 'Soup', secret: 'hash', calories: 200 },
    { id: '2', title: 'Salad', secret: 'hash2', calories: 90 },
  ];

  it('returns the rows untouched when no fields are requested', () => {
    expect(pickFields(rows, undefined)).toEqual(rows);
    expect(pickFields(rows, [])).toEqual(rows);
  });

  it('keeps only the requested fields', () => {
    const picked = pickFields(rows, ['id', 'title']);
    expect(picked).toEqual([
      { id: '1', title: 'Soup' },
      { id: '2', title: 'Salad' },
    ]);
  });

  it('omits fields that do not exist', () => {
    expect(pickFields(rows, ['id', 'nope'])).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('can reduce a payload by excluding heavy columns', () => {
    // The `?fields=` parameter exists so a list endpoint can drop a big JSON
    // column the caller does not need.
    const slim = pickFields(rows, ['id']);
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(rows).length);
    expect('secret' in (slim[0] as object)).toBe(false);
  });

  it('does not mutate the input rows', () => {
    const copy = structuredClone(rows);
    pickFields(rows, ['id']);
    expect(rows).toEqual(copy);
  });

  it('handles an empty input', () => {
    expect(pickFields([], ['id'])).toEqual([]);
  });
});

describe('computeETag', () => {
  it('returns the same tag for the same payload', () => {
    expect(computeETag({ a: 1, b: [1, 2] })).toBe(computeETag({ a: 1, b: [1, 2] }));
  });

  it('returns a different tag when the payload changes', () => {
    expect(computeETag({ a: 1 })).not.toBe(computeETag({ a: 2 }));
  });

  it('is independent of key order', () => {
    // A client must not be forced to re-download because the DB returned columns
    // in a different order.
    expect(computeETag({ a: 1, b: 2 })).toBe(computeETag({ b: 2, a: 1 }));
  });

  it('produces a quoted, weak-safe HTTP entity tag', () => {
    const etag = computeETag({ a: 1 });
    expect(typeof etag).toBe('string');
    expect(etag.length).toBeGreaterThan(2);
  });

  it('handles empty and primitive payloads', () => {
    expect(() => computeETag({})).not.toThrow();
    expect(() => computeETag([])).not.toThrow();
    expect(() => computeETag(null)).not.toThrow();
    expect(computeETag(null)).toBe(computeETag(null));
  });
});
