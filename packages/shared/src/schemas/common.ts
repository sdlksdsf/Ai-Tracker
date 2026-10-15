import { z } from 'zod';

/** Generic paginated envelope returned by every list endpoint. */
export const paginationMetaSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

export const paginatedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), meta: paginationMetaSchema });

export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
  /** Per-field validation errors from Zod. */
  issues: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
    .optional(),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  uptime_s: z.number(),
  time: z.string(),
  checks: z.record(
    z.string(),
    z.object({ status: z.enum(['ok', 'degraded', 'down']), latency_ms: z.number().optional() }),
  ),
});
export type Health = z.infer<typeof healthSchema>;

/** `?fields=title,image_url,calories` — coarse field selection (Section 8). */
export const fieldsQuerySchema = z.object({
  fields: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 40),
    )
    .optional(),
});

export const idParamSchema = z.object({
  id: z.string().uuid('Invalid id'),
});
export type IdParam = z.infer<typeof idParamSchema>;
