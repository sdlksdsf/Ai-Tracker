import { and, desc, eq, sql } from 'drizzle-orm';
import type { ConfirmScanInput, DetectedItem, ScanDto, ScanStatusDto } from '@platematch/shared';
import { AI_CONFIDENCE, CACHE_TTL_SECONDS } from '@platematch/shared';
import { getDb } from '../db/index.js';
import { fridgeScans, pantryItems, users, type FridgeScan, type PantryItem } from '../db/schema.js';
import { NotFoundError, QuotaExceededError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { normalizeIngredient } from '../utils/food.js';
import { defaultShelfLifeDays, inferCategory } from '../utils/food.js';
import { parseExpiryLabel, todayUtc, toIsoDate, addDays, daysUntilExpiry } from '../utils/dates.js';
import { preprocessImage, validateImageInput } from '../lib/image.js';
import { uploadScanPhoto } from '../lib/storage.js';
import { getQueue, QUEUE_NAMES } from '../lib/queue.js';
import { analyseFridgePhoto } from './ai/vision.service.js';
import { incrementUsage } from './ai/ledger.js';
import { getPlanLimits } from './subscription.service.js';
import { invalidatePantryCache } from './pantry.service.js';
import { sendScanCompleteNotification } from './notification.service.js';
import { scanToDto, scanToStatusDto } from './dto.js';
import { isoWeekKey } from '../utils/dates.js';

/**
 * Fridge-scan service — Section 5.A end to end.
 *
 *   POST /scan/fridge
 *     1. validate the upload (type, size, magic bytes)
 *     2. preprocess: downscale to ≤1536px, re-encode JPEG q85, strip EXIF,
 *        compute a perceptual hash
 *     3. upload to storage (Cloudinary / S3 / local)
 *     4. insert a `queued` scan row and enqueue the AI job
 *     5. return the scan id immediately (or wait, when `wait=true`)
 *
 *   The worker (or the in-process queue fallback) then runs the vision pipeline
 *   and flips the row to `completed` with the detected items.
 */

export interface CreateScanInput {
  userId: string;
  imageBuffer: Buffer;
  mimeType: string;
  filename?: string;
  source: 'camera' | 'gallery';
  wait?: boolean;
  skipBoxes?: boolean;
  hint?: string;
}

export interface CreateScanResult {
  scan_id: string;
  status: FridgeScan['status'];
  estimated_time_s: number;
  photo_url: string | null;
  /** Present when `wait=true`. */
  result?: ScanStatusDto;
}

export async function createScan(input: CreateScanInput): Promise<CreateScanResult> {
  const db = getDb();
  const started = Date.now();

  // ---- Quota -------------------------------------------------------------
  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  const tier = user?.subscriptionTier ?? 'free';
  const limits = getPlanLimits(tier);
  if (limits.scansPerWeek > 0) {
    const used = await getScanCountThisWeek(input.userId);
    if (used >= limits.scansPerWeek) {
      throw new QuotaExceededError(
        `You have used all ${limits.scansPerWeek} free fridge scans this week. Upgrade to Premium for unlimited scans.`,
        { limit: limits.scansPerWeek, used, resets: 'weekly' },
      );
    }
  }

  // ---- Validate + preprocess --------------------------------------------
  validateImageInput(input.imageBuffer, input.mimeType);
  const processed = await preprocessImage(input.imageBuffer);

  // ---- Deduplicate identical uploads (Section 8 — AI) --------------------
  if (processed.hash) {
    const dedupeKey = CacheKeys.scanDedupe(processed.hash);
    const existingId = await cache.get<string>(dedupeKey);
    if (existingId) {
      const existing = await getScanById(input.userId, existingId);
      if (existing && existing.status !== 'failed') {
        logger.info({ scanId: existingId }, 'Returning deduplicated scan');
        return {
          scan_id: existing.id,
          status: existing.status,
          estimated_time_s: existing.status === 'queued' || existing.status === 'processing' ? 5 : 0,
          photo_url: existing.photoUrl,
        };
      }
    }
    await cache.set(dedupeKey, '', CACHE_TTL_SECONDS.scanDedupe);
  }

  // ---- Upload ------------------------------------------------------------
  const upload = await uploadScanPhoto(input.userId, processed.buffer, processed.mimeType);

  // ---- Persist the queued scan ------------------------------------------
  const [scan] = await db
    .insert(fridgeScans)
    .values({
      userId: input.userId,
      photoUrl: upload.url,
      compressedUrl: upload.url,
      storageKey: upload.key,
      status: 'queued',
      progress: 5,
      source: input.source,
      imageWidth: processed.width || null,
      imageHeight: processed.height || null,
      imageHash: processed.hash || null,
      detectedItems: [],
      suggestions: [],
      modelsTried: [],
    })
    .returning();

  const scanRow = scan as FridgeScan;

  if (processed.hash) {
    await cache.set(CacheKeys.scanDedupe(processed.hash), scanRow.id, CACHE_TTL_SECONDS.scanDedupe);
  }

  await incrementUsage(input.userId, 'scan', `scan:${isoWeekKey()}`);

  // ---- Enqueue AI processing --------------------------------------------
  const queue = getQueue<ScanJobData>(QUEUE_NAMES.scan);
  await queue.add('process-scan', {
    scanId: scanRow.id,
    userId: input.userId,
    storageKey: upload.key,
    photoUrl: upload.url,
    skipBoxes: input.skipBoxes ?? false,
    hint: input.hint,
    // The worker needs the bytes; pass them only for the in-process fallback.
    // With Redis we re-download from storage instead (job payloads stay small).
    inlineBase64: queue.isRedisBacked ? undefined : processed.buffer.toString('base64'),
    mimeType: processed.mimeType,
  });

  logger.info(
    { scanId: scanRow.id, userId: input.userId, ms: Date.now() - started, bytes: processed.bytes },
    'Fridge scan queued',
  );

  if (input.wait) {
    const result = await processScan({
      scanId: scanRow.id,
      userId: input.userId,
      storageKey: upload.key,
      photoUrl: upload.url,
      skipBoxes: input.skipBoxes ?? false,
      hint: input.hint,
      inlineBase64: processed.buffer.toString('base64'),
      mimeType: processed.mimeType,
    });
    return {
      scan_id: scanRow.id,
      status: 'completed',
      estimated_time_s: 0,
      photo_url: upload.url,
      result,
    };
  }

  return {
    scan_id: scanRow.id,
    status: 'queued',
    estimated_time_s: 5,
    photo_url: upload.url,
  };
}

export interface ScanJobData {
  scanId: string;
  userId: string;
  storageKey: string;
  photoUrl: string;
  skipBoxes: boolean;
  hint?: string;
  inlineBase64?: string;
  mimeType: string;
}

/**
 * Run the vision pipeline for a scan and persist the result.
 * Called by the BullMQ worker, or inline when `wait=true`.
 */
export async function processScan(job: ScanJobData): Promise<ScanStatusDto> {
  const db = getDb();
  const started = Date.now();

  const [scan] = await db.select().from(fridgeScans).where(eq(fridgeScans.id, job.scanId)).limit(1);
  if (!scan) throw new NotFoundError('Scan not found');

  // Idempotency: never reprocess a completed scan.
  if (scan.status === 'completed') return scanToStatusDto(scan as FridgeScan);

  await db
    .update(fridgeScans)
    .set({ status: 'processing', progress: 25 })
    .where(eq(fridgeScans.id, job.scanId));

  try {
    const buffer = await loadScanImage(job);

    await db.update(fridgeScans).set({ progress: 45 }).where(eq(fridgeScans.id, job.scanId));

    const pipeline = await analyseFridgePhoto(
      { image: buffer, mimeType: job.mimeType || 'image/jpeg' },
      { userId: job.userId, scanId: job.scanId, skipBoxes: job.skipBoxes, hint: job.hint },
    );

    const processingTimeMs = Date.now() - started;

    const [updated] = await db
      .update(fridgeScans)
      .set({
        status: 'completed',
        progress: 100,
        detectedItems: pipeline.result.detectedItems,
        overallFridgeStatus: pipeline.result.overallFridgeStatus,
        suggestions: pipeline.result.suggestions,
        aiModelUsed: pipeline.primaryModelUsed,
        modelsTried: pipeline.attempts,
        apiCostUsd: pipeline.totalCostUsd,
        processingTimeMs,
      })
      .where(eq(fridgeScans.id, job.scanId))
      .returning();

    const dto = scanToStatusDto(updated as FridgeScan);

    // Real-time notification (Section 7, trigger 6).
    void sendScanCompleteNotification(job.userId, pipeline.result.detectedItems.length, job.scanId).catch(() => undefined);

    logger.info(
      { scanId: job.scanId, items: pipeline.result.detectedItems.length, ms: processingTimeMs, cost: pipeline.totalCostUsd },
      'Fridge scan completed',
    );

    return dto;
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ scanId: job.scanId, err: message }, 'Fridge scan failed');

    const [updated] = await db
      .update(fridgeScans)
      .set({
        status: 'failed',
        progress: 100,
        errorMessage: message.slice(0, 2000),
        processingTimeMs: Date.now() - started,
        suggestions: ['The scan could not be completed. You can add items manually instead.'],
      })
      .where(eq(fridgeScans.id, job.scanId))
      .returning();

    return scanToStatusDto(updated as FridgeScan);
  }
}

