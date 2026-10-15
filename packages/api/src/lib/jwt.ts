import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../config/env.js';
import { generateFamilyId, generateOpaqueToken, sha256 } from './crypto.js';
import { UnauthorizedError } from './errors.js';

/**
 * JWT issuing & verification (jose — pure ESM, no native deps).
 *
 *   • Access token  — short-lived (15 min), sent as `Authorization: Bearer`.
 *   • Refresh token — opaque random string (7 days), stored hashed in the DB
 *                     and rotated on every use. Rotation + family tracking
 *                     gives us replay detection: reusing an old token revokes
 *                     the whole family.
 */

export type TokenType = 'access' | 'refresh';

export interface AccessTokenClaims {
  /** Subject — the user id. */
  sub: string;
  email: string;
  /** Subscription tier, so feature gating works without a DB round-trip. */
  tier: string;
  /** Refresh-token family, so logout can revoke the right lineage. */
  family?: string;
  type: 'access';
  iat: number;
  exp: number;
}

const accessSecret = () => new TextEncoder().encode(env.JWT_SECRET);
const refreshSecret = () => new TextEncoder().encode(env.JWT_REFRESH_SECRET);

export interface IssueAccessOptions {
  userId: string;
  email: string;
  tier: string;
  familyId?: string;
  ttlSeconds?: number;
}

/** Sign a 15-minute access token. */
export async function signAccessToken(opts: IssueAccessOptions): Promise<{ token: string; expiresIn: number }> {
  const ttl = opts.ttlSeconds ?? env.ACCESS_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    email: opts.email,
    tier: opts.tier,
    family: opts.familyId,
    type: 'access' satisfies TokenType,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'platematch-access-v1' })
    .setSubject(opts.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttl)
    .setJti(sha256(`${opts.userId}:${now}:${Math.random()}`).slice(0, 24))
    .sign(accessSecret());

  return { token, expiresIn: ttl };
}

/** Verify + decode an access token. Throws `UnauthorizedError` on any failure. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessSecret(), {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: '15s',
    });

    if (payload.type !== 'access' || typeof payload.sub !== 'string') {
      throw new UnauthorizedError('Invalid token type');
    }

    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      tier: String(payload.tier ?? 'free'),
      family: payload.family ? String(payload.family) : undefined,
      type: 'access',
      iat: Number(payload.iat ?? 0),
      exp: Number(payload.exp ?? 0),
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new UnauthorizedError('Session expired. Please sign in again.');
    if (err instanceof joseErrors.JWTClaimValidationFailed) throw new UnauthorizedError('Invalid token claims');
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError('Invalid or malformed token');
  }
}

export interface IssuedRefreshToken {
  /** Raw value — shown to the client exactly once. */
  token: string;
  /** SHA-256 of the raw value — this is what we persist. */
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

/**
 * Create a new refresh token. The raw value is wrapped in a signed JWT so it
 * can be validated cheaply before hitting the database, while the DB row is
 * the authoritative revocation list.
 */
export async function issueRefreshToken(userId: string, familyId?: string): Promise<IssuedRefreshToken> {
  const family = familyId ?? generateFamilyId();
  const jti = generateOpaqueToken(24);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + env.REFRESH_TOKEN_TTL_SECONDS;

  const jwt = await new SignJWT({ userId, family, jti, type: 'refresh' satisfies TokenType })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'platematch-refresh-v1' })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(`${env.JWT_AUDIENCE}:refresh`)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(refreshSecret());

  return {
    token: jwt,
    tokenHash: sha256(jwt),
    familyId: family,
    expiresAt: new Date(exp * 1000),
  };
}

export interface RefreshTokenClaims {
  userId: string;
  familyId: string;
  jti: string;
  tokenHash: string;
  exp: number;
}

/** Verify a refresh token's signature and shape (DB check happens separately). */
export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, refreshSecret(), {
      issuer: env.JWT_ISSUER,
      audience: `${env.JWT_AUDIENCE}:refresh`,
      algorithms: ['HS256'],
      clockTolerance: '30s',
    });

    if (payload.type !== 'refresh') throw new UnauthorizedError('Invalid token type');

    return {
      userId: String(payload.userId ?? payload.sub),
      familyId: String(payload.family ?? ''),
      jti: String(payload.jti ?? ''),
      tokenHash: sha256(token),
      exp: Number(payload.exp ?? 0),
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new UnauthorizedError('Refresh token expired');
    throw new UnauthorizedError('Invalid refresh token');
  }
}

/** Short-lived signed token used for the password-reset link. */
export async function signPasswordResetToken(userId: string): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const raw = generateOpaqueToken(32);
  const token = `${userId}.${raw}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  return { token, tokenHash: sha256(token), expiresAt };
}

/** Split a reset token into its (userId, hash) parts. */
export function parsePasswordResetToken(token: string): { userId: string; tokenHash: string } {
  const idx = token.indexOf('.');
  if (idx <= 0) throw new UnauthorizedError('Malformed reset token');
  return { userId: token.slice(0, idx), tokenHash: sha256(token) };
}

/** Pull a bearer token out of the Authorization header. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}
