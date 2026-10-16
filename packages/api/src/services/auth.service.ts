import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { getDb } from '../db/index.js';
import { oauthAccounts, passwordResetTokens, refreshTokens, users, type User } from '../db/schema.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { generateFamilyId, generateOpaqueToken, hashPassword, passwordNeedsRehash, sanitizeText, sha256, verifyPassword } from '../lib/crypto.js';
import { issueRefreshToken, parsePasswordResetToken, signAccessToken, signPasswordResetToken, verifyRefreshToken } from '../lib/jwt.js';
import { env } from '../config/env.js';
import { calculateNutritionTargets } from '../utils/nutrition.js';
import { ensureNotificationPreferences, getUserDto } from './user.service.js';
import { registerDeviceToken } from './notification.service.js';
import type { AuthSession, OAuthAppleInput, OAuthGoogleInput } from '@platematch/shared';

/**
 * Authentication service
 * ===========================================================================
 * Email + password (Argon2id), Google and Apple OAuth, and rotating refresh
 * tokens with reuse detection.
 *
 * Refresh-token model
 * -------------------
 * Every token belongs to a *family*. On rotation the old row is revoked and a
 * new one is issued in the same family. If a revoked token is ever presented
 * again we treat it as theft and revoke the entire family, forcing re-login on
 * all devices in that lineage.
 */

export interface IssueTokensResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function register(input: {
  email: string;
  password: string;
  full_name: string;
  timezone?: string;
  locale?: string;
}): Promise<AuthSession> {
  const db = getDb();
  const email = input.email.toLowerCase().trim();

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length) throw new ConflictError('An account with this email already exists');

  const passwordHash = await hashPassword(input.password);
  const targets = calculateNutritionTargets({ healthGoal: 'eat_healthy', activityLevel: 'moderate' });

  const rows = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      fullName: sanitizeText(input.full_name).slice(0, 100),
      timezone: input.timezone ?? 'UTC',
      locale: input.locale ?? 'en',
      dailyCalorieTarget: targets.dailyCalorieTarget,
      dailyProteinTargetG: targets.dailyProteinTargetG,
      dailyCarbsTargetG: targets.dailyCarbsTargetG,
      dailyFatTargetG: targets.dailyFatTargetG,
    })
    .returning();

  const user = rows[0] as User;
  await ensureNotificationPreferences(user.id);
  logger.info({ userId: user.id, email }, 'User registered');

  return buildSession(user);
}

export async function login(input: { email: string; password: string; fcmToken?: string }): Promise<AuthSession> {
  const db = getDb();
  const email = input.email.toLowerCase().trim();

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0] as User | undefined;

  // Always run a hash comparison to avoid user enumeration via timing.
  const hash = user?.passwordHash;
  const valid = hash ? await verifyPassword(hash, input.password) : await verifyPassword(DUMMY_HASH, input.password).catch(() => false);

  if (!user || !hash || !valid) throw new UnauthorizedError('Incorrect email or password');

  // Transparent upgrade from scrypt (or old Argon2 params) on successful login.
  if (await passwordNeedsRehash(hash)) {
    const upgraded = await hashPassword(input.password);
    await db.update(users).set({ passwordHash: upgraded, updatedAt: new Date() }).where(eq(users.id, user.id));
    logger.info({ userId: user.id }, 'Password hash upgraded on login');
  }

  await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, user.id));
  if (input.fcmToken) {
    await registerDeviceToken(user.id, input.fcmToken, 'android').catch(() => undefined);
  }

  return buildSession(user);
}

/** Fixed-cost dummy hash so failed logins take the same time as successful ones. */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; userId: string }> {
  const db = getDb();
  const claims = await verifyRefreshToken(rawToken);

  const rows = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, claims.tokenHash))
    .limit(1);

  const stored = rows[0];
  if (!stored) throw new UnauthorizedError('Refresh token is not recognised');

  // Reuse detection: a revoked token being replayed means it was stolen.
  if (stored.revokedAt) {
    logger.warn({ userId: stored.userId, familyId: stored.familyId }, 'Refresh token reuse detected — revoking the family');
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.familyId, stored.familyId));
    throw new UnauthorizedError('Session was revoked for security reasons. Please sign in again.');
  }

  if (stored.expiresAt.getTime() < Date.now()) throw new UnauthorizedError('Refresh token expired');
  if (stored.userId !== claims.userId) throw new UnauthorizedError('Refresh token mismatch');

  const user = (await db.select().from(users).where(eq(users.id, stored.userId)).limit(1))[0] as User | undefined;
  if (!user) throw new UnauthorizedError('Account no longer exists');

  // Rotate.
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, stored.id));
  const issued = await issueRefreshToken(user.id, stored.familyId);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: issued.tokenHash,
    familyId: issued.familyId,
    expiresAt: issued.expiresAt,
    rotatedFromId: stored.id,
  });

  const access = await signAccessToken({ userId: user.id, email: user.email, tier: user.subscriptionTier, familyId: issued.familyId });

  return { accessToken: access.token, refreshToken: issued.token, expiresIn: access.expiresIn, userId: user.id };
}

