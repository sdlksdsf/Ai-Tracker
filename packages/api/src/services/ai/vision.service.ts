import { AI_CONFIDENCE } from '@platematch/shared';
import type { DetectedItem } from '@platematch/shared';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { normalizeIngredient, parseQuantity } from '../../utils/food.js';
import { parseExpiryLabel, todayUtc, toIsoDate, addDays } from '../../utils/dates.js';
import { recordAiUsage } from './ledger.js';
import { buildVisionUnavailableResult } from './local-engine.js';
import { providers, visionChain, visionMode } from './index.js';
import type { AiCallResult, VisionProvider, VisionRequest, VisionResult } from './types.js';

/**
 * Fridge-scan orchestration (Section 5.A, Steps 3–5)
 * ===========================================================================
 *   1. Call the primary vision provider (Gemini).
 *   2. If it errors, or the mean confidence is below the fallback threshold
 *      (0.75), call the secondary (OpenAI).
 *   3. Merge both result sets, dedupe by fuzzy name, and keep the
 *      higher-confidence entry.
 *   4. Optionally run Cloud Vision for bounding boxes and merge them.
 *   5. Normalise categories/quantities/expiry dates and drop anything below the
 *      0.65 accept threshold.
 *   6. Record tokens + cost per model in `ai_usage_logs`.
 */

export interface VisionServiceOptions {
  userId?: string | null;
  scanId?: string | null;
  /** Skip the Cloud Vision bounding-box call. */
  skipBoxes?: boolean;
  /** Extra hint from the user. */
  hint?: string;
  signal?: AbortSignal;
}

export interface ModelAttempt {
  model: string;
  provider: string;
  ok: boolean;
  reason?: string;
  costUsd: number;
  latencyMs: number;
  itemCount: number;
  averageConfidence: number;
}

export interface VisionPipelineOutput {
  result: VisionResult;
  attempts: ModelAttempt[];
  totalCostUsd: number;
  totalLatencyMs: number;
  primaryModelUsed: string | null;
  /** True when no provider answered and the built-in engine produced an empty result. */
  degraded: boolean;
}

export async function analyseFridgePhoto(
  request: VisionRequest,
  options: VisionServiceOptions = {},
): Promise<VisionPipelineOutput> {
  const started = Date.now();
  const attempts: ModelAttempt[] = [];

  if (visionMode() === 'mock') {
    const reason =
      env.AI_MODE === 'mock'
        ? 'AI_MODE=mock — the deterministic engine is in use, so photo recognition is disabled.'
        : 'No vision provider configured. Set GEMINI_API_KEY or OPENAI_API_KEY to enable automatic fridge recognition.';
    logger.info({ reason }, 'Vision pipeline running in built-in mode');
    return {
      result: buildVisionUnavailableResult(reason),
      attempts,
      totalCostUsd: 0,
      totalLatencyMs: Date.now() - started,
      primaryModelUsed: null,
      degraded: true,
    };
  }

  const chain = visionChain();
  if (chain.length === 0) {
    const reason = 'No vision provider has valid credentials.';
    return {
      result: buildVisionUnavailableResult(reason),
      attempts,
      totalCostUsd: 0,
      totalLatencyMs: Date.now() - started,
      primaryModelUsed: null,
      degraded: true,
    };
  }

  let merged: DetectedItem[] = [];
  let overallStatus: string | null = null;
  const suggestions: string[] = [];
  let primaryModel: string | null = null;
  let totalCost = 0;

  for (let index = 0; index < chain.length; index += 1) {
    const provider = chain[index] as VisionProvider;
    const isPrimary = index === 0;
    const attemptStarted = Date.now();

    try {
      const call: AiCallResult<VisionResult> = await provider.analyse(request);
      const items = normalizeDetections(call.data.detectedItems, provider.model);
      const averageConfidence = meanConfidence(items);

      attempts.push({
        model: call.model,
        provider: call.provider,
        ok: true,
        costUsd: call.usage.costUsd,
        latencyMs: call.latencyMs,
        itemCount: items.length,
        averageConfidence,
      });

      totalCost += call.usage.costUsd;
      recordAiUsage({
        userId: options.userId ?? null,
        task: 'vision',
        provider: call.provider,
        model: call.model,
        success: true,
        latencyMs: call.latencyMs,
        usage: call.usage,
        refId: options.scanId ?? null,
      });

      if (items.length === 0) {
        suggestions.push(
          ...call.data.suggestions.length
            ? call.data.suggestions
            : ['No food items could be identified in this image. Try a brighter photo taken from further back.'],
        );
        overallStatus = overallStatus ?? call.data.overallFridgeStatus ?? null;
      }

      merged = mergeDetections(merged, items);
      overallStatus = overallStatus ?? call.data.overallFridgeStatus ?? null;
      suggestions.push(...call.data.suggestions);
      primaryModel = primaryModel ?? call.model;

      // Only fall back when the primary was weak.
      const needsFallback =
        isPrimary &&
        chain.length > 1 &&
        (averageConfidence < env.AI_VISION_CONFIDENCE_FALLBACK || items.length === 0);

      if (!needsFallback) break;

      logger.info(
        {
          model: call.model,
          averageConfidence,
          itemCount: items.length,
          threshold: env.AI_VISION_CONFIDENCE_FALLBACK,
        },
        'Primary vision confidence below threshold — falling back',
      );
    } catch (err) {
      const message = (err as Error).message;
      attempts.push({
        model: provider.model,
        provider: provider.name,
        ok: false,
        reason: message,
        costUsd: 0,
        latencyMs: Date.now() - attemptStarted,
        itemCount: 0,
        averageConfidence: 0,
      });

      recordAiUsage({
        userId: options.userId ?? null,
        task: 'vision',
        provider: provider.name,
        model: provider.model,
        success: false,
        latencyMs: Date.now() - attemptStarted,
        errorCode: classifyError(err),
        refId: options.scanId ?? null,
      });

      logger.warn({ provider: provider.name, err: message }, 'Vision provider failed — trying the next one');
      suggestions.push(`${provider.name} could not process this image (${message}).`);
    }
  }

  // ---- Bounding boxes (optional, never fatal) ----------------------------
  let boundingBoxes: VisionResult['boundingBoxes'] = [];
  if (!options.skipBoxes && providers.cloudVision.isConfigured && merged.length > 0) {
    const cloud = await providers.cloudVision.annotate(request.image, request.mimeType);
    if (cloud) {
      boundingBoxes = cloud.boxes;
      const mergedResult = providers.cloudVision.merge({ detectedItems: merged, overallFridgeStatus: overallStatus, suggestions, averageConfidence: meanConfidence(merged), boundingBoxes: [] }, cloud);
      merged = mergedResult.detectedItems;
      boundingBoxes = mergedResult.boundingBoxes;
      totalCost += cloud.costUsd;
    }
  }

  const finalItems = sortDetections(merged);

  return {
    result: {
      detectedItems: finalItems,
      overallFridgeStatus: overallStatus,
      suggestions: dedupeStrings(suggestions),
      averageConfidence: meanConfidence(finalItems),
      boundingBoxes,
    },
    attempts,
    totalCostUsd: Math.round(totalCost * 10_000) / 10_000,
    totalLatencyMs: Date.now() - started,
    primaryModelUsed: primaryModel,
    degraded: finalItems.length === 0 && attempts.every((a) => !a.ok),
  };
}

