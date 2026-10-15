import { logger } from '../../lib/logger.js';
import { UpstreamServiceError } from '../../lib/errors.js';

/**
 * HTTP helper for third-party AI/food APIs.
 *
 * Adds: timeouts, bounded exponential backoff with jitter, retry only on
 * transient failures (408/429/5xx/network), and structured logging of latency
 * + status so every upstream call is observable.
 */

/** `BodyInit` is a DOM type; derive the fetch body type from Node's own signature. */
export type FetchBody = NonNullable<RequestInit['body']>;

export interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body (used for FormData uploads). */
  rawBody?: FetchBody;
  timeoutMs?: number;
  retries?: number;
  /** Base delay for exponential backoff. */
  backoffMs?: number;
  signal?: AbortSignal;
  /** Label used in logs. */
  label?: string;
  /** Do not throw on non-2xx — return the parsed body instead. */
  allowErrorStatus?: boolean;
}

export interface FetchJsonResult<T> {
  status: number;
  data: T;
  latencyMs: number;
  headers: Headers;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<FetchJsonResult<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    rawBody,
    timeoutMs = 30_000,
    retries = 2,
    backoffMs = 500,
    signal,
    label = url,
    allowErrorStatus = false,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    // Abort if the caller aborts.
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    const started = Date.now();

    try {
      const finalHeaders: Record<string, string> = { ...headers };
      let payload: FetchBody | undefined;

      if (rawBody !== undefined) {
        payload = rawBody;
      } else if (body !== undefined) {
        payload = JSON.stringify(body);
        if (!hasHeader(finalHeaders, 'content-type')) finalHeaders['content-type'] = 'application/json';
      }
      if (!hasHeader(finalHeaders, 'accept')) finalHeaders['accept'] = 'application/json';

      const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: controller.signal,
      });

      const latencyMs = Date.now() - started;

      if (!response.ok && !allowErrorStatus) {
        const text = await safeText(response);
        logger.warn({ label, status: response.status, attempt, latencyMs, body: truncate(text) }, 'Upstream non-2xx');

        if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
          await sleep(backoffFor(attempt, backoffMs, response.headers.get('retry-after')));
          continue;
        }

        throw new UpstreamServiceError(
          `${label} failed with HTTP ${response.status}`,
          { status: response.status, body: truncate(text, 2000) },
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      let data: T;
      if (contentType.includes('application/json')) {
        data = (await response.json()) as T;
      } else {
        data = (await safeText(response)) as unknown as T;
      }

      logger.debug({ label, status: response.status, attempt, latencyMs }, 'Upstream call ok');
      return { status: response.status, data, latencyMs, headers: response.headers };
    } catch (err) {
      lastError = err;

      if (err instanceof UpstreamServiceError) throw err;

      const aborted = isAbort(err);
      logger.warn({ label, attempt, err: (err as Error).message }, aborted ? 'Upstream call timed out' : 'Upstream call failed');

      if (signal?.aborted) throw new UpstreamServiceError(`${label} was cancelled`);

      if (attempt < retries && (aborted || isTransientNetworkError(err))) {
        await sleep(backoffFor(attempt, backoffMs));
        continue;
      }
      break;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  if (lastError instanceof UpstreamServiceError) throw lastError;
  throw new UpstreamServiceError(`${label} failed after ${retries + 1} attempts`, {
    reason: (lastError as Error | undefined)?.message,
  });
}

function backoffFor(attempt: number, baseMs: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  }
  const exponential = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs * 0.5;
  return Math.min(exponential + jitter, 20_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isAbort(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'AbortError' || e?.message === 'timeout' || e?.message?.includes('aborted') === true;
}

function isTransientNetworkError(err: unknown): boolean {
  const message = (err as Error)?.message ?? '';
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed/i.test(message);
}

/**
 * Extract JSON from a model response that may be wrapped in markdown fences or
 * surrounded by prose. This is the single most common cause of AI pipeline
 * failures in production, so we are deliberately forgiving.
 */
export function extractJson<T = unknown>(raw: string): T {
  if (!raw) throw new UpstreamServiceError('Model returned an empty response');

  const text = raw.trim();

  // Fast path.
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    return JSON.parse(text) as T;
  }

  // ```json … ``` fences.
  const fenced = text.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    try {
      return JSON.parse(inner) as T;
    } catch {
      /* fall through to brace scanning */
    }
  }

  // First balanced { … } or [ … ] block.
  const scanned = scanBalanced(text);
  if (scanned) {
    try {
      return JSON.parse(scanned) as T;
    } catch {
      /* fall through */
    }
  }

  // Last resort: strip trailing commas / single quotes and retry.
  const cleaned = scanned ?? text;
  const repaired = cleaned
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/NaN/g, 'null')
    .replace(/undefined/g, 'null');
  try {
    return JSON.parse(repaired) as T;
  } catch (err) {
    throw new UpstreamServiceError('Model response was not valid JSON', {
      reason: (err as Error).message,
      preview: truncate(text, 400),
    });
  }
}

function scanBalanced(text: string): string | null {
  const startBrace = text.indexOf('{');
  const startBracket = text.indexOf('[');
  let start = -1;
  let open: string;
  let close: string;

  if (startBrace === -1 && startBracket === -1) return null;
  if (startBrace === -1) {
    start = startBracket;
    open = '[';
    close = ']';
  } else if (startBracket === -1) {
    start = startBrace;
    open = '{';
    close = '}';
  } else if (startBrace < startBracket) {
    start = startBrace;
    open = '{';
    close = '}';
  } else {
    start = startBracket;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
