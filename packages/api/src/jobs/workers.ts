import type { Job } from 'bullmq';
import { QUEUE_NAMES, attachWorker } from '../lib/queue.js';
import { logger } from '../lib/logger.js';
import { getScanStatus, processScan, type ScanJobData } from '../services/scan.service.js';
import { sendNotification, sendScanCompleteNotification } from '../services/notification.service.js';
import { refreshPriceCache } from '../services/ai/grocery-price.service.js';
import { lookupComposition, scaleComposition } from '../data/nutrition-db.js';
import { round1, toGrams } from '../utils/food.js';

/**
 * Job processors (Section 2 — BullMQ).
 *
 * The same processor function serves both back-ends: BullMQ calls it with a
 * `Job<T>`, and the in-process fallback calls it with a minimal stand-in that
 * carries `id`, `name` and `data`. Nothing here may assume Redis exists.
 *
 * Jobs are idempotent — a retry after a partial failure must be safe, because
 * BullMQ redelivers on worker crash and the in-process queue retries twice.
 */

/** Re-exported so `crons.ts` and the worker entrypoint share one type. */
export type ScanJobPayload = ScanJobData;

export interface NotificationJobPayload {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface NutritionEnrichPayload {
  /** Recipes to backfill. Empty means "everything missing a nutrition row". */
  recipeIds?: string[];
  /** Safety valve so one bad batch cannot run forever. */
  limit?: number;
}

/**
 * Every task the maintenance queue can run.
 *
 * One list, used by three places that must never disagree:
 *   • `crons.ts` — which task each schedule enqueues
 *   • `handleMaintenanceJob` — the dispatcher below
 *   • the unit test that asserts the two sets are identical
 *
 * They used to disagree: the BullMQ scheduler hard-coded `{ task: 'refresh-expiry' }`
 * for every cron, so with Redis configured the four notification sweeps never
 * ran at all and purge-tokens / purge-scans / recalculate-achievements never
 * ran either — while `refresh-expiry` ran five times a day. Only the
 * in-process fallback (no Redis) executed the right jobs, which is exactly the
 * configuration local development uses, so nothing looked broken.
 */
export const MAINTENANCE_TASKS = [
  'refresh-expiry',
  'purge-tokens',
  'purge-scans',
  'recalculate-achievements',
  'expiry-alerts',
  'meal-reminders',
  'smart-suggestions',
  'weekly-report',
] as const;

export type MaintenanceTask = (typeof MAINTENANCE_TASKS)[number];

export interface MaintenancePayload {
  task: MaintenanceTask;
}

/** Run the vision pipeline for a queued scan, then push the result. */
export async function handleScanJob(job: Job<ScanJobPayload>): Promise<void> {
  const { scanId, userId } = job.data;
  const started = Date.now();

  try {
    const status = await processScan(job.data);

    // The push is best-effort: a failed delivery must not fail the scan.
    if (status.status === 'completed') {
      await sendScanCompleteNotification(userId, status.detected_items?.length ?? 0, scanId).catch((err: unknown) => {
        logger.warn({ err: (err as Error).message, scanId }, 'Scan push delivery failed');
      });
    }

    logger.info(
      { scanId, userId, status: status.status, items: status.detected_items?.length ?? 0, ms: Date.now() - started },
      'Scan job finished',
    );
  } catch (err) {
    logger.error({ err, scanId, userId, attempt: job.attemptsMade + 1 }, 'Scan job failed');
    // Rethrowing lets BullMQ apply the retry/backoff policy.
    throw err;
  }
}

/** Deliver one notification to every active device for a user. */
export async function handleNotificationJob(job: Job<NotificationJobPayload>): Promise<void> {
  const payload = job.data;

  const result = await sendNotification({
    userId: payload.userId,
    type: payload.type as never,
    title: payload.title,
    body: payload.body,
    data: payload.data,
  });

  logger.debug(
    { userId: payload.userId, type: payload.type, delivered: result.delivered },
    'Notification job finished',
  );
}

/** Invalidate the 24-hour grocery-price cache so tomorrow's lists are fresh. */
export async function handlePriceRefreshJob(): Promise<void> {
  await refreshPriceCache();
}

/**
 * Backfill nutrition for recipes that have no `recipe_nutrition` row.
 *
 * Uses the bundled USDA composition table rather than a paid API call: this job
 * runs unattended, so it must be free, deterministic and offline-safe. Recipes
 * generated while Edamam is configured already carry verified numbers and are
 * skipped by the `NOT EXISTS` clause.
 */
export async function handleNutritionJob(job: Job<NutritionEnrichPayload>): Promise<void> {
  const { getDb } = await import('../db/index.js');
  const { recipeIngredients, recipeNutrition, recipes } = await import('../db/schema.js');
  const { asc, eq, notExists, inArray, sql } = await import('drizzle-orm');

  const db = getDb();
  const limit = Math.min(200, Math.max(1, job.data.limit ?? 25));

  const ids = job.data.recipeIds?.length
    ? job.data.recipeIds
    : (
        await db
          .select({ id: recipes.id, servings: recipes.servings })
          .from(recipes)
          .where(
            notExists(db.select({ one: sql`1` }).from(recipeNutrition).where(eq(recipeNutrition.recipeId, recipes.id))),
          )
          .orderBy(asc(recipes.createdAt))
          .limit(limit)
      ).map((row) => row.id);

  if (!ids.length) {
    logger.debug('Nutrition backfill: nothing to do');
    return;
  }

  const rows = await db
    .select()
    .from(recipes)
    .where(inArray(recipes.id, ids));

  let written = 0;

  for (const recipe of rows) {
    // eslint-disable-next-line no-await-in-loop
    const ingredients = await db
      .select()
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, recipe.id));

