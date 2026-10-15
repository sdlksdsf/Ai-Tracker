import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Password hashing
 * ===========================================================================
 * Primary: Argon2id (the spec's requirement, and the current OWASP #1 pick).
 * Fallback: scrypt (Node's built-in KDF) when the optional native `argon2`
 * module cannot be loaded — e.g. on a platform without prebuilt binaries.
 *
 * The stored hash is self-describing (`argon2id$…` vs `scrypt$…`) so
 * verification works regardless of which implementation produced it, and a
 * future rehash-on-login migration is trivial.
 */

interface Argon2Like {
  hash(password: string, options?: Record<string, unknown>): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  needsRehash(hash: string, options?: Record<string, unknown>): boolean;
  argon2id: number;
}

let argon2: Argon2Like | null = null;
let argon2LoadAttempted = false;

async function getArgon2(): Promise<Argon2Like | null> {
  if (argon2LoadAttempted) return argon2;
  argon2LoadAttempted = true;
  try {
    // Imported lazily so the API still boots where the native build fails.
    const mod = (await import('argon2')) as unknown as Argon2Like & { default?: Argon2Like };
    argon2 = mod.default ?? mod;
  } catch {
    argon2 = null;
  }
  return argon2;
}

/** Argon2id parameters aligned with the OWASP 2024 password-storage guidance. */
const ARGON2_OPTIONS = {
  type: 2, // argon2id
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;

/** Hash a plaintext password. Returns an Argon2id string when available. */
export async function hashPassword(password: string): Promise<string> {
  const lib = await getArgon2();
  if (lib) {
    return lib.hash(password, {
      type: lib.argon2id,
      memoryCost: ARGON2_OPTIONS.memoryCost,
      timeCost: ARGON2_OPTIONS.timeCost,
      parallelism: ARGON2_OPTIONS.parallelism,
    });
  }

  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verify a plaintext password against a stored hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash) return false;

  if (hash.startsWith('scrypt$')) {
    const parts = hash.split('$');
    if (parts.length !== 6) return false;
    const [, n, r, p, saltB64, keyB64] = parts as unknown as [string, string, string, string, string, string];
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  const lib = await getArgon2();
  if (!lib) {
    // Argon2 hash but the native module is unavailable — cannot verify.
    throw new Error('argon2 module unavailable: cannot verify an Argon2id hash');
  }
  return lib.verify(hash, password);
}

/** True when a stored hash should be upgraded on next successful login. */
export async function passwordNeedsRehash(hash: string): Promise<boolean> {
  if (!hash.startsWith('$argon2')) return true; // scrypt or malformed → upgrade
  const lib = await getArgon2();
  if (!lib) return false;
  try {
    return lib.needsRehash(hash, {
      type: lib.argon2id,
      memoryCost: ARGON2_OPTIONS.memoryCost,
      timeCost: ARGON2_OPTIONS.timeCost,
      parallelism: ARGON2_OPTIONS.parallelism,
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tokens & hashing helpers
// ---------------------------------------------------------------------------

/** Cryptographically random URL-safe token (used for refresh + reset tokens). */
export function generateOpaqueToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Refresh-token family identifier.
 *
 * MUST be a UUID: `refresh_tokens.family_id` is a Postgres `uuid` column, and
 * generating it with `generateOpaqueToken` produced a base64url string that
 * Postgres rejected with `invalid input syntax for type uuid` — which failed
 * every registration, login and OAuth sign-in with a 500.
 *
 * Built from 16 random bytes in UUID v4 layout rather than `crypto.randomUUID()`
 * so the entropy source stays identical to every other secret in this module.
 */
export function generateFamilyId(): string {
  const bytes = randomBytes(16);
  // Set the version (4) and variant (RFC 4122) nibbles.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True when a string is a syntactically valid UUID. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** SHA-256 hex digest — used to store tokens without keeping the raw value. */
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable SHA-256 of a JSON-serialisable object (prompt hashing / dedupe). */
export function stableHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Deterministic JSON stringify (sorted keys) so hashes are stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortDeep(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function newId(): string {
  return randomUUID();
}

/** Short human-shareable id (invite codes, share slugs). */
export function shortId(size = 8): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) out += alphabet[(bytes[i] as number) % alphabet.length];
  return out;
}

/** Constant-time string comparison (avoids timing leaks on token checks). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Average-hash (aHash) of raw pixel bytes — a cheap perceptual hash used to
 * deduplicate identical scan uploads. Input: 64 grayscale values (8x8).
 */
export function averageHashFromGray(gray: Uint8Array | number[]): string {
  const values = Array.from(gray);
  if (values.length === 0) return '';
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let bits = '';
  for (const v of values) bits += v > mean ? '1' : '0';
  // Pack the bit string into hex.
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two equal-length hex hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i] as string, 16) ^ parseInt(b[i] as string, 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/** Very light HTML/tag sanitiser for user-supplied free text. */
export function sanitizeText(input: string): string {
  return input
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .trim();
}
