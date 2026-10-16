import { endpointUrl, config } from './config.js';
import { secureStorage } from './secure-storage.js';
import { kv, StorageKeys } from './kv.js';
import { appendImagePart } from './upload-part.js';

/**
 * HTTP client.
 *
 * One place that knows how PlateMatch talks to its API:
 *
 *   • the `{ data, meta }` envelope every endpoint returns
 *   • the error envelope `{ statusCode, error, message, requestId }`
 *   • automatic access-token refresh, with a single in-flight refresh shared by
 *     concurrent 401s so five parallel queries do not burn five refresh tokens
 *   • a session-expired callback the auth store subscribes to
 *
 * Routes never call `fetch` directly — they go through `api`, so a change to the
 * auth scheme or the envelope is a one-file change.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  requestId?: string;
  details?: unknown;
  issues?: Array<{ path: string; message: string }>;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly issues?: Array<{ path: string; message: string }>;

  constructor(body: ApiErrorBody) {
    super(body.message || 'Request failed');
    this.name = 'ApiError';
    this.statusCode = body.statusCode;
    this.code = body.error;
    this.requestId = body.requestId;
    this.details = body.details;
    this.issues = body.issues;
  }

  /** True for anything the client caused — safe to show verbatim. */
  get isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }

  /** 422 with field-level issues, for inline form errors. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.issues ?? []) out[issue.path] = issue.message;
    return out;
  }

  /** Human copy for a toast. Server messages for 5xx are deliberately vague. */
  get displayMessage(): string {
    if (this.statusCode === 429) return 'That was a bit too fast — give it a few seconds and try again.';
    if (this.statusCode >= 500) return 'Something went wrong on our side. Please try again.';
    if (!this.message) return 'Request failed.';
    return this.message;
  }
}

export class NetworkError extends Error {
  constructor(message = 'No internet connection. Check your network and try again.') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface Paginated<T> {
  data: T[];
  meta?: {
    page: number;
    limit: number;
    total: number;
    has_more: boolean;
    next_cursor?: string | null;
  };
  /** Some endpoints flatten pagination onto the top level. */
  page?: number;
  limit?: number;
  total?: number;
  has_more?: boolean;
  next_cursor?: string | null;
}

type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: QueryParams;
  body?: unknown;
  /** Skip the Authorization header (login, register, public reads). */
  anonymous?: boolean;
  /** Longer budget for AI endpoints. */
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Do not attempt a token refresh on 401. */
  skipAuthRefresh?: boolean;
}

// ---------------------------------------------------------------------------
// Session-expiry notification
// ---------------------------------------------------------------------------

type SessionExpiredHandler = () => void;
const sessionExpiredHandlers = new Set<SessionExpiredHandler>();

/** Subscribe to "the refresh token died, send the user to the login screen". */
export function onSessionExpired(handler: SessionExpiredHandler): () => void {
  sessionExpiredHandlers.add(handler);
  return () => sessionExpiredHandlers.delete(handler);
}

function notifySessionExpired(): void {
  for (const handler of sessionExpiredHandlers) {
    try {
      handler();
    } catch {
      /* a broken subscriber must not break the others */
    }
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchange the refresh token for a new pair.
 *
 * Concurrent 401s share one in-flight refresh. Without this, five parallel
 * queries on app start would each present a refresh token, and because the API
 * rotates tokens and revokes the whole family on reuse, four of them would
 * invalidate the fifth — logging the user out for no reason.
 */
export async function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const tokens = await secureStorage.getTokens();
    if (!tokens?.refreshToken) return false;

    try {
      const response = await fetch(endpointUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) {
        await secureStorage.clearTokens();
        notifySessionExpired();
        return false;
      }

      const payload = (await response.json()) as {
        data?: { access_token: string; refresh_token: string };
      };

      const next = payload.data;
      if (!next?.access_token || !next?.refresh_token) {
        await secureStorage.clearTokens();
        notifySessionExpired();
        return false;
      }

      await secureStorage.setTokens({
        accessToken: next.access_token,
        refreshToken: next.refresh_token,
      });
      return true;
    } catch {
      // A network failure during refresh is not a session expiry: keep the
      // tokens so the next request can try again.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Forget the session locally (sign-out). */
export async function clearSession(): Promise<void> {
  await secureStorage.clearTokens();
}

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

export function buildQuery(query?: QueryParams): string {
  if (!query) return '';

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    if (typeof value === 'boolean') {
      params.set(key, value ? 'true' : 'false');
      continue;
    }
    if (value === '') continue;
    params.set(key, String(value));
  }

  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

async function parseError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await response.json()) as Partial<ApiErrorBody>;
  } catch {
    // A non-JSON error body (proxy HTML, an empty 502) is normal in the wild.
  }

  return new ApiError({
    statusCode: body.statusCode ?? response.status,
    error: body.error ?? 'request_failed',
    message: body.message ?? `Request failed with status ${response.status}`,
    requestId: body.requestId,
    details: body.details,
    issues: body.issues,
  });
}

