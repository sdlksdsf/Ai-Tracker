import { and, eq, sql } from 'drizzle-orm';
import type {
  CheckoutInput,
  CheckoutResponse,
  PlanLimits,
  PortalResponse,
  SubscriptionStatus,
} from '@platematch/shared';
import { PLAN_LIMITS, DEEP_LINK_ROUTES } from '@platematch/shared';
import Stripe from 'stripe';
import { getDb } from '../db/index.js';
import { fridgeScans, mealPlans, pantryItems, users, type User } from '../db/schema.js';
import { env, hasStripeKeys } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { NotFoundError } from '../lib/errors.js';
import { isoWeekKey, monthKey } from '../utils/dates.js';
import { getUsage } from './ai/ledger.js';

/**
 * Subscription & feature gating (Section 9).
 *
 * Stripe Billing drives the lifecycle; `users.subscription_tier` is the cached
 * source of truth used by the feature-gating middleware so a request never has
 * to call Stripe to answer "can this user do X?".
 *
 * When Stripe credentials are absent (local dev, self-hosters) checkout and
 * portal return `simulated: true` and the tier can be flipped directly with
 * `POST /subscription/checkout?simulate=true` — the app remains fully testable.
 */

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!hasStripeKeys) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(env.STRIPE_SECRET_KEY as string, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
      typescript: true,
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }
  return stripeClient;
}

export function getPlanLimits(tier: string): PlanLimits {
  return PLAN_LIMITS[(tier as keyof typeof PLAN_LIMITS) ?? 'free'] ?? PLAN_LIMITS.free;
}

export function hasFeature(user: { subscription_tier: string }, feature: keyof PlanLimits): boolean {
  const limits = getPlanLimits(user.subscription_tier);
  const value = limits[feature];
  return typeof value === 'boolean' ? value : Number(value) !== 0;
}

// ---------------------------------------------------------------------------
// Status + usage
// ---------------------------------------------------------------------------

export async function getSubscriptionStatus(userId: string): Promise<SubscriptionStatus> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User not found');

  // Expired subscriptions degrade to free automatically.
  const expired = user.subscriptionExpiresAt !== null && user.subscriptionExpiresAt.getTime() < Date.now();
  const tier = expired ? 'free' : user.subscriptionTier;

  if (expired && user.subscriptionTier !== 'free') {
    await db
      .update(users)
      .set({ subscriptionTier: 'free', subscriptionStatus: 'expired', updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  const limits = getPlanLimits(tier);
  const [scans, plans, pantryCount] = await Promise.all([
    getUsage(userId, `scan:${isoWeekKey()}`),
    countMealPlansThisMonth(userId),
    countActivePantryItems(userId),
  ]);

  const recipesToday = await getUsage(userId, `recipe:${new Date().toISOString().slice(0, 10)}`);

  const remaining = (limit: number, used: number) => (limit < 0 ? null : Math.max(0, limit - used));

  return {
    tier,
    status: expired ? 'none' : (normalizeStripeStatus(user.subscriptionStatus) as SubscriptionStatus['status']),
    expires_at: user.subscriptionExpiresAt ? user.subscriptionExpiresAt.toISOString() : null,
    cancel_at_period_end: user.cancelAtPeriodEnd,
    interval: (user.subscriptionInterval as SubscriptionStatus['interval']) ?? null,
    limits: {
      scans_per_week: limits.scansPerWeek,
      recipe_generations_per_day: limits.recipeGenerationsPerDay,
      meal_plans_per_month: limits.mealPlansPerMonth,
      max_pantry_items: limits.maxPantryItems,
      price_comparison: limits.priceComparison,
      advanced_analytics: limits.advancedAnalytics,
      cooking_mode_voice: limits.cookingModeVoice,
      export_grocery_lists: limits.exportGroceryLists,
      ads: limits.ads,
      shared_household_members: limits.sharedHouseholdMembers,
    },
    usage: {
      scans_used_this_week: scans.count,
      scans_remaining: remaining(limits.scansPerWeek, scans.count),
      recipes_generated_today: recipesToday.count,
      recipes_remaining_today: remaining(limits.recipeGenerationsPerDay, recipesToday.count),
      meal_plans_this_month: plans,
      meal_plans_remaining: remaining(limits.mealPlansPerMonth, plans),
      pantry_items: pantryCount,
      pantry_items_max: remaining(limits.maxPantryItems, 0) === null ? null : limits.maxPantryItems,
    },
  };
}

function normalizeStripeStatus(status: string | null): string {
  if (!status || status === 'none') return 'none';
  const allowed = ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'none'];
  return allowed.includes(status) ? status : 'none';
}

async function countMealPlansThisMonth(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mealPlans)
    .where(and(eq(mealPlans.userId, userId), sql`to_char(${mealPlans.createdAt}, 'YYYY-MM') = ${monthKey()}`));
  return Number(rows[0]?.count ?? 0);
}

