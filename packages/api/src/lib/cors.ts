/**
 * CORS allow-list parsing.
 * ===========================================================================
 * `CORS_ORIGINS` is the one setting that most often breaks a first deploy: the
 * browser reports a CORS error, the API logs nothing, and the cause is a
 * trailing slash or a missing `https://`. So the list is parsed strictly here,
 * normalised the way browsers send the `Origin` header, and any entry that can
 * never match is reported at boot instead of silently ignored.
 *
 *   CORS_ORIGINS=*                                  any origin (development)
 *   CORS_ORIGINS=https://platematch.vercel.app      one exact origin
 *   CORS_ORIGINS=https://platematch.vercel.app,https://platematch-*-acme.vercel.app
 *                                                   …plus Vercel preview deploys
 *
 * A `*` inside a host matches one run of letters, digits and dashes — never a
 * dot — so `https://platematch-*-acme.vercel.app` covers preview URLs such as
 * `platematch-git-main-acme.vercel.app` but not `evil.com/platematch-x-acme`.
 */

export interface CorsPolicy {
  /** `CORS_ORIGINS=*` — every origin is allowed. */
  allowAll: boolean;
  /** Normalised exact origins (`https://app.example.com`). */
  exact: Set<string>;
  /** Compiled wildcard entries. */
  patterns: RegExp[];
  /** Entries that are not a valid origin — reported at boot. */
  invalid: string[];
  /** The cleaned-up entries, for logs and error messages. */
  entries: string[];
}

const WILDCARD_ORIGIN = /^(https?):\/\/([a-z0-9*.-]+)(:\d{1,5})?\/?$/i;

/**
 * Normalise an origin the way a browser sends it: lower-case scheme and host,
 * no default port, no trailing slash. Returns null for anything that is not a
 * bare `scheme://host[:port]` (a path, a query string, a missing scheme…).
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;

  // `URL` has already lower-cased the host and dropped a default port.
  return `${url.protocol}//${url.host}`;
}

function compileWildcard(entry: string): RegExp | null {
  const match = WILDCARD_ORIGIN.exec(entry.trim());
  if (!match) return null;

  const [, scheme, host, port = ''] = match;
  if (!host || !host.includes('*') || host.startsWith('.') || host.endsWith('.')) return null;
  // A wildcard must stay inside the host: `https://*` or `https://*.com` would
  // allow (nearly) everything, which is what `*` on its own is for.
  if (host.split('.').filter(Boolean).length < 3) return null;

  const hostPattern = host
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, '\\$&'))
    .join('[a-z0-9-]+');

  return new RegExp(`^${scheme!.toLowerCase()}:\\/\\/${hostPattern}${port.replace(':', '\\:')}$`);
}

/** Parse the raw `CORS_ORIGINS` value. */
export function parseCorsOrigins(raw: string | undefined): CorsPolicy {
  const value = (raw ?? '').trim();
  const policy: CorsPolicy = { allowAll: false, exact: new Set(), patterns: [], invalid: [], entries: [] };

  if (value === '*') {
    policy.allowAll = true;
    policy.entries = ['*'];
    return policy;
  }

  for (const entry of value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (entry.includes('*')) {
      const pattern = compileWildcard(entry);
      if (pattern) {
        policy.patterns.push(pattern);
        policy.entries.push(entry.replace(/\/$/, '').toLowerCase());
      } else {
        policy.invalid.push(entry);
      }
      continue;
    }

    const origin = normalizeOrigin(entry);
    if (origin) {
      policy.exact.add(origin);
      policy.entries.push(origin);
    } else {
      policy.invalid.push(entry);
    }
  }

  return policy;
}

/** Is a request's `Origin` header on the allow-list? */
export function isOriginAllowed(policy: CorsPolicy, origin: string | undefined): boolean {
  if (!origin) return false;
  if (policy.allowAll) return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (policy.exact.has(normalized)) return true;
  return policy.patterns.some((pattern) => pattern.test(normalized));
}

/** The first exact origin — used as the default `FRONTEND_URL`. */
export function primaryOrigin(policy: CorsPolicy): string | undefined {
  return policy.exact.values().next().value;
}
