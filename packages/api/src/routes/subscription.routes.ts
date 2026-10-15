import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CheckoutInput } from '@platematch/shared';
import { checkoutSchema, PLAN_LIMITS, SUBSCRIPTION_TIERS } from '@platematch/shared';
import { z } from 'zod';
import { jsonSchemaFrom } from '../lib/openapi.js';
import { ok } from '../lib/http.js';
import { BadRequestError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { track } from '../plugins/telemetry.js';
import {
  cancelSubscription,
  createCheckoutSession,
  createPortalSession,
  getPlanLimits,
  getSubscriptionStatus,
  handleWebhook,
  restorePurchases,
} from '../services/subscription.service.js';

/**
 * Subscription routes (Section 4 — `/subscription/*`, Section 9 — Monetization).
 *
 *   Free     3 scans/week · 5 AI recipes/day · 1 meal plan/month · 50 pantry items
 *   Premium  $4.99/mo or $39.99/yr — unlimited scans and generation, price
 *            comparison, advanced analytics, voice cooking mode, no ads
 *   Family   $7.99/mo or $59.99/yr — Premium plus a shared household (6 members)
 *
 * When Stripe is not configured, checkout runs in `simulated` mode and grants
 * the tier locally, so the whole product stays testable end to end without a
 * payment account. The response flags this with `simulated: true` and the
 * Premium screen shows a notice.
 */

const PRICES = {
  premium: { monthly: 4.99, yearly: 39.99 },
  family: { monthly: 7.99, yearly: 59.99 },
} as const;

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /subscription/plans — public pricing table for the Premium screen
  // -------------------------------------------------------------------------
  app.get('/plans', {
    schema: {
      tags: ['subscription'],
      summary: 'Plan catalogue with limits and pricing',
      security: [],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                prices: { type: 'array', items: { type: 'object', additionalProperties: true } },
                features: { type: 'array', items: { type: 'object', additionalProperties: true } },
                limits: { type: 'object', additionalProperties: true },
                currency: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const prices = SUBSCRIPTION_TIERS.filter((tier) => tier !== 'free').map((tier) => {
      const price = PRICES[tier as keyof typeof PRICES];
      return {
        tier,
        monthly: price?.monthly ?? 0,
        yearly: price?.yearly ?? 0,
        currency: 'USD',
        savings_percent: price ? Math.round((1 - price.yearly / (price.monthly * 12)) * 100) : 0,
      };
    });

    return ok(reply, {
      prices,
      features: FEATURE_TABLE,
      limits: Object.fromEntries(SUBSCRIPTION_TIERS.map((tier) => [tier, getPlanLimits(tier)])),
      currency: 'USD',
    });
  });

  // -------------------------------------------------------------------------
  // GET /subscription/status
  // -------------------------------------------------------------------------
  app.get('/status', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['subscription'],
      summary: 'Current plan, limits and how much of each quota is used',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getSubscriptionStatus(request.user!.id)));

  // -------------------------------------------------------------------------
  // POST /subscription/checkout
  // -------------------------------------------------------------------------
  app.post('/checkout', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      tags: ['subscription'],
      summary: 'Start a Stripe Checkout session (or grant the tier in simulated mode)',
      body: jsonSchemaFrom(checkoutSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                checkout_url: { type: ['string', 'null'] },
                session_id: { type: ['string', 'null'] },
                simulated: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = checkoutSchema.parse(request.body) as CheckoutInput;
    const result = await createCheckoutSession(request.user!.id, input);

    track('checkout_started', request.user!.id, {
      tier: input.tier,
      interval: input.interval,
      simulated: result.simulated,
    });

    if (result.simulated) {
      logger.warn({ userId: request.user!.id, tier: input.tier }, 'Checkout simulated — Stripe is not configured');
    }

    return ok(reply, result);
  });

  // -------------------------------------------------------------------------
  // POST /subscription/portal
  // -------------------------------------------------------------------------
  app.post('/portal', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['subscription'],
      summary: 'Open the Stripe customer portal (invoices, payment method, cancel)',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { portal_url: { type: ['string', 'null'] }, simulated: { type: 'boolean' } },
            },
          },
        },
      },
    },
  }, async (request, reply) => ok(reply, await createPortalSession(request.user!.id)));

  // -------------------------------------------------------------------------
  // POST /subscription/restore
  // -------------------------------------------------------------------------
  app.post('/restore', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['subscription'],
      summary: 'Re-sync the plan from Stripe (Restore Purchases)',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await restorePurchases(request.user!.id)));

  // -------------------------------------------------------------------------
  // POST /subscription/cancel
  // -------------------------------------------------------------------------
  const cancelSchema = z.object({ immediate: z.boolean().default(false) });

  app.post('/cancel', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: {
      tags: ['subscription'],
      summary: 'Cancel at the end of the period (or immediately)',
      description:
        'By default the plan stays active until `expires_at` so the user keeps what they paid ' +
        'for. `immediate=true` downgrades to Free at once.',
      body: jsonSchemaFrom(cancelSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { canceled: { type: 'boolean' }, expires_at: { type: ['string', 'null'] } },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = cancelSchema.parse(request.body ?? {});
    const result = await cancelSubscription(request.user!.id, input.immediate);
    track('subscription_cancelled', request.user!.id, { immediate: input.immediate });
    return ok(reply, result);
  });

  // -------------------------------------------------------------------------
  // POST /subscription/webhook — Stripe, unauthenticated but signature-verified
  // -------------------------------------------------------------------------
  // Deliberately UNAUTHENTICATED: Stripe calls this directly and cannot present
  // a user token. Authenticating by HMAC signature over the raw body instead.
  app.post('/webhook', {
    config: { rateLimit: { allowList: () => true } },
    schema: {
      tags: ['subscription'],
      summary: 'Stripe webhook (signature-verified)',
      description:
        'Unauthenticated by design — Stripe cannot present a user token. The payload is ' +
        'verified against STRIPE_WEBHOOK_SECRET using the exact request bytes, so a ' +
        'forged or replayed body is rejected. Requires a 400, not a 401, when the ' +
        'signature header is missing.',
      security: [],
      consumes: ['application/json'],
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async (request: FastifyRequest, reply) => {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') throw new BadRequestError('Missing stripe-signature header');

    const raw = toRawBody(request);
    const result = await handleWebhook(raw, signature);

    if (result.handled && result.userId) {
      track('subscription_updated', result.userId, { event: result.type });
    }

    return reply.send({ received: true });
  });
}

/**
 * Stripe needs the exact bytes it sent. `plugins/raw-body.ts` captures them
 * before JSON parsing; the fallback keeps this handler usable in tests that
 * inject a pre-parsed body.
 */
function toRawBody(request: FastifyRequest): Buffer {
  if (request.rawBody?.length) return request.rawBody;
  const body = request.body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(JSON.stringify(body ?? {}), 'utf8');
}

/** Feature comparison rendered by the Premium screen. */
const FEATURE_TABLE = [
  {
    key: 'scans',
    label: 'Fridge scans',
    group: 'Scanning',
    values: { free: `${PLAN_LIMITS.free.scansPerWeek}/week`, premium: 'Unlimited', family: 'Unlimited' },
  },
  {
    key: 'recipes',
    label: 'AI recipe generation',
    group: 'AI',
    values: {
      free: `${PLAN_LIMITS.free.recipeGenerationsPerDay}/day`,
      premium: 'Unlimited',
      family: 'Unlimited',
    },
  },
  {
    key: 'plans',
    label: 'Weekly meal plans',
    group: 'AI',
    values: { free: `${PLAN_LIMITS.free.mealPlansPerMonth}/month`, premium: 'Unlimited', family: 'Unlimited' },
  },
  {
    key: 'pantry',
    label: 'Pantry items',
    group: 'Pantry',
    values: { free: PLAN_LIMITS.free.maxPantryItems, premium: 'Unlimited', family: 'Unlimited' },
  },
  { key: 'prices', label: 'Multi-store price comparison', group: 'Shopping', values: { free: PLAN_LIMITS.free.priceComparison, premium: true, family: true } },
  { key: 'analytics', label: 'Advanced savings analytics', group: 'Insights', values: { free: PLAN_LIMITS.free.advancedAnalytics, premium: true, family: true } },
  { key: 'voice', label: 'Hands-free voice cooking mode', group: 'Cooking', values: { free: PLAN_LIMITS.free.cookingModeVoice, premium: true, family: true } },
  { key: 'export', label: 'Export grocery lists (PDF / share)', group: 'Shopping', values: { free: PLAN_LIMITS.free.exportGroceryLists, premium: true, family: true } },
  { key: 'household', label: 'Shared household members', group: 'Family', values: { free: 0, premium: 0, family: PLAN_LIMITS.family.sharedHouseholdMembers } },
  { key: 'ads', label: 'Ads', group: 'Experience', values: { free: PLAN_LIMITS.free.ads, premium: false, family: false } },
];
