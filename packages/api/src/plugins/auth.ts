import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PLAN_LIMITS, type PlanLimits, type SubscriptionTier } from '@platematch/shared';
import { env } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { extractBearerToken, verifyAccessToken, type AccessTokenClaims } from '../lib/jwt.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { getUserById, touchLastActive } from '../services/user.service.js';
import type { User } from '../db/schema.js';

/**
 * Authentication & feature gating (Sections 8 and 9).
 *
 * Three decorators:
 *
 *   `authenticate`   — requires a valid access token (15 min TTL). Rejects
 *                      tokens whose user has been blocked since issuance
 *                      (password change, logout-all, account deletion) using a
 *                      short-lived Redis marker rather than a DB round-trip.
 *   `optionalAuth`   — attaches the user when a token is present, otherwise
 *                      continues anonymously (public recipe browsing).
 *   `requirePlan(..)`— Premium/Family gate. The tier lives in the token, so
 *                      gating costs nothing extra.
 *
 * Access tokens are read from `Authorization: Bearer <jwt>`. A `refresh_token`
 * cookie is also accepted so the Swagger UI can be used from a browser.
 */

export interface RequestUser {
  id: string;
  email: string;
  tier: string;
  family?: string;
}

const BLOCKED_PREFIX = 'user:blocked:';

/** Mark a user's existing access tokens as invalid (logout-all, password reset). */
export async function blockUserTokens(userId: string, seconds = env.ACCESS_TOKEN_TTL_SECONDS): Promise<void> {
  await cache.set(`${BLOCKED_PREFIX}${userId}`, '1', seconds);
}

export async function isUserBlocked(userId: string): Promise<boolean> {
  return (await cache.get<string>(`${BLOCKED_PREFIX}${userId}`)) !== null;
}

async function resolveUser(request: FastifyRequest): Promise<RequestUser | null> {
  const headerToken = extractBearerToken(request.headers.authorization);
  const cookieToken =
    typeof request.cookies?.refresh_token === 'string' ? (request.cookies.refresh_token as string) : null;
  const token = headerToken ?? cookieToken;

  if (!token) return null;

  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(token);
  } catch (err) {
    const message = (err as Error).message;
    // Surface a useful message for the common failure modes.
    if (/expired/i.test(message)) throw new UnauthorizedError('Your session has expired. Please sign in again.');
    throw new UnauthorizedError('Invalid authentication token.');
  }

  if (await isUserBlocked(claims.sub)) {
    throw new UnauthorizedError('Your session was ended. Please sign in again.');
  }

  return { id: claims.sub, email: claims.email, tier: claims.tier, family: claims.family };
}

/** Load the full user row, cached for a minute to keep hot paths cheap. */
async function loadUserRow(userId: string): Promise<User | null> {
  const key = CacheKeys.userProfile(userId);
  const cachedRow = await cache.get<User>(key);
  if (cachedRow) return cachedRow;

  const user = await getUserById(userId);
  if (user) await cache.set(key, user, 60);
  return user;
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  /** Reject the request unless a valid access token is present. */
  app.decorate('authenticate', async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
    const user = await resolveUser(request);
    if (!user) throw new UnauthorizedError('Authentication required. Send an Authorization: Bearer <token> header.');
    request.user = user;
    request.limits = planLimitsFor(user.tier);
  });

  /** Attach the user when present; never throws for a missing token. */
  app.decorate('optionalAuth', async function optionalAuth(request: FastifyRequest, _reply: FastifyReply) {
    try {
      const user = await resolveUser(request);
      if (user) {
        request.user = user;
        request.limits = planLimitsFor(user.tier);
      }
    } catch {
      // An invalid token on an optional-auth route must not fail the request.
      request.user = undefined;
    }
  });

  /**
   * Premium/Family gate.
   * Usage: `preHandler: [app.authenticate, app.requirePlan('premium')]`
   */
  app.decorate('requirePlan', function requirePlan(minimumTier: Exclude<SubscriptionTier, 'free'>) {
    return async function planGate(request: FastifyRequest, reply: FastifyReply) {
      const user = request.user;
      if (!user) throw new UnauthorizedError();

      // A fresh tier beats the token claim: subscriptions can lapse mid-session.
      const fresh = await loadUserRow(user.id);
      const tier = (fresh?.subscriptionTier ?? user.tier) as SubscriptionTier;

      const expired = fresh?.subscriptionExpiresAt ? fresh.subscriptionExpiresAt.getTime() < Date.now() : false;
      const effective: SubscriptionTier = expired && tier !== 'free' ? 'free' : tier;

      if (!tierAllows(effective, minimumTier)) {
        throw new ForbiddenError(
          `This feature is part of the ${capitalize(minimumTier)} plan. Upgrade to unlock it.`,
        );
      }

      request.user = { ...user, tier: effective };
      request.limits = planLimitsFor(effective);
      void reply;
    };
  });

  /** Attach the full user row (profile, targets, preferences) to the request. */
  app.decorate('withUser', async function withUser(request: FastifyRequest) {
    const id = request.user?.id;
    if (!id) throw new UnauthorizedError();
    const user = await loadUserRow(id);
    if (!user || user.deletedAt) throw new UnauthorizedError('This account is no longer available.');
    request.fullUser = user;
    // Throttled "last seen" write — at most once per minute per user.
    void touchLastActive(id).catch(() => undefined);
  });
}

const TIER_RANK: Record<string, number> = { free: 0, premium: 1, family: 2 };

/** True when `tier` includes everything `required` includes. */
export function tierAllows(tier: string, required: SubscriptionTier): boolean {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[required] ?? 0);
}

export function planLimitsFor(tier: string): PlanLimits {
  return PLAN_LIMITS[(tier as SubscriptionTier) ?? 'free'] ?? PLAN_LIMITS.free;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default fp(authPlugin, { name: 'auth', fastify: '5.x' });

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    optionalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requirePlan(minimumTier: Exclude<SubscriptionTier, 'free'>): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    withUser(request: FastifyRequest): Promise<void>;
  }

  interface FastifyRequest {
    user?: RequestUser;
    fullUser?: User;
    limits?: PlanLimits;
  }
}