async function countActivePantryItems(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pantryItems)
    .where(and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false)));
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Checkout / portal
// ---------------------------------------------------------------------------

const PRICE_ENV_KEYS: Record<string, Record<string, string | undefined>> = {
  'premium:monthly': { id: env.STRIPE_PRICE_PREMIUM_MONTHLY },
  'premium:yearly': { id: env.STRIPE_PRICE_PREMIUM_YEARLY },
  'family:monthly': { id: env.STRIPE_PRICE_FAMILY_MONTHLY },
  'family:yearly': { id: env.STRIPE_PRICE_FAMILY_YEARLY },
};

function priceIdFor(tier: string, interval: string): string | undefined {
  return PRICE_ENV_KEYS[`${tier}:${interval}`]?.id;
}

export async function createCheckoutSession(userId: string, input: CheckoutInput): Promise<CheckoutResponse> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User not found');

  const stripe = getStripe();
  const priceId = priceIdFor(input.tier, input.interval);

  // Simulated mode: no Stripe key or no price configured → grant immediately.
  if (!stripe || !priceId) {
    logger.warn({ userId, tier: input.tier, hasStripe: Boolean(stripe), hasPrice: Boolean(priceId) }, 'Stripe not fully configured — simulating checkout');

    const days = input.interval === 'yearly' ? 365 : 30;
    await db
      .update(users)
      .set({
        subscriptionTier: input.tier,
        subscriptionStatus: input.trial && !user.trialUsed ? 'trialing' : 'active',
        subscriptionInterval: input.interval,
        subscriptionExpiresAt: new Date(Date.now() + days * 86_400_000),
        cancelAtPeriodEnd: false,
        trialUsed: user.trialUsed || input.trial,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return { checkout_url: null, session_id: null, simulated: true };
  }

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.fullName,
      metadata: { userId },
    });
    customerId = customer.id;
    await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${input.success_url ?? env.FRONTEND_URL}/premium?status=success`,
    cancel_url: `${input.cancel_url ?? env.FRONTEND_URL}/premium?status=cancelled`,
    client_reference_id: userId,
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { userId, tier: input.tier, interval: input.interval },
      ...(input.trial && !user.trialUsed ? { trial_period_days: 7 } : {}),
    },
    metadata: { userId, tier: input.tier, interval: input.interval },
  });

  return { checkout_url: session.url, session_id: session.id, simulated: false };
}

export async function createPortalSession(userId: string): Promise<PortalResponse> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User not found');

  const stripe = getStripe();
  if (!stripe || !user.stripeCustomerId) {
    return { portal_url: null, simulated: true };
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${env.FRONTEND_URL}${DEEP_LINK_ROUTES.profile}`,
  });

  return { portal_url: session.url, simulated: false };
}

