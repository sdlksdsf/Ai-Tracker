/**
 * AI cost accounting.
 *
 * Every provider call records prompt/completion tokens and the USD cost, which
 * is written to `ai_usage_logs` and rolled up per user in `usage_counters`.
 * That gives us the "monitor API costs per user (prevent abuse)" requirement
 * from Section 8 and makes the burn rate visible in Grafana/PostHog.
 *
 * Prices are USD per 1M tokens and are deliberately easy to update: when a
 * provider cuts prices you change one number here.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per image (some vision APIs bill per image, not per token). */
  perImage?: number;
}

/**
 * Prefix-matched pricing table. The first entry whose prefix matches the model
 * id wins, so `gemini-3-pro-preview-04-01` still resolves to `gemini-3-pro`.
 */
const PRICING: Array<[prefix: string, pricing: ModelPricing]> = [
  // ---- Google Gemini -----------------------------------------------------
  ['gemini-3-pro', { input: 2.0, output: 12.0 }],
  ['gemini-3-flash', { input: 0.3, output: 2.5 }],
  ['gemini-2.5-pro', { input: 1.25, output: 10.0 }],
  ['gemini-2.5-flash-lite', { input: 0.1, output: 0.4 }],
  ['gemini-2.5-flash', { input: 0.3, output: 2.5 }],
  ['gemini-pro-latest', { input: 1.25, output: 10.0 }],
  ['gemini-flash-latest', { input: 0.3, output: 2.5 }],

  // ---- OpenAI ------------------------------------------------------------
  ['gpt-5.6-sol', { input: 5.0, output: 25.0 }],
  ['gpt-5.6-terra', { input: 2.5, output: 12.5 }],
  ['gpt-5.6-luna', { input: 0.5, output: 2.5 }],
  ['gpt-5.5-pro', { input: 30.0, output: 180.0 }],
  ['gpt-5.5', { input: 5.0, output: 30.0 }],
  ['gpt-5.4-mini', { input: 0.75, output: 4.5 }],
  ['gpt-5.4-nano', { input: 0.2, output: 1.25 }],
  ['gpt-5.4', { input: 2.5, output: 15.0 }],
  ['gpt-5', { input: 1.25, output: 10.0 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6 }],
  ['gpt-4o', { input: 2.5, output: 10.0 }],

  // ---- Anthropic ---------------------------------------------------------
  ['claude-fable', { input: 10.0, output: 50.0 }],
  ['claude-opus', { input: 5.0, output: 25.0 }],
  ['claude-sonnet', { input: 2.0, output: 10.0 }],
  ['claude-haiku', { input: 1.0, output: 5.0 }],
];

/** Google Cloud Vision is billed per 1000 units. */
const CLOUD_VISION_COST_PER_1000 = 1.5;
/** Edamam free tier: $0. Free tier is assumed unless a paid plan is set. */
const EDAMAM_COST_PER_CALL = 0;
const SPOONACULAR_COST_PER_CALL = 0;
const KROGER_COST_PER_CALL = 0;

export function priceForModel(model: string): ModelPricing | null {
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of PRICING) {
    if (lower.startsWith(prefix)) return pricing;
  }
  return null;
}

export interface CostInput {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  images?: number;
}

/** Compute the USD cost of a single model call. */
export function computeCost(input: CostInput): number {
  const pricing = priceForModel(input.model);
  if (!pricing) return 0;

  const prompt = input.promptTokens ?? 0;
  const completion = input.completionTokens ?? 0;
  const images = input.images ?? 0;

  const tokenCost = (prompt / 1_000_000) * pricing.input + (completion / 1_000_000) * pricing.output;
  const imageCost = images * (pricing.perImage ?? 0);

  return round6(tokenCost + imageCost);
}

export function cloudVisionCost(units: number): number {
  return round6((units / 1000) * CLOUD_VISION_COST_PER_1000);
}

export function edamamCost(): number {
  return EDAMAM_COST_PER_CALL;
}

export function spoonacularCost(): number {
  return SPOONACULAR_COST_PER_CALL;
}

export function krogerCost(): number {
  return KROGER_COST_PER_CALL;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Rough token estimate for a string when the provider does not report usage. */
export function estimateTokens(text: string): number {
  // ~4 characters per token for English; slightly more for structured JSON.
  return Math.ceil(text.length / 3.6);
}