async function performRequest(path: string, options: RequestOptions): Promise<Response> {
  const url = `${endpointUrl(path)}${buildQuery(options.query)}`;
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;

  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-client-version': config.environment,
    ...options.headers,
  };

  if (!options.anonymous) {
    const accessToken = await secureStorage.getAccessToken();
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      body = options.body;
      // fetch sets the multipart boundary itself; an explicit content-type here
      // would override it and the upload would fail to parse.
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }

  const deviceId = kv.get(StorageKeys.deviceId);
  if (deviceId) headers['x-device-id'] = deviceId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Honour a caller-provided signal as well as our own timeout.
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
      throw new NetworkError('The request timed out. Check your connection and try again.');
    }
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
}

/** Low-level request: returns the raw `Response` after handling one refresh. */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  let response = await performRequest(path, options);

  // 401 with a refresh token available → rotate once and retry the same call.
  if (response.status === 401 && !options.anonymous && !options.skipAuthRefresh) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      response = await performRequest(path, options);
    }
  }

  return response;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Unwrap the `{ data }` envelope, throwing a typed `ApiError` on failure. */
async function unwrap<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  if (!response.ok) throw await parseError(response);

  // A 204-style empty body is legal on some endpoints.
  const text = await response.text();
  if (!text) return undefined as T;

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ApiError({
      statusCode: response.status,
      error: 'invalid_response',
      message: 'The server sent a response we could not read.',
    });
  }

  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

export const api = {
  async get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return unwrap<T>(await request(path, { ...options, method: 'GET' }));
  },

  async post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return unwrap<T>(await request(path, { ...options, method: 'POST', body }));
  },

  async put<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return unwrap<T>(await request(path, { ...options, method: 'PUT', body }));
  },

  async patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return unwrap<T>(await request(path, { ...options, method: 'PATCH', body }));
  },

  async delete<T = void>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return unwrap<T>(await request(path, { ...options, method: 'DELETE' }));
  },

  /**
   * List endpoint that keeps the pagination metadata.
   *
   * The API uses two shapes: `{ data, meta }` for most collections and a flat
   * `{ data, page, limit, total, has_more }` for cursor-paginated ones. Both are
   * normalised here so screens read the same fields.
   */
  async list<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<NormalizedPage<T>> {
    const response = await request(path, { ...options, method: 'GET' });
    if (!response.ok) throw await parseError(response);

    const payload = (await response.json()) as Paginated<T>;
    return normalizePage(payload);
  },

  /**
   * Multipart image upload.
   *
   * Builds the FormData with an explicit filename and MIME type, because the
   * server sniffs magic bytes and rejects a payload declared as
   * `application/octet-stream`.
   */
  async upload<T>(
    path: string,
    file: { uri: string; name?: string; type?: string },
    fields: Record<string, string> = {},
    options: Omit<RequestOptions, 'method' | 'body'> = {},
  ): Promise<T> {
    const form = new FormData();

    // Native streams `{ uri, name, type }`; web needs a real Blob. Metro picks
    // upload-part.web.ts for the browser build.
    await appendImagePart(form, 'image', file);

    for (const [key, value] of Object.entries(fields)) form.append(key, value);

    return unwrap<T>(
      await request(path, {
        ...options,
        method: 'POST',
        body: form,
        timeoutMs: options.timeoutMs ?? config.uploadTimeoutMs,
      }),
    );
  },

  raw: request,
  refreshTokens,
  clearSession,
};

export interface NormalizedPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export function normalizePage<T>(payload: Paginated<T>): NormalizedPage<T> {
  const meta = payload.meta;
  return {
    items: payload.data ?? [],
    page: meta?.page ?? payload.page ?? 1,
    limit: meta?.limit ?? payload.limit ?? 20,
    total: meta?.total ?? payload.total ?? (payload.data?.length ?? 0),
    hasMore: meta?.has_more ?? payload.has_more ?? false,
    nextCursor: meta?.next_cursor ?? payload.next_cursor ?? null,
  };
}

export default api;
