import { z } from 'zod';
import { SUBSCRIPTION_TIERS } from '../constants/index.js';

export const checkoutSchema = z.object({
  tier: z.enum(['premium', 'family']),
  interval: z.enum(['monthly', 'yearly']),
  /** Start a 7-day free trial (ignored if the user already trialled). */
  trial: z.boolean().default(true),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** What a client may send — `trial` and the URLs all have server defaults. */
export type CheckoutRequest = z.input<typeof checkoutSchema>;

export const subscriptionStatusSchema = z.object({
  tier: z.enum(SUBSCRIPTION_TIERS),
  status: z.enum(['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'none']),
  expires_at: z.string().nullable(),
  cancel_at_period_end: z.boolean().default(false),
  interval: z.enum(['monthly', 'yearly']).nullable(),
  limits: z.record(z.string(), z.union([z.number(), z.boolean()])),
  usage: z.object({
    scans_used_this_week: z.number().int(),
    scans_remaining: z.number().int().nullable(),
    recipes_generated_today: z.number().int(),
    recipes_remaining_today: z.number().int().nullable(),
    meal_plans_this_month: z.number().int(),
    meal_plans_remaining: z.number().int().nullable(),
    pantry_items: z.number().int(),
    pantry_items_max: z.number().int().nullable(),
  }),
});
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const checkoutResponseSchema = z.object({
  /** Stripe Checkout URL to open in a browser / in-app webview. */
  checkout_url: z.string().url().nullable(),
  session_id: z.string().nullable(),
  /** True when Stripe is not configured (dev mode) — the client should show a notice. */
  simulated: z.boolean().default(false),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

export const portalResponseSchema = z.object({
  portal_url: z.string().url().nullable(),
  simulated: z.boolean().default(false),
});
export type PortalResponse = z.infer<typeof portalResponseSchema>;

/** Feature comparison table used by the Premium screen. */
export const planComparisonSchema = z.object({
  features: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      group: z.string(),
      values: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])),
    }),
  ),
  prices: z.array(
    z.object({
      tier: z.enum(SUBSCRIPTION_TIERS),
      monthly: z.number(),
      yearly: z.number(),
      currency: z.string(),
      savings_percent: z.number(),
    }),
  ),
});
export type PlanComparison = z.infer<typeof planComparisonSchema>;
