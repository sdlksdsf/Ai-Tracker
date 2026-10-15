import { describe, expect, it } from 'vitest';
import {
  cloudVisionCost,
  computeCost,
  edamamCost,
  estimateTokens,
  krogerCost,
  priceForModel,
  round4,
  spoonacularCost,
} from '../../src/services/ai/cost.js';

/**
 * AI cost accounting.
 *
 * Every call is metered against a per-user daily spend cap, so an error here is
 * either a silent billing surprise or a user locked out of a feature they have
 * paid for. The pricing table must resolve every model the app actually
 * configures, including dated suffixes.
 */

describe('priceForModel', () => {
  it('resolves the models this deployment configures by default', () => {
    // These are the env defaults in config/env.ts — if one stops resolving, the
    // ledger records $0 for every call and the spend cap never trips.
    for (const model of ['gemini-3-pro', 'gemini-3-flash', 'claude-sonnet-5', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(priceForModel(model), model).not.toBeNull();
    }
  });

  it('resolves dated and preview suffixes by prefix', () => {
    expect(priceForModel('gemini-3-pro-preview-04-01')).not.toBeNull();
    expect(priceForModel('claude-sonnet-5-20260215')).not.toBeNull();
    expect(priceForModel('gpt-5.6-terra-2026-07-30')).not.toBeNull();
  });

  it('is case-insensitive', () => {
    expect(priceForModel('GEMINI-3-PRO')).toEqual(priceForModel('gemini-3-pro'));
  });

  it('prefers the most specific prefix', () => {
    // "gpt-5.6-luna" must not resolve to the broader "gpt-5" rate.
    const luna = priceForModel('gpt-5.6-luna');
    const generic = priceForModel('gpt-5');
    expect(luna).not.toBeNull();
    expect(luna?.input).toBeLessThan(generic?.input as number);
  });

  it('does not confuse flash-lite with flash', () => {
    const lite = priceForModel('gemini-2.5-flash-lite');
    const flash = priceForModel('gemini-2.5-flash');
    expect(lite?.input).toBeLessThan(flash?.input as number);
  });

  it('returns null for an unknown model rather than guessing a price', () => {
    expect(priceForModel('totally-made-up-model')).toBeNull();
    expect(priceForModel('')).toBeNull();
  });

  it('has a positive input and output rate for every known model', () => {
    for (const model of ['gemini-3-pro', 'gemini-3-flash', 'gpt-5.6-sol', 'gpt-5.6-luna', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      const pricing = priceForModel(model);
      expect(pricing, model).not.toBeNull();
      expect(pricing!.input).toBeGreaterThan(0);
      expect(pricing!.output).toBeGreaterThan(0);
      // Output tokens are always priced above input tokens.
      expect(pricing!.output).toBeGreaterThan(pricing!.input);
    }
  });
});

describe('computeCost', () => {
  it('computes the cost of a token-based call', () => {
    // gemini-3-flash is $0.30 / $2.50 per million tokens.
    const cost = computeCost({ model: 'gemini-3-flash', promptTokens: 1_000_000, completionTokens: 1_000_000 });
    expect(cost).toBeCloseTo(2.8, 4);
  });

  it('scales linearly with token count', () => {
    const one = computeCost({ model: 'gpt-5.6-terra', promptTokens: 1000, completionTokens: 500 });
    const ten = computeCost({ model: 'gpt-5.6-terra', promptTokens: 10_000, completionTokens: 5000 });
    expect(ten).toBeCloseTo(one * 10, 8);
  });

  it('weighs output tokens more heavily than input tokens', () => {
    const inputHeavy = computeCost({ model: 'gemini-3-pro', promptTokens: 10_000, completionTokens: 0 });
    const outputHeavy = computeCost({ model: 'gemini-3-pro', promptTokens: 0, completionTokens: 10_000 });
    expect(outputHeavy).toBeGreaterThan(inputHeavy);
  });

  it('returns 0 for an unknown model', () => {
    // An unpriced model must not throw mid-request; the ledger records 0 and the
    // spend cap simply does not advance for it.
    expect(computeCost({ model: 'made-up', promptTokens: 5000, completionTokens: 500 })).toBe(0);
  });

  it('returns 0 when no usage is reported', () => {
    expect(computeCost({ model: 'gemini-3-flash' })).toBe(0);
    expect(computeCost({ model: 'gemini-3-flash', promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it('produces a realistic figure for one fridge scan', () => {
    // A fridge-scan prompt is roughly 1.5k tokens in and 800 out.
    const cost = computeCost({ model: 'gemini-3-flash', promptTokens: 1500, completionTokens: 800 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it('produces a realistic figure for one meal plan', () => {
    // A weekly plan is the largest single call: ~4k in, ~8k out.
    const cost = computeCost({ model: 'claude-sonnet-5', promptTokens: 4000, completionTokens: 8000 });
    expect(cost).toBeGreaterThan(0.05);
    expect(cost).toBeLessThan(0.5);
  });

  it('never returns NaN or a negative number', () => {
    for (const model of ['gemini-3-pro', 'unknown', 'gpt-5.6-sol']) {
      const cost = computeCost({ model, promptTokens: 100, completionTokens: 100 });
      expect(Number.isNaN(cost)).toBe(false);
      expect(cost).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('per-call provider costs', () => {
  it('bills Cloud Vision per 1000 units', () => {
    expect(cloudVisionCost(1000)).toBeCloseTo(1.5, 6);
    expect(cloudVisionCost(1)).toBeCloseTo(0.0015, 6);
    expect(cloudVisionCost(0)).toBe(0);
  });

  it('treats the free-tier nutrition and price APIs as free', () => {
    // Edamam, Spoonacular and Kroger are on free tiers; the ledger still records
    // the call so usage counts work even though the cost is zero.
    expect(edamamCost()).toBe(0);
    expect(spoonacularCost()).toBe(0);
    expect(krogerCost()).toBe(0);
  });
});

describe('round4', () => {
  it('rounds to four decimal places', () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(1.00005)).toBe(1.0001);
  });

  it('leaves already-rounded values alone', () => {
    expect(round4(0.5)).toBe(0.5);
    expect(round4(0)).toBe(0);
  });

  it('handles negatives', () => {
    expect(round4(-0.123456)).toBe(-0.1235);
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('grows with input length', () => {
    const short = estimateTokens('a short prompt');
    const long = estimateTokens('a short prompt '.repeat(50));
    expect(long).toBeGreaterThan(short);
  });

  it('uses roughly four characters per token', () => {
    const text = 'x'.repeat(4000);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(500);
    expect(tokens).toBeLessThan(2000);
  });

  it('always returns a non-negative integer', () => {
    for (const text of ['', 'hello', 'a'.repeat(10_000), '日本語のテキスト']) {
      const tokens = estimateTokens(text);
      expect(Number.isInteger(tokens)).toBe(true);
      expect(tokens).toBeGreaterThanOrEqual(0);
    }
  });
});