export async function logout(userId: string, rawRefreshToken?: string): Promise<void> {
  const db = getDb();
  if (rawRefreshToken) {
    const claims = await verifyRefreshToken(rawRefreshToken).catch(() => null);
    if (claims) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.familyId, claims.familyId));
      return;
    }
  }
  // No token supplied → revoke everything for this user.
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Always resolves successfully (no user enumeration). Returns the token only
 * when the account exists AND we are not in production — in production it is
 * delivered by email/notification instead.
 */
export async function requestPasswordReset(email: string): Promise<{ token?: string }> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1);
  const user = rows[0] as User | undefined;
  if (!user) return {};

  const { token, tokenHash, expiresAt } = await signPasswordResetToken(user.id);
  await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash, expiresAt });

  logger.info({ userId: user.id }, 'Password reset token issued');

  if (env.NODE_ENV === 'production') {
    // In production this would be emailed via a transactional provider.
    // We return nothing so the endpoint cannot be used to enumerate accounts.
    return {};
  }
  return { token };
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const db = getDb();
  const { userId, tokenHash } = parsePasswordResetToken(rawToken);

  const rows = await db
    .select()
    .from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.tokenHash, tokenHash), eq(passwordResetTokens.userId, userId)))
    .limit(1);

  const record = rows[0];
  if (!record) throw new UnauthorizedError('Reset link is invalid');
  if (record.usedAt) throw new UnauthorizedError('This reset link has already been used');
  if (record.expiresAt.getTime() < Date.now()) throw new UnauthorizedError('This reset link has expired');

  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, record.id));
    // Invalidate every active session.
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  });

  logger.info({ userId }, 'Password reset completed');
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

interface OAuthProfile {
  provider: 'google' | 'apple';
  providerAccountId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
}

/** Verify a Google ID token and extract the profile. */
export async function verifyGoogleIdToken(idToken: string): Promise<OAuthProfile> {
  if (env.INSECURE_SKIP_OAUTH_VERIFY) {
    // Local development escape hatch — decodes without signature verification.
    const payload = decodeJwtPayload(idToken);
    return {
      provider: 'google',
      providerAccountId: String(payload.sub ?? payload.id ?? ''),
      email: String(payload.email ?? '').toLowerCase(),
      fullName: payload.name ? String(payload.name) : null,
      avatarUrl: payload.picture ? String(payload.picture) : null,
      emailVerified: Boolean(payload.email_verified ?? true),
    };
  }

  try {
    const { payload } = await jwtVerify(idToken, googleJwks, {
      audience: env.GOOGLE_CLIENT_ID,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      clockTolerance: '30s',
    });

    return {
      provider: 'google',
      providerAccountId: String(payload.sub),
      email: String(payload.email ?? '').toLowerCase(),
      fullName: payload.name ? String(payload.name) : null,
      avatarUrl: payload.picture ? String(payload.picture) : null,
      emailVerified: Boolean(payload.email_verified),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Google ID token verification failed');
    throw new UnauthorizedError('Google sign-in failed. Please try again.');
  }
}

/** Verify an Apple identity token and extract the profile. */
export async function verifyAppleIdentityToken(identityToken: string): Promise<OAuthProfile> {
  if (env.INSECURE_SKIP_OAUTH_VERIFY) {
    const payload = decodeJwtPayload(identityToken);
    return {
      provider: 'apple',
      providerAccountId: String(payload.sub ?? ''),
      email: String(payload.email ?? '').toLowerCase(),
      fullName: payload.name ? String(payload.name) : null,
      avatarUrl: null,
      emailVerified: true,
    };
  }

  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      audience: env.APPLE_CLIENT_ID,
      issuer: 'https://appleid.apple.com',
      clockTolerance: '30s',
    });

    return {
      provider: 'apple',
      providerAccountId: String(payload.sub),
      email: String(payload.email ?? '').toLowerCase(),
      fullName: null,
      avatarUrl: null,
      emailVerified: Boolean(payload.email_verified === true || payload.email_verified === 'true'),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Apple identity token verification failed');
    throw new UnauthorizedError('Apple sign-in failed. Please try again.');
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new UnauthorizedError('Malformed OAuth token');
  }
}

export async function oauthGoogle(input: OAuthGoogleInput): Promise<AuthSession> {
  const profile = await verifyGoogleIdToken(input.id_token);
  if (!profile.email) throw new UnauthorizedError('Google did not provide an email address');
  return oauthSignInOrCreate(profile, input.fcm_token);
}

export async function oauthApple(input: OAuthAppleInput): Promise<AuthSession> {
  const profile = await verifyAppleIdentityToken(input.identity_token);
  // Apple hides the email on every sign-in after the first; fall back to the
  // client-supplied one — but that address is unverified, so it may never be
  // used to link this provider to an existing account (see `oauthSignInOrCreate`).
  if (!profile.email && input.email) {
    profile.email = input.email.toLowerCase();
    profile.emailVerified = false;
  }
  if (!profile.fullName && input.full_name) profile.fullName = input.full_name;
  if (!profile.email) throw new UnauthorizedError('Apple did not provide an email address');
  return oauthSignInOrCreate(profile, input.fcm_token);
}

