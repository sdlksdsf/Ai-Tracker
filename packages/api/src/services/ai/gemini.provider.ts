import { AI_CONFIDENCE } from '@platematch/shared';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { UpstreamServiceError } from '../../lib/errors.js';
import { computeCost, estimateTokens } from './cost.js';
import { extractJson, fetchJson } from './http.js';
import { coerceCategory, inferCategory, normalizeIngredient, parseQuantity } from '../../utils/food.js';
import { parseExpiryLabel } from '../../utils/dates.js';
import { FRIDGE_SCAN_PROMPT, FRIDGE_SCAN_RESPONSE_SCHEMA } from '../../config/prompts.js';
import type {
  AiCallResult,
  AiProviderName,
  ReasoningProvider,
  ReasoningRequest,
  VisionProvider,
  VisionRequest,
  VisionResult,
} from './types.js';
import type { DetectedItem } from '@platematch/shared';

/**
 * Google Gemini provider — primary for fridge scanning, tertiary for batch
 * meal-plan generation (cheapest of the three frontier models).
 *
 * API: `POST {base}/models/{model}:generateContent` with `x-goog-api-key`.
 * Structured output is requested via `responseMimeType: application/json` plus
 * an explicit `responseSchema`, so the model is constrained at decode time
 * rather than being asked nicely and then repaired.
 */

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export class GeminiProvider implements VisionProvider, ReasoningProvider {
  readonly name: AiProviderName = 'gemini';

  constructor(
    private readonly options: {
      visionModel?: string;
      reasoningModel?: string;
      apiKey?: string;
      baseUrl?: string;
    } = {},
  ) {}

  private get apiKey(): string | undefined {
    return this.options.apiKey ?? env.GEMINI_API_KEY;
  }

  private get baseUrl(): string {
    return (this.options.baseUrl ?? env.AI_VISION_BASE_URL).replace(/\/$/, '');
  }

  /** Model used for the vision task. */
  get visionModel(): string {
    return this.options.visionModel ?? env.AI_VISION_PRIMARY_MODEL;
  }

  /** Default model reported by the ReasoningProvider interface. */
  get model(): string {
    return this.options.reasoningModel ?? env.AI_REASONING_BATCH_MODEL;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  // -------------------------------------------------------------------------
  // Vision
  // -------------------------------------------------------------------------

  async analyse(request: VisionRequest): Promise<AiCallResult<VisionResult>> {
    if (!this.isConfigured) throw new UpstreamServiceError('GEMINI_API_KEY is not set');

    const model = this.visionModel;
    const url = `${this.baseUrl}/models/${model}:generateContent`;

    const parts: GeminiPart[] = [
      { text: request.hint ? `${FRIDGE_SCAN_PROMPT}\n\nAdditional context from the user: ${request.hint}` : FRIDGE_SCAN_PROMPT },
      { inline_data: { mime_type: request.mimeType, data: request.image.toString('base64') } },
    ];

    const bodyWithSchema = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: FRIDGE_SCAN_RESPONSE_SCHEMA,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      ],
    };

    const started = Date.now();
    let response: GeminiResponse;
    let usedSchema = true;

    try {
      const result = await fetchJson<GeminiResponse>(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey as string },
        body: bodyWithSchema,
        timeoutMs: env.AI_VISION_TIMEOUT_MS,
        retries: env.AI_VISION_MAX_RETRIES,
        signal: request.signal,
        label: `gemini:${model}`,
        // We handle non-2xx ourselves so we can retry without responseSchema.
        allowErrorStatus: true,
      });
      response = result.data;

      if (result.status >= 400) {
        const message = response.error?.message ?? `HTTP ${result.status}`;
        // Some Gemini versions/aliases reject `responseSchema`. Retry without it.
        if (/responseSchema|response_schema|generationConfig|Unsupported/i.test(message)) {
          logger.warn({ model, message }, 'Gemini rejected responseSchema — retrying without it');
          usedSchema = false;
          const retry = await fetchJson<GeminiResponse>(url, {
            method: 'POST',
            headers: { 'x-goog-api-key': this.apiKey as string },
            body: {
              ...bodyWithSchema,
              generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' },
            },
            timeoutMs: env.AI_VISION_TIMEOUT_MS,
            retries: env.AI_VISION_MAX_RETRIES,
            signal: request.signal,
            label: `gemini:${model}:noschema`,
          });
          response = retry.data;
        } else {
          throw new UpstreamServiceError(`Gemini vision call failed: ${message}`, { status: result.status });
        }
      }
    } catch (err) {
      if (err instanceof UpstreamServiceError) throw err;
      throw new UpstreamServiceError(`Gemini vision call failed: ${(err as Error).message}`);
    }

    const latencyMs = Date.now() - started;

    if (response.promptFeedback?.blockReason) {
      throw new UpstreamServiceError(`Gemini blocked the request: ${response.promptFeedback.blockReason}`);
    }

    const candidate = response.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

    if (!text) {
      throw new UpstreamServiceError('Gemini returned an empty candidate', {
        finishReason: candidate?.finishReason,
      });
    }

    const parsed = extractJson<GeminiVisionPayload>(text);
    const visionResult = normalizeGeminiVision(parsed, model);

    const promptTokens = response.usageMetadata?.promptTokenCount ?? estimateTokens(text);
    const completionTokens = response.usageMetadata?.candidatesTokenCount ?? estimateTokens(text);

    return {
      data: visionResult,
      provider: this.name,
      model: usedSchema ? model : `${model}:no-schema`,
      latencyMs,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: response.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
        costUsd: computeCost({ model, promptTokens, completionTokens }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Reasoning (batch meal plans, and fallback for recipes)
  // -------------------------------------------------------------------------

  async generateJson<T>(request: ReasoningRequest): Promise<AiCallResult<T>> {
    if (!this.isConfigured) throw new UpstreamServiceError('GEMINI_API_KEY is not set');

    const model = this.options.reasoningModel ?? env.AI_REASONING_BATCH_MODEL;
    const url = `${this.baseUrl}/models/${model}:generateContent`;
    const started = Date.now();

    const generationConfig: Record<string, unknown> = {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      responseMimeType: 'application/json',
    };
    if (request.jsonSchema) generationConfig.responseSchema = request.jsonSchema;

    const result = await fetchJson<GeminiResponse>(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey as string },
      body: {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig,
      },
      timeoutMs: env.AI_TIMEOUT_MS,
      retries: 2,
      signal: request.signal,
      label: `gemini:${model}:${request.label ?? 'json'}`,
      allowErrorStatus: true,
    });

    let response = result.data;
    if (result.status >= 400) {
      const message = response.error?.message ?? `HTTP ${result.status}`;
      if (/responseSchema|generationConfig|Unsupported/i.test(message) && request.jsonSchema) {
        const retry = await fetchJson<GeminiResponse>(url, {
          method: 'POST',
          headers: { 'x-goog-api-key': this.apiKey as string },
          body: {
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxTokens, responseMimeType: 'application/json' },
          },
          timeoutMs: env.AI_TIMEOUT_MS,
          retries: 1,
          signal: request.signal,
          label: `gemini:${model}:noschema`,
        });
        response = retry.data;
      } else {
        throw new UpstreamServiceError(`Gemini call failed: ${message}`, { status: result.status });
      }
    }

    const latencyMs = Date.now() - started;
    const text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new UpstreamServiceError('Gemini returned an empty response');

    const data = extractJson<T>(text);
    const promptTokens = response.usageMetadata?.promptTokenCount ?? estimateTokens(request.prompt);
    const completionTokens = response.usageMetadata?.candidatesTokenCount ?? estimateTokens(text);

    return {
      data,
      provider: this.name,
      model,
      latencyMs,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: response.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
        costUsd: computeCost({ model, promptTokens, completionTokens }),
      },
    };
  }
}