    const servings = Math.max(1, recipe.servings ?? 2);
    const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodiumMg: 0 };
    let matched = 0;

    for (const ingredient of ingredients) {
      const comp = lookupComposition(ingredient.ingredientName);
      if (!comp) continue;

      const grams = toGrams(ingredient.quantity ?? 1, ingredient.unit ?? 'g') ?? 100;
      const scaled = scaleComposition(comp, grams);

      totals.kcal += scaled.kcal;
      totals.protein += scaled.protein;
      totals.carbs += scaled.carbs;
      totals.fat += scaled.fat;
      totals.fiber += scaled.fiber;
      totals.sugar += scaled.sugar;
      totals.sodiumMg += scaled.sodiumMg;
      matched += 1;
    }

    // A recipe where almost nothing matched would produce misleading numbers.
    if (!matched || matched < Math.ceil(ingredients.length * 0.4)) continue;

    // eslint-disable-next-line no-await-in-loop
    await db
      .insert(recipeNutrition)
      .values({
        recipeId: recipe.id,
        calories: round1(totals.kcal / servings),
        proteinG: round1(totals.protein / servings),
        carbsG: round1(totals.carbs / servings),
        fatG: round1(totals.fat / servings),
        fiberG: round1(totals.fiber / servings),
        sugarG: round1(totals.sugar / servings),
        sodiumMg: round1(totals.sodiumMg / servings),
        cholesterolMg: 0,
        saturatedFatG: 0,
        vitaminAPct: 0,
        vitaminCPct: 0,
        calciumPct: 0,
        ironPct: 0,
        potassiumMg: 0,
        source: 'local',
        perServing: true,
      })
      .onConflictDoUpdate({
        target: recipeNutrition.recipeId,
        set: {
          calories: round1(totals.kcal / servings),
          proteinG: round1(totals.protein / servings),
          carbsG: round1(totals.carbs / servings),
          fatG: round1(totals.fat / servings),
          fiberG: round1(totals.fiber / servings),
          sugarG: round1(totals.sugar / servings),
          sodiumMg: round1(totals.sodiumMg / servings),
        },
      })
      .catch(() => undefined);

    written += 1;
  }

  logger.info({ candidates: rows.length, written }, 'Nutrition backfill finished');
}

/** How long scan history is kept before the `purge-scans` task drops it. */
export const SCAN_RETENTION_DAYS = 90;