/** Load the image bytes for processing — inline payload first, else storage. */
async function loadScanImage(job: ScanJobData): Promise<Buffer> {
  if (job.inlineBase64) return Buffer.from(job.inlineBase64, 'base64');

  const { env } = await import('../config/env.js');

  if (env.STORAGE_DRIVER === 'local') {
    const { readFile } = await import('node:fs/promises');
    const { localPathForKey } = await import('../lib/storage.js');
    return readFile(localPathForKey(job.storageKey));
  }

  const response = await fetch(job.photoUrl);
  if (!response.ok) throw new Error(`Could not re-download the scan image (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

export async function getScanById(userId: string, scanId: string): Promise<FridgeScan> {
  const db = getDb();
  const rows = await db.select().from(fridgeScans).where(and(eq(fridgeScans.id, scanId), eq(fridgeScans.userId, userId))).limit(1);
  const scan = rows[0] as FridgeScan | undefined;
  if (!scan) throw new NotFoundError('Scan not found');
  return scan;
}

export async function getScanStatus(userId: string, scanId: string): Promise<ScanStatusDto> {
  return scanToStatusDto(await getScanById(userId, scanId));
}

export async function getScanDetail(userId: string, scanId: string): Promise<ScanDto> {
  return scanToDto(await getScanById(userId, scanId));
}

export async function listScanHistory(userId: string, page = 1, limit = 10): Promise<{ items: ScanDto[]; total: number }> {
  const db = getDb();
  const safeLimit = Math.min(50, Math.max(1, limit));
  const safePage = Math.max(1, page);

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(fridgeScans)
      .where(eq(fridgeScans.userId, userId))
      .orderBy(desc(fridgeScans.createdAt))
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit),
    db.select({ count: sql<number>`count(*)::int` }).from(fridgeScans).where(eq(fridgeScans.userId, userId)),
  ]);

  return { items: rows.map((r) => scanToDto(r as FridgeScan)), total: Number(countRows[0]?.count ?? 0) };
}

export async function getScanCountThisWeek(userId: string): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(fridgeScans)
    .where(and(eq(fridgeScans.userId, userId), sql`${fridgeScans.createdAt} >= ${since}`));
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Confirming a scan → pantry
// ---------------------------------------------------------------------------

export interface ConfirmScanResult {
  scan: ScanDto;
  created: number;
  pantry_items: Array<{ id: string; ingredient_name: string }>;
}

/**
 * Apply the user's edits to the AI detections and write the accepted items
 * into the pantry.
 *
 * `confirmed` — AI detections the user accepted (possibly edited)
 * `removed`   — AI detections the user rejected (never persisted)
 * `added`     — items the user typed in because the AI missed them
 * `corrected` — names of items the user edited (stats only)
 */
export async function confirmScan(userId: string, scanId: string, input: ConfirmScanInput): Promise<ConfirmScanResult> {
  const db = getDb();
  const scan = await getScanById(userId, scanId);

  const removedKeys = new Set(input.removed.map((r) => normalizeIngredient(r)));
  const today = toIsoDate(todayUtc());

  const toInsert = [...input.confirmed, ...input.added]
    .filter((item) => !removedKeys.has(normalizeIngredient(item.name)))
    .filter((item) => item.name.trim().length > 0)
    .map((item) => {
      const name = item.name.trim().slice(0, 100);
      const category = item.category && item.category !== 'other' ? item.category : inferCategory(name);
      const expiry = resolveScanExpiry(item.expiry_date, name);

      return {
        userId,
        scanId: scan.id,
        ingredientName: name,
        normalizedKey: normalizeIngredient(name),
        category: category as PantryItem['category'],
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        expiryDate: expiry,
        purchaseDate: item.purchase_date ?? today,
        addedVia: (scan.source === 'manual' ? 'manual' : scan.source) as PantryItem['addedVia'],
        aiConfidence: item.ai_confidence ?? null,
        photoUrl: item.photo_url ?? scan.photoUrl ?? null,
        location: item.location ?? 'fridge',
        freshness: 'fresh' as const,
        isExpired: expiry ? daysUntilExpiry(expiry)! < 0 : false,
      };
    });

  let created = 0;
  if (toInsert.length) {
    const rows = await db.insert(pantryItems).values(toInsert).returning({ id: pantryItems.id, name: pantryItems.ingredientName });
    created = rows.length;
  }

  const [updated] = await db
    .update(fridgeScans)
    .set({
      itemsConfirmedCount: input.confirmed.length,
      itemsCorrectedCount: input.corrected.length,
      itemsRemovedCount: input.removed.length,
      itemsAddedCount: input.added.length,
      confirmedAt: new Date(),
    })
    .where(eq(fridgeScans.id, scanId))
    .returning();

  await invalidatePantryCache(userId);

  logger.info(
    { scanId, confirmed: input.confirmed.length, removed: input.removed.length, added: input.added.length },
    'Scan confirmed into pantry',
  );

  return {
    scan: scanToDto(updated as FridgeScan),
    created,
    pantry_items: [],
  };
}

function resolveScanExpiry(expiryDate: string | null | undefined, name: string): string | null {
  const parsed = parseExpiryLabel(expiryDate ?? null);
  if (parsed) return parsed;
  if (!expiryDate) return toIsoDate(addDays(todayUtc(), defaultShelfLifeDays(name)));
  return expiryDate;
}

/** Post-hoc confidence summary for a scan (used in analytics). */
export function scanConfidenceSummary(items: DetectedItem[]): {
  accepted: number;
  rejected: number;
  averageConfidence: number;
  lowConfidence: string[];
} {
  const accepted = items.filter((i) => i.confidence >= AI_CONFIDENCE.minAccept);
  const rejected = items.length - accepted.length;
  const averageConfidence = accepted.length
    ? Math.round((accepted.reduce((sum, i) => sum + i.confidence, 0) / accepted.length) * 100) / 100
    : 0;

  return {
    accepted: accepted.length,
    rejected,
    averageConfidence,
    lowConfidence: accepted.filter((i) => i.confidence < AI_CONFIDENCE.fallbackThreshold).map((i) => i.name),
  };
}