interface GeminiVisionPayload {
  detected_items?: Array<Record<string, unknown>>;
  overall_fridge_status?: string;
  suggestions?: string[];
}

/** Normalise Gemini's free-form JSON into our `DetectedItem` contract. */
export function normalizeGeminiVision(payload: GeminiVisionPayload, model: string): VisionResult {
  const raw = Array.isArray(payload.detected_items) ? payload.detected_items : [];

  const items: DetectedItem[] = raw
    .map((entry) => normalizeDetectedEntry(entry, model))
    .filter((item): item is DetectedItem => item !== null);

  const accepted = items.filter((i) => i.confidence >= AI_CONFIDENCE.minAccept);
  const averageConfidence = accepted.length
    ? accepted.reduce((sum, i) => sum + i.confidence, 0) / accepted.length
    : 0;

  return {
    detectedItems: dedupeItems(accepted),
    overallFridgeStatus: payload.overall_fridge_status ?? null,
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions.filter((s) => typeof s === 'string') : [],
    averageConfidence: Math.round(averageConfidence * 100) / 100,
    boundingBoxes: [],
  };
}

function normalizeDetectedEntry(entry: Record<string, unknown>, model: string): DetectedItem | null {
  const rawName = String(entry.name ?? entry.item ?? entry.label ?? '').trim();
  if (!rawName) return null;

  const name = rawName.slice(0, 120);
  const category = coerceCategory(entry.category ?? inferCategory(name));

  // Quantity: models may give "3 pieces" in one field or split it in two.
  const combined = entry.estimated_quantity != null ? String(entry.estimated_quantity) : '';
  const parsedCombined = parseQuantity(combined.includes(String(entry.estimated_unit ?? '')) ? combined : `${combined} ${entry.estimated_unit ?? ''}`);
  const quantity = typeof entry.quantity === 'number' ? entry.quantity : parsedCombined.quantity;
  const unit = typeof entry.unit === 'string' ? entry.unit : (parsedCombined.unit ?? normalizeUnit(entry.estimated_unit));

  const confidence = clampConfidence(entry.confidence ?? entry.score);

  if (confidence < AI_CONFIDENCE.minAccept) return null;

  const expiryLabel = entry.expiry_label_read != null ? String(entry.expiry_label_read) : null;
  const shelfLife =
    typeof entry.suggested_shelf_life_days === 'number' ? Math.round(entry.suggested_shelf_life_days) : null;

  return {
    name,
    category,
    estimated_quantity: combined || null,
    estimated_unit: normalizeUnit(entry.estimated_unit) ?? null,
    quantity,
    unit,
    freshness: normalizeFreshness(entry.freshness),
    confidence,
    location_in_image: entry.location_in_image != null ? String(entry.location_in_image).slice(0, 60) : null,
    expiry_label_read: expiryLabel && expiryLabel.toLowerCase() !== 'null' ? expiryLabel.slice(0, 60) : null,
    expiry_date: parseExpiryLabel(expiryLabel),
    suggested_shelf_life_days: shelfLife,
    bounding_box: normalizeBox(entry.bounding_box ?? entry.bbox),
    detected_by: model,
  };
}

