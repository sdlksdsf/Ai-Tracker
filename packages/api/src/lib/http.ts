import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny } from 'zod';
import { fromZodError, BadRequestError } from './errors.js';
import { buildMeta, normalizePage, paginate, type PageParams, type Paginated } from './pagination.js';

/**
 * Small HTTP helpers shared by every route module.
 *
 * Keeping them here means route handlers stay one-liners: parse → call the
 * service → reply. It also guarantees a single envelope shape across the API.
 */

/** `{ data }` envelope used by every successful JSON response. */
export function ok<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  return reply.status(status).send({ data });
}

/** `{ data, meta }` envelope for offset-paginated collections. */
export function paginated<T>(reply: FastifyReply, data: T[], params: PageParams, total: number, cursor?: string | null): FastifyReply {
  return reply.send({ data, meta: buildMeta(params, data, total, cursor) });
}

/** Wrap an already-shaped `Paginated<T>` from a service. */
export function paginatedResult<T>(reply: FastifyReply, result: Paginated<T>): FastifyReply {
  return reply.send(result);
}

export function noContent(reply: FastifyReply): FastifyReply {
  return reply.status(204).send();
}

/**
 * Parse a request segment with a Zod schema, throwing our typed 422 on failure.
 * `parseOrThrow` in errors.ts is generic-over-object; this one is the ergonomic
 * per-segment version used inside handlers.
 */
export function parseWith<T extends ZodTypeAny>(schema: T, value: unknown, label: string): T extends ZodTypeAny ? NonNullable<T['_output']> : never {
  const result = schema.safeParse(value);
  if (!result.success) throw fromZodError(result.error as ZodError, `Invalid ${label}`);
  return result.data as never;
}

/** Read `?page`/`?limit` and clamp them to sane values. */
export function pageParams(query: unknown, defaults?: { page?: number; limit?: number; maxLimit?: number }): PageParams {
  const q = (query ?? {}) as Record<string, unknown>;
  return normalizePage(q.page, q.limit, {
    page: defaults?.page ?? 1,
    limit: defaults?.limit ?? 20,
    maxLimit: defaults?.maxLimit ?? 100,
  });
}

/** Build a `Paginated<T>` from a service that returns `{ data, total }`. */
export function toPaginated<T>(params: PageParams, data: T[], total: number, cursor?: string | null): Paginated<T> {
  return paginate(params, data, total, cursor);
}

/** Coerce a route param to a UUID or throw a 400. */
export function uuidParam(value: unknown, name = 'id'): string {
  const id = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new BadRequestError(`'${name}' must be a valid UUID`);
  }
  return id;
}

/** Pull the authenticated user id off the request (set by the auth plugin). */
export function userIdOf(request: FastifyRequest): string {
  const user = (request as FastifyRequest & { user?: { id: string } }).user;
  if (!user?.id) throw new BadRequestError('Authentication required');
  return user.id;
}

/** Strip empty-string query values so Zod `.optional()` behaves as expected. */
export function cleanQuery<T extends Record<string, unknown>>(query: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

export { buildMeta, normalizePage, paginate };
export type { PageParams, Paginated };