/**
 * Run one scheduled task.
 *
 * This is the single implementation, called by `handleMaintenanceJob` (BullMQ
 * worker, and the in-process queue's processor) and directly by `crons.ts` when
 * there is no queue backend. Before it existed, the scheduler and the worker
 * each had their own idea of what a cron should run, and they drifted.
 */
export async function runMaintenanceTask(task: MaintenanceTask): Promise<void> {
  switch (task) {
    case 'refresh-expiry': {
      const { refreshExpiredFlags } = await import('../services/pantry.service.js');
      const flagged = await refreshExpiredFlags();
      logger.info({ flagged }, 'Expiry flags refreshed');
      return;
    }
    case 'purge-tokens': {
      const { purgeExpiredTokens } = await import('../services/auth.service.js');
      const result = await purgeExpiredTokens();
      logger.info(result, 'Expired auth tokens purged');
      return;
    }
    case 'purge-scans': {
      // Photos live in object storage with their own lifecycle policy; here we
      // only drop the detection rows so the scan history stays readable.
      const { getDb } = await import('../db/index.js');
      const { fridgeScans } = await import('../db/schema.js');
      const { lt } = await import('drizzle-orm');

      const cutoff = new Date(Date.now() - SCAN_RETENTION_DAYS * 86_400_000);
      const removed = await getDb()
        .delete(fridgeScans)
        .where(lt(fridgeScans.createdAt, cutoff))
        .returning({ id: fridgeScans.id });

      logger.info({ removed: removed.length, cutoff }, 'Old scans purged');
      return;
    }
    case 'recalculate-achievements': {
      const { getDb } = await import('../db/index.js');
      const { users } = await import('../db/schema.js');
      const { checkAndAward } = await import('../services/achievement.service.js');
      const { sql } = await import('drizzle-orm');

      const rows = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.lastActiveAt} > now() - interval '30 days'`)
        .limit(5_000);

      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        await checkAndAward(row.id).catch(() => undefined);
      }

      logger.info({ users: rows.length }, 'Achievements recalculated');
      return;
    }
    case 'expiry-alerts': {
      const { sendExpiryAlertsSweep } = await import('./expiry-notifications.js');
      logger.info(await sendExpiryAlertsSweep(), 'Expiry alert sweep finished');
      return;
    }
    case 'meal-reminders': {
      const { sendMealRemindersSweep } = await import('./meal-reminders.js');
      logger.info(await sendMealRemindersSweep(), 'Meal reminder sweep finished');
      return;
    }
    case 'smart-suggestions': {
      const { sendSmartSuggestionsSweep } = await import('./smart-suggestions.js');
      logger.info(await sendSmartSuggestionsSweep(), 'Smart suggestion sweep finished');
      return;
    }
    case 'weekly-report': {
      const { sendWeeklyReportsSweep } = await import('./weekly-report.js');
      logger.info(await sendWeeklyReportsSweep(), 'Weekly report sweep finished');
      return;
    }
    default: {
      logger.warn({ task }, 'Unknown maintenance task');
    }
  }
}

/** Queue/worker entrypoint — see `crons.ts` for the schedule. */
export async function handleMaintenanceJob(job: Job<MaintenancePayload>): Promise<void> {
  await runMaintenanceTask(job.data.task);
}

/** Wire every processor to its queue. Returns the BullMQ workers (if any). */
export function registerWorkers(): void {
  const workers = [
    attachWorker<ScanJobPayload>(QUEUE_NAMES.scan, handleScanJob, 4),
    attachWorker<NotificationJobPayload>(QUEUE_NAMES.notifications, handleNotificationJob, 8),
    attachWorker<never>(QUEUE_NAMES.prices, handlePriceRefreshJob as never, 1),
    attachWorker<NutritionEnrichPayload>(QUEUE_NAMES.nutrition, handleNutritionJob, 2),
    attachWorker<MaintenancePayload>(QUEUE_NAMES.maintenance, handleMaintenanceJob, 1),
  ];

  const live = workers.filter(Boolean).length;
  logger.info({ queues: workers.length, redisBacked: live }, 'Job workers registered');
}