function normalizeUnit(value: unknown): string | null {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  return v || null;
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  // Some models return 0-100.
  const scaled = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, Math.round(scaled * 100) / 100));
}

function normalizeFreshness(value: unknown): DetectedItem['freshness'] {
  const v = String(value ?? '').toLowerCase();
  if (v.includes('spoil') || v.includes('rotten') || v.includes('mold') || v.includes('mould')) return 'spoiled';
  if (v.includes('over')) return 'overripe';
  if (v.includes('ripen')) return 'ripening';
  return 'fresh';
}

function normalizeBox(value: unknown): DetectedItem['bounding_box'] {
  if (!value || typeof value !== 'object') return null;
  const box = value as Record<string, unknown>;
  const x = Number(box.x ?? box.left ?? box.xmin ?? 0);
  const y = Number(box.y ?? box.top ?? box.ymin ?? 0);
  const width = Number(box.width ?? box.w ?? 0);
  const height = Number(box.height ?? box.h ?? 0);
  if ([x, y, width, height].some((n) => Number.isNaN(n))) return null;
  if (width <= 0 || height <= 0) return null;
  // Vertex AI returns 0..1 normalised boxes; some models return pixels.
  const max = Math.max(x, y, width, height);
  const scale = max > 1.5 ? 1 / max : 1;
  return {
    x: clamp01(x * scale),
    y: clamp01(y * scale),
    width: clamp01(width * scale),
    height: clamp01(height * scale),
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
}

/**
 * Merge near-duplicate detections ("tomato" + "cherry tomatoes" + "3 tomatoes").
 * Keeps the highest-confidence entry and sums nothing — the user confirms.
 */
export function dedupeItems(items: DetectedItem[]): DetectedItem[] {
  const out: DetectedItem[] = [];
  const seen = new Map<string, DetectedItem>();

  for (const item of items) {
    const key = normalizeIngredient(item.name);
    if (!key) continue;

    const existing = seen.get(key);
    if (existing) {
      if (item.confidence > existing.confidence) seen.set(key, item);
      continue;
    }

    // Fuzzy check against already-accepted keys (handles singular/plural drift).
    let duplicateKey: string | null = null;
    for (const [candidateKey, candidate] of seen) {
      if (isNearDuplicate(key, candidateKey) && candidate.category === item.category) {
        duplicateKey = candidateKey;
        break;
      }
    }

    if (duplicateKey) {
      const existing = seen.get(duplicateKey) as DetectedItem;
      if (item.confidence > existing.confidence) seen.set(duplicateKey, item);
      continue;
    }

    seen.set(key, item);
    out.push(item);
  }

  return [...seen.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
}

function isNearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return shorter / longer > 0.6;
  }
  return false;
}
