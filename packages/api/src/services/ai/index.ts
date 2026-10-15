import { env, resolveAiMode } from '../../config/env.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { CloudVisionProvider } from './cloudvision.provider.js';
import type { ReasoningProvider, VisionProvider } from './types.js';

/**
 * Provider registry
 * ===========================================================================
 * Single place where models are instantiated and ordered. Change a default here
 * (or via env) and the whole pipeline follows — no other module knows which
 * vendor answered.
 *
 *   Vision:    Gemini (primary) → OpenAI (fallback) → Cloud Vision (boxes only)
 *   Reasoning: Claude (primary) → OpenAI (fallback) → Gemini (batch/fallback)
 */

export const providers = {
  gemini: new GeminiProvider(),
  openai: new OpenAiProvider(),
  anthropic: new AnthropicProvider(),
  cloudVision: new CloudVisionProvider(),
} as const;

/** Vision providers in priority order, filtered to those with credentials. */
export function visionChain(): VisionProvider[] {
  const chain: VisionProvider[] = [providers.gemini, providers.openai];
  return chain.filter((p) => p.isConfigured);
}

/** Reasoning providers in priority order for recipe generation. */
export function reasoningChain(): ReasoningProvider[] {
  const chain: ReasoningProvider[] = [providers.anthropic, providers.openai, providers.gemini];
  return chain.filter((p) => p.isConfigured);
}

/** Reasoning providers for bulk meal-plan generation (cost-optimised order). */
export function batchReasoningChain(): ReasoningProvider[] {
  const chain: ReasoningProvider[] = [providers.anthropic, providers.gemini, providers.openai];
  return chain.filter((p) => p.isConfigured);
}

export function visionMode(): 'live' | 'mock' {
  return resolveAiMode('vision');
}

export function reasoningMode(): 'live' | 'mock' {
  return resolveAiMode('reasoning');
}

/** Human-readable description of the active configuration (for /health & logs). */
export function describeAiConfiguration() {
  return {
    mode: env.AI_MODE,
    vision: {
      mode: visionMode(),
      chain: visionChain().map((p) => `${p.name}:${p.model}`),
      boundingBoxes: providers.cloudVision.isConfigured,
    },
    reasoning: {
      mode: reasoningMode(),
      chain: reasoningChain().map((p) => `${p.name}:${p.model}`),
    },
    nutrition: {
      edamam: Boolean(env.EDAMAM_APP_ID && env.EDAMAM_APP_KEY),
      spoonacular: Boolean(env.SPOONACULAR_API_KEY),
      fallback: 'built-in composition table',
    },
    prices: {
      kroger: Boolean(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET),
      spoonacular: Boolean(env.SPOONACULAR_API_KEY),
      fallback: 'built-in price index',
    },
  };
}

export * from './types.js';
export { AnthropicProvider, GeminiProvider, OpenAiProvider, CloudVisionProvider };