// ---------------------------------------------------------------------------
// Normalisation & merging
// ---------------------------------------------------------------------------

/**
 * Final normalisation pass: fill in missing expiry dates from shelf-life
 * heuristics, parse quantity strings, and clamp confidence.
 */
export function normalizeDetections(items: DetectedItem[], model: string): DetectedItem[] {
  const today = todayUtc();

  return items
    .map((item) => {
      const parsed = item.quantity == null ? parseQuantity(`${item.estimated_quantity ?? ''} ${item.estimated_unit ?? ''}`) : null;
      const quantity = item.quantity ?? parsed?.quantity ?? null;
      const unit = item.unit ?? parsed?.unit ?? item.estimated_unit ?? null;

      const expiryFromLabel = item.expiry_date ?? parseExpiryLabel(item.expiry_label_read);
      const expiryFromShelfLife =
        item.suggested_shelf_life_days != null ? toIsoDate(addDays(today, item.suggested_shelf_life_days)) : null;

      return {
        ...item,
        name: item.name.trim().slice(0, 120),
        quantity,
        unit: unit ?? null,
        confidence: clamp(item.confidence),
        expiry_date: expiryFromLabel ?? expiryFromShelfLife,
        detected_by: item.detected_by ?? model,
      } satisfies DetectedItem;
    })
    .filter((item) => item.name.length > 0 && item.confidence >= AI_CONFIDENCE.minAccept);
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

/**
 * Merge two detection sets. Matching is on the normalised ingredient key; the
 * higher-confidence entry wins, but a lower-confidence entry can still
 * contribute fields the winner is missing (expiry label, quantity, box).
 */
export function mergeDetections(base: DetectedItem[], incoming: DetectedItem[]): DetectedItem[] {
  const byKey = new Map<string, DetectedItem>();

  for (const item of base) {
    const key = normalizeIngredient(item.name);
    if (key) byKey.set(key, item);
  }

  for (const item of incoming) {
    const key = normalizeIngredient(item.name);
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }

    const winner = item.confidence > existing.confidence ? item : existing;
    const loser = winner === item ? existing : item;

    byKey.set(key, {
      ...winner,
      quantity: winner.quantity ?? loser.quantity,
      unit: winner.unit ?? loser.unit,
      expiry_date: winner.expiry_date ?? loser.expiry_date,
      expiry_label_read: winner.expiry_label_read ?? loser.expiry_label_read,
      suggested_shelf_life_days: winner.suggested_shelf_life_days ?? loser.suggested_shelf_life_days,
      bounding_box: winner.bounding_box ?? loser.bounding_box,
      location_in_image: winner.location_in_image ?? loser.location_in_image,
      freshness: winner.freshness === 'fresh' && loser.freshness !== 'fresh' ? loser.freshness : winner.freshness,
      confidence: Math.max(winner.confidence, loser.confidence),
    });
  }

  return [...byKey.values()];
}

function sortDetections(items: DetectedItem[]): DetectedItem[] {
  return [...items].sort((a, b) => {
    // Expiring/uncertain items first so they are at the top of the review sheet.
    const aExp = a.expiry_date ? 0 : 1;
    const bExp = b.expiry_date ? 0 : 1;
    if (aExp !== bExp) return aExp - bExp;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.name.localeCompare(b.name);
  });
}

function meanConfidence(items: DetectedItem[]): number {
  if (!items.length) return 0;
  return Math.round((items.reduce((sum, i) => sum + i.confidence, 0) / items.length) * 100) / 100;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function classifyError(err: unknown): string {
  const message = (err as Error).message ?? 'unknown';
  if (/timeout|aborted/i.test(message)) return 'timeout';
  if (/HTTP 4(\d\d)/.test(message)) return `client_error_${message.match(/HTTP (\d+)/)?.[1]}`;
  if (/HTTP 5(\d\d)/.test(message)) return `server_error_${message.match(/HTTP (\d+)/)?.[1]}`;
  if (/not valid JSON/i.test(message)) return 'invalid_json';
  return 'error';
}
