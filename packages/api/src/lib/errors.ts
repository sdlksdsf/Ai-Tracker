import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { logger } from './logger.js';

/**
 * Application error hierarchy.
 *
 * Throw these from services/controllers; the global error handler turns them
 * into a consistent JSON envelope:
 *   { statusCode, error, message, issues?, requestId }
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  /** Errors that are the client's fault are not reported to Sentry. */
  readonly reportable: boolean;

  constructor(message: string, statusCode = 500, code = 'internal_error', options: { details?: unknown; reportable?: boolean } = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.reportable = options.reportable ?? statusCode >= 500;
    // Restore the prototype chain (TypeScript + ES2022 target quirk).
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  toJSON() {
    return {
      statusCode: this.statusCode,
      error: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, 400, 'bad_request', { details, reportable: false });
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 422, 'validation_error', { details, reportable: false });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized', { reportable: false });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(message, 403, 'forbidden', { reportable: false });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'not_found', { reportable: false });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'conflict', { reportable: false });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', details?: unknown) {
    super(message, 429, 'rate_limited', { details, reportable: false });
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = 'Plan quota exceeded', details?: unknown) {
    super(message, 402, 'quota_exceeded', { details, reportable: false });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large') {
    super(message, 413, 'payload_too_large', { reportable: false });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type') {
    super(message, 415, 'unsupported_media_type', { reportable: false });
  }
}

export class UpstreamServiceError extends AppError {
  constructor(message = 'Upstream service error', details?: unknown) {
    super(message, 502, 'upstream_error', { details });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 503, 'service_unavailable');
  }
}

/** Raised when the AI safety guard rejects model output (allergens/diet). */
export class AiSafetyError extends AppError {
  constructor(message = 'AI output rejected by the safety guard', details?: unknown) {
    super(message, 502, 'ai_safety_rejected', { details });
  }
}

// ---------------------------------------------------------------------------
// Zod → HTTP
// ---------------------------------------------------------------------------

export function zodIssuesToDetails(error: ZodError) {
  return error.issues.map((i) => ({
    path: i.path.map((p) => String(p)),
    message: i.message,
    code: i.code,
  }));
}

export function fromZodError(error: ZodError, message = 'Validation failed'): ValidationError {
  return new ValidationError(message, zodIssuesToDetails(error));
}

/** Parse with Zod or throw a 422 that carries per-field issues. */
export function parseOrThrow<T extends { safeParse(data: unknown): { success: boolean; data?: unknown; error?: ZodError } }>(
  schema: T,
  data: unknown,
  message = 'Validation failed',
): T extends { safeParse(d: unknown): { success: true; data: infer D } } ? D : never {
  const result = schema.safeParse(data);
  if (!result.success) throw fromZodError(result.error as ZodError, message);
  return result.data as never;
}

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Fastify `setErrorHandler` implementation. Registered in `app.ts`.
 */
export function errorHandler(
  error: Error & { statusCode?: number; code?: string; validation?: unknown },
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  // --- Zod validation thrown by a service ---------------------------------
  if (error instanceof ZodError) {
    const ve = fromZodError(error);
    void reply.status(ve.statusCode).send({ ...ve.toJSON(), issues: zodIssuesToDetails(error), requestId });
    return;
  }

  // --- Our own typed errors ----------------------------------------------
  if (isAppError(error)) {
    if (error.reportable) {
      request.log.error({ err: error, requestId }, error.message);
    } else {
      request.log.warn({ code: error.code, requestId, message: error.message });
    }
    void reply.status(error.statusCode).send({ ...error.toJSON(), requestId });
    return;
  }

  // --- Fastify's own validation errors -----------------------------------
  if (error.validation) {
    void reply.status(422).send({
      statusCode: 422,
      error: 'validation_error',
      message: error.message,
      requestId,
    });
    return;
  }

  // --- Rate limiter (@fastify/rate-limit sets statusCode 429) -------------
  if (error.statusCode === 429) {
    void reply.status(429).send({
      statusCode: 429,
      error: 'rate_limited',
      message: 'Too many requests. Please slow down.',
      requestId,
    });
    return;
  }

  // --- Everything else: log loudly, return an opaque 500 ------------------
  request.log.error({ err: error, requestId }, 'Unhandled error');
  logger.error({ err: error, requestId, url: request.url }, 'Unhandled error');

  void reply.status(500).send({
    statusCode: 500,
    error: 'internal_error',
    message:
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong on our side. Please try again.'
        : error.message || 'Internal server error',
    requestId,
  });
}

/** 404 handler for unknown routes. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send({
    statusCode: 404,
    error: 'not_found',
    message: `Route ${request.method}:${request.url} not found`,
    requestId: request.id,
  });
}