async function oauthSignInOrCreate(profile: OAuthProfile, fcmToken?: string): Promise<AuthSession> {
  const db = getDb();

  // 1. Existing OAuth link?
  const linked = await db
    .select({ user: users, link: oauthAccounts })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(and(eq(oauthAccounts.provider, profile.provider), eq(oauthAccounts.providerAccountId, profile.providerAccountId)))
    .limit(1);

  if (linked[0]) {
    const user = linked[0].user as User;
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, user.id));
    if (fcmToken) await registerDeviceToken(user.id, fcmToken, 'ios').catch(() => undefined);
    return buildSession(user);
  }

  // 2. Email already registered with a password? Link the provider to it — but
  // only when the provider *vouches* for the address. An unverified Google
  // email (or the client-supplied email on an Apple token) proves nothing about
  // ownership, and linking on it would hand the account to whoever presents
  // that address.
  const byEmail = await db.select().from(users).where(eq(users.email, profile.email)).limit(1);
  if (byEmail[0] && !profile.emailVerified) {
    logger.warn(
      { provider: profile.provider, email: profile.email },
      'Refused to link an unverified OAuth email to an existing account',
    );
    throw new UnauthorizedError(
      'That email is already registered. Sign in with your password, then connect this provider from settings.',
    );
  }

  if (byEmail[0]) {
    const user = byEmail[0] as User;
    await db.insert(oauthAccounts).values({
      userId: user.id,
      provider: profile.provider,
      providerAccountId: profile.providerAccountId,
      email: profile.email,
    });
    // Reaching here means the provider asserted the address, so marking it
    // verified is warranted.
    const patch: Partial<User> = { lastActiveAt: new Date(), emailVerified: true };
    if (!user.avatarUrl && profile.avatarUrl) patch.avatarUrl = profile.avatarUrl;
    await db.update(users).set(patch).where(eq(users.id, user.id));
    if (fcmToken) await registerDeviceToken(user.id, fcmToken, profile.provider === 'apple' ? 'ios' : 'android').catch(() => undefined);
    return buildSession(user);
  }

  // 3. Brand-new account.
  const targets = calculateNutritionTargets({ healthGoal: 'eat_healthy', activityLevel: 'moderate' });
  const created = await db
    .insert(users)
    .values({
      email: profile.email,
      fullName: sanitizeText(profile.fullName ?? profile.email.split('@')[0] ?? 'PlateMatch User').slice(0, 100),
      avatarUrl: profile.avatarUrl,
      emailVerified: profile.emailVerified,
      dailyCalorieTarget: targets.dailyCalorieTarget,
      dailyProteinTargetG: targets.dailyProteinTargetG,
      dailyCarbsTargetG: targets.dailyCarbsTargetG,
      dailyFatTargetG: targets.dailyFatTargetG,
    })
    .returning();

  const user = created[0] as User;
  await db.insert(oauthAccounts).values({
    userId: user.id,
    provider: profile.provider,
    providerAccountId: profile.providerAccountId,
    email: profile.email,
  });
  await ensureNotificationPreferences(user.id);
  if (fcmToken) await registerDeviceToken(user.id, fcmToken, profile.provider === 'apple' ? 'ios' : 'android').catch(() => undefined);

  logger.info({ userId: user.id, provider: profile.provider }, 'OAuth account created');
  return buildSession(user);
}

// ---------------------------------------------------------------------------
// Session assembly
// ---------------------------------------------------------------------------

async function buildSession(user: User): Promise<AuthSession> {
  const db = getDb();
  const familyId = generateFamilyId();

  const access = await signAccessToken({
    userId: user.id,
    email: user.email,
    tier: user.subscriptionTier,
    familyId,
  });

  const issued = await issueRefreshToken(user.id, familyId);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: issued.tokenHash,
    familyId: issued.familyId,
    expiresAt: issued.expiresAt,
  });

  return {
    user: await getUserDto(user.id),
    access_token: access.token,
    refresh_token: issued.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
  } satisfies AuthSession;
}

/** Housekeeping: drop expired refresh/reset tokens (nightly cron). */
export async function purgeExpiredTokens(): Promise<{ refresh: number; resets: number }> {
  const db = getDb();
  const now = new Date();

  const removedRefresh = await db
    .delete(refreshTokens)
    .where(
      or(
        lt(refreshTokens.expiresAt, now),
        lt(refreshTokens.revokedAt, new Date(now.getTime() - 30 * 86_400_000)),
      ),
    )
    .returning({ id: refreshTokens.id });

  const removedResets = await db
    .delete(passwordResetTokens)
    .where(lt(passwordResetTokens.expiresAt, now))
    .returning({ id: passwordResetTokens.id });

  return { refresh: removedRefresh.length, resets: removedResets.length };
}

/** Convenience re-export used by tests. */
export { sha256 };

export async function countActiveSessions(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));
  return Number(rows[0]?.count ?? 0);
}

export async function findUserForTest(email: string): Promise<User | undefined> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] as User | undefined;
}

export { NotFoundError };
