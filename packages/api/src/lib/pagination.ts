import { createHash } from 'node:crypto';

/**
 * Pagination helpers.
 *
 * Two flavours, as required by Section 4:
 *   • offset pagination (`?page=&limit=`) for list screens
 *   • cursor pagination (opaque base64 of the sort key) for infinite scroll
 */

export interface PageParams {
  page: number;
  limit: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  next_cursor?: string | null;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

export function normalizePage(page: unknown, limit: unknown, defaults = { page: 1, limit: 20, maxLimit: 100 }): PageParams {
  const p = Math.max(1, Number(page) || defaults.page);
  const l = Math.min(defaults.maxLimit, Math.max(1, Number(limit) || defaults.limit));
  return { page: p, limit: l };
}

export function offsetOf(params: PageParams): number {
  // Clamped: `OFFSET` must never be negative or Postgres rejects the whole
  // query with "OFFSET must not be negative". `normalizePage` already guards
  // page >= 1, but this function is exported and callers pass hand-built
  // params, so it defends itself too.
  const page = Math.max(1, Math.trunc(params.page) || 1);
  const limit = Math.max(0, Math.trunc(params.limit) || 0);
  return (page - 1) * limit;
}

export function buildMeta<T>(params: PageParams, rows: T[], total: number, cursor?: string | null): PaginationMeta {
  const seen = (params.page - 1) * params.limit + rows.length;
  return {
    page: params.page,
    limit: params.limit,
    total,
    has_more: seen < total && rows.length > 0,
    next_cursor: cursor ?? null,
  };
}

export function paginate<T>(params: PageParams, rows: T[], total: number, cursor?: string | null): Paginated<T> {
  return { data: rows, meta: buildMeta(params, rows, total, cursor) };
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

export interface CursorPayload {
  /** Value of the sort column for the last returned row. */
  v: string | number;
  /** Tie-breaker (usually the row id). */
  id: string;
  /** Sort direction. */
  dir?: 'asc' | 'desc';
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): CursorPayload | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (parsed.v === undefined || typeof parsed.id !== 'string') return null;
    return { v: parsed.v, id: parsed.id, dir: parsed.dir ?? 'desc' };
  } catch {
    return null;
  }
}

/** Build the cursor for the next page from the last row of the current page. */
export function nextCursor<T>(rows: T[], pick: (row: T) => { v: string | number; id: string }, dir: 'asc' | 'desc' = 'desc'): string | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  const { v, id } = pick(last);
  return encodeCursor({ v, id, dir });
}

/**
 * Field selection: `?fields=title,image_url,calories`
 * Returns a shallow-picked copy; unknown fields are ignored.
 */
export function pickFields<T extends object>(rows: T[], fields: string[] | undefined): T[] {
  if (!fields || fields.length === 0) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const key = field.trim();
      if (key && key in row) out[key] = (row as Record<string, unknown>)[key];
    }
    // Always keep the id so clients can navigate.
    if ('id' in row) out.id = (row as Record<string, unknown>).id;
    return out as T;
  });
}

/**
 * ETag helper — stable weak ETag over a JSON-serialisable payload.
 * Returns null when the response is unchanged (caller should send 304).
 */
/**
 * Serialise with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two payloads carrying the same
 * data can hash differently — which makes a client re-download a response it
 * already has. Sorting keys makes the ETag depend only on the data.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function computeETag(payload: unknown): string {
  const hash = createHash('sha1').update(canonicalJson(payload)).digest('base64url').slice(0, 27);
  return `W/"${hash}"`;
}