export async function cancelSubscription(userId: string, immediate = false): Promise<{ canceled: boolean; expires_at: string | null }> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User not found');

  const stripe = getStripe();
  if (stripe && user.stripeCustomerId) {
    const subscriptions = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'active', limit: 1 });
    const subscription = subscriptions.data[0];
    if (subscription) {
      if (immediate) {
        await stripe.subscriptions.cancel(subscription.id);
      } else {
        await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
      }
    }
  }

  if (immediate) {
    await db
      .update(users)
      .set({ subscriptionTier: 'free', subscriptionStatus: 'canceled', subscriptionExpiresAt: null, cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return { canceled: true, expires_at: null };
  }

  await db.update(users).set({ cancelAtPeriodEnd: true, updatedAt: new Date() }).where(eq(users.id, userId));
  return {
    canceled: true,
    expires_at: user.subscriptionExpiresAt ? user.subscriptionExpiresAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface WebhookResult {
  handled: boolean;
  type: string;
  userId?: string;
}

/** Verify + apply a Stripe webhook event. */
export async function handleWebhook(rawBody: Buffer, signature: string): Promise<WebhookResult> {
  const stripe = getStripe();
  if (!stripe) {
    logger.warn('Stripe webhook received but no secret key configured');
    return { handled: false, type: 'ignored' };
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET as string);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Invalid Stripe webhook signature');
    throw new Error(`Webhook signature verification failed: ${(err as Error).message}`);
  }

  const db = getDb();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id ?? session.metadata?.userId;
      const tier = (session.metadata?.tier ?? 'premium') as 'premium' | 'family';
      const interval = (session.metadata?.interval ?? 'monthly') as 'monthly' | 'yearly';
      if (!userId) return { handled: false, type: event.type };

      await db
        .update(users)
        .set({
          subscriptionTier: tier,
          subscriptionStatus: 'active',
          subscriptionInterval: interval,
          subscriptionExpiresAt: new Date(Date.now() + (interval === 'yearly' ? 365 : 30) * 86_400_000),
          cancelAtPeriodEnd: false,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return { handled: true, type: event.type, userId };
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.userId ?? (await findUserIdByCustomer(subscription.customer as string));
      if (!userId) return { handled: false, type: event.type };

      const item = subscription.items.data[0];
      const interval = item?.price.recurring?.interval === 'year' ? 'yearly' : 'monthly';
      const tier = tierFromPrice(item?.price.id ?? '');

      await db
        .update(users)
        .set({
          subscriptionTier: subscription.status === 'active' || subscription.status === 'trialing' ? tier : 'free',
          subscriptionStatus: subscription.status,
          subscriptionInterval: interval,
          subscriptionExpiresAt: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return { handled: true, type: event.type, userId };
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.userId ?? (await findUserIdByCustomer(subscription.customer as string));
      if (!userId) return { handled: false, type: event.type };

      await db
        .update(users)
        .set({ subscriptionTier: 'free', subscriptionStatus: 'canceled', cancelAtPeriodEnd: false, updatedAt: new Date() })
        .where(eq(users.id, userId));

      return { handled: true, type: event.type, userId };
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const userId = invoice.metadata?.userId ?? (await findUserIdByCustomer(String(invoice.customer ?? '')));
      if (!userId) return { handled: false, type: event.type };

      await db.update(users).set({ subscriptionStatus: 'past_due', updatedAt: new Date() }).where(eq(users.id, userId));
      return { handled: true, type: event.type, userId };
    }

    default:
      logger.debug({ type: event.type }, 'Unhandled Stripe event');
      return { handled: false, type: event.type };
  }
}

function tierFromPrice(priceId: string): 'premium' | 'family' {
  if (priceId && (priceId === env.STRIPE_PRICE_FAMILY_MONTHLY || priceId === env.STRIPE_PRICE_FAMILY_YEARLY)) return 'family';
  return 'premium';
}

async function findUserIdByCustomer(customerId: string): Promise<string | null> {
  if (!customerId) return null;
  const db = getDb();
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.stripeCustomerId, customerId)).limit(1);
  return rows[0]?.id ?? null;
}

/** Restore purchases: re-sync the tier from Stripe for this user. */
export async function restorePurchases(userId: string): Promise<SubscriptionStatus> {
  const db = getDb();
  const stripe = getStripe();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User not found');

  if (stripe && user.stripeCustomerId) {
    const subscriptions = await stripe.subscriptions.list({ customer: user.stripeCustomerId, limit: 1 });
    const subscription = subscriptions.data[0];
    if (subscription) {
      const item = subscription.items.data[0];
      const interval = item?.price.recurring?.interval === 'year' ? 'yearly' : 'monthly';
      await db
        .update(users)
        .set({
          subscriptionTier: subscription.status === 'active' || subscription.status === 'trialing' ? tierFromPrice(item?.price.id ?? '') : 'free',
          subscriptionStatus: subscription.status,
          subscriptionInterval: interval,
          subscriptionExpiresAt: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    }
  }

  return getSubscriptionStatus(userId);
}

