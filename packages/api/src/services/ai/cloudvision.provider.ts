import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { cloudVisionCost } from './cost.js';
import { fetchJson } from './http.js';
import { inferCategory, normalizeIngredient } from '../../utils/food.js';
import type { AiProviderName, BoundingBox, VisionResult } from './types.js';

/**
 * Google Cloud Vision API v1 — tertiary provider.
 *
 * Its only job is the *bounding-box overlay* on the scan results screen
 * (`OBJECT_LOCALIZATION`) plus a second opinion on labels. It is deliberately
 * optional: if `GOOGLE_CLOUD_VISION_KEY` is not set, or `skip_boxes=true` is
 * passed by the client, the scan still completes using Gemini/OpenAI alone.
 *
 * Endpoint: POST https://vision.googleapis.com/v1/images:annotate?key=…
 */

interface AnnotateResponse {
  responses?: Array<{
    labelAnnotations?: Array<{ description: string; score: number; topicality: number }>;
    localizedObjectAnnotations?: Array<{
      name: string;
      score: number;
      boundingPoly?: {
        normalizedVertices?: Array<{ x: number; y: number }>;
      };
    }>;
    error?: { code: number; message: string };
  }>;
  error?: { code: number; message: string };
}

export interface CloudVisionResult {
  boxes: BoundingBox[];
  labels: Array<{ name: string; score: number; category: ReturnType<typeof inferCategory> }>;
  costUsd: number;
  latencyMs: number;
}

export class CloudVisionProvider {
  readonly name: AiProviderName = 'cloud-vision';

  constructor(private readonly options: { apiKey?: string } = {}) {}

  private get apiKey(): string | undefined {
    return this.options.apiKey ?? env.GOOGLE_CLOUD_VISION_KEY ?? env.GEMINI_API_KEY;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Run LABEL_DETECTION + OBJECT_LOCALIZATION.
   * Never throws — a bounding-box failure must not fail the scan.
   */
  async annotate(image: Buffer, mimeType: string): Promise<CloudVisionResult | null> {
    if (!this.isConfigured) return null;

    const started = Date.now();
    try {
      const { data } = await fetchJson<AnnotateResponse>(
        `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(this.apiKey as string)}`,
        {
          method: 'POST',
          body: {
            requests: [
              {
                image: { content: image.toString('base64') },
                imageContext: { languageHints: ['en'] },
                features: [
                  { type: 'LABEL_DETECTION', maxResults: 25, model: 'builtin/stable' },
                  { type: 'OBJECT_LOCALIZATION', maxResults: 25, model: 'builtin/stable' },
                ],
              },
            ],
          },
          timeoutMs: 20_000,
          retries: 1,
          label: 'cloud-vision:annotate',
        },
      );

      if (data.error) {
        logger.warn({ code: data.error.code, message: data.error.message }, 'Cloud Vision error');
        return null;
      }

      const response = data.responses?.[0];
      if (!response) return null;

      if (response.error) {
        // A "no food detected" style response is normal, not an error.
        logger.debug({ message: response.error.message }, 'Cloud Vision returned no annotations');
        return null;
      }

      const boxes: BoundingBox[] = (response.localizedObjectAnnotations ?? [])
        .map((obj) => toBoundingBox(obj))
        .filter((box): box is BoundingBox => box !== null);

      const labels = (response.labelAnnotations ?? [])
        .map((label) => ({
          name: normalizeIngredient(label.description) || label.description,
          score: Math.round(label.score * 100) / 100,
          category: inferCategory(label.description),
        }))
        .filter((label) => label.category !== 'other' || label.score > 0.8);

      return {
        boxes,
        labels,
        costUsd: cloudVisionCost(2), // 2 feature units
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Cloud Vision annotate failed (non-fatal)');
      return null;
    }
  }

  /**
   * Merge Cloud Vision boxes into an existing vision result, matching boxes to
   * detected items by normalised name so the overlay lands on the right item.
   */
  merge(result: VisionResult, cloud: CloudVisionResult): VisionResult {
    const items = result.detectedItems.map((item) => {
      if (item.bounding_box) return item;
      const key = normalizeIngredient(item.name);
      const match = cloud.boxes.find((box) => {
        const boxKey = normalizeIngredient(box.label);
        return boxKey === key || boxKey.includes(key) || key.includes(boxKey);
      });
      return match
        ? {
            ...item,
            bounding_box: { x: match.x, y: match.y, width: match.width, height: match.height },
          }
        : item;
    });

    // Add boxes the vision models missed entirely (as low-confidence extras).
    const known = new Set(items.map((i) => normalizeIngredient(i.name)));
    const extras = cloud.boxes
      .filter((box) => !known.has(normalizeIngredient(box.label)) && box.confidence >= 0.6)
      .map((box) => ({
        name: box.label,
        category: inferCategory(box.label),
        freshness: 'fresh' as const,
        confidence: Math.round(box.confidence * 100) / 100,
        bounding_box: { x: box.x, y: box.y, width: box.width, height: box.height },
        detected_by: 'cloud-vision',
        estimated_quantity: null,
        estimated_unit: null,
        quantity: null,
        unit: null,
        location_in_image: null,
        expiry_label_read: null,
        expiry_date: null,
        suggested_shelf_life_days: null,
      }));

    return {
      ...result,
      detectedItems: [...items, ...extras],
      boundingBoxes: cloud.boxes,
    };
  }
}

function toBoundingBox(obj: NonNullable<NonNullable<AnnotateResponse['responses']>[number]['localizedObjectAnnotations']>[number]): BoundingBox | null {
  const vertices = obj.boundingPoly?.normalizedVertices ?? [];
  if (vertices.length < 3) return null;

  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0.001 || height <= 0.001) return null;

  return {
    label: obj.name,
    confidence: Math.round((obj.score ?? 0) * 100) / 100,
    x: clamp01(minX),
    y: clamp01(minY),
    width: clamp01(width),
    height: clamp01(height),
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
}
