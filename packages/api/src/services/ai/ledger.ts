import { eq, sql } from 'drizzle-orm';
import { aiUsageLogs, usageCounters } from '../../db/schema.js';
import { getDb } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import type { AiProviderName, AiTask, AiUsage } from './types.js';

/**
 * AI usage ledger.
 *
 * Two tables, two purposes:
 *   • `ai_usage_logs`  — append-only audit trail of every provider call
 *                        (latency, tokens, cost, failures).
 *   • `usage_counters` — rolling buckets (`scan:2025-W24`, `recipe:2025-06-16`)
 *                        that back the free-tier quotas in Section 9.
 *
 * Writes are fire-and-forget: a ledger failure must never fail a user request.
 */

export interface LedgerEntry {
  userId?: string | null;
  task: AiTask;
  provider: AiProviderName;
  model: string;
  success: boolean;
  latencyMs: number;
  usage?: Partial<AiUsage>;
  errorCode?: string;
  refId?: string | null;
}

export function recordAiUsage(entry: LedgerEntry): void {
  void persist(entry).catch((err) => {
    logger.warn({ err: (err as Error).message, task: entry.task }, 'Failed to record AI usage');
  });
}

async function persist(entry: LedgerEntry): Promise<void> {
  try {
    const db = getDb();
    await db.insert(aiUsageLogs).values({
      userId: entry.userId ?? null,
      task: entry.task,
      provider: entry.provider,
      model: entry.model,
      success: entry.success,
      latencyMs: entry.latencyMs,
      promptTokens: entry.usage?.promptTokens ?? null,
      completionTokens: entry.usage?.completionTokens ?? null,
      costUsd: entry.usage?.costUsd ?? 0,
      errorCode: entry.errorCode ?? null,
      refId: entry.refId ?? null,
    });
  } catch (err) {
    // The DB may be unavailable in tests that exercise the AI layer directly.
    logger.debug({ err: (err as Error).message }, 'ai_usage_logs insert skipped');
  }
}

export interface QuotaBucket {
  kind: 'scan' | 'recipe' | 'mealplan';
  bucket: string;
}

/** Increment a rolling quota counter and return the new value. */
export async function incrementUsage(
  userId: string,
  kind: QuotaBucket['kind'],
  bucket: string,
  costUsd = 0,
): Promise<number> {
  try {
    const db = getDb();
    const rows = await db
      .insert(usageCounters)
      .values({ userId, kind, bucket, count: 1, costUsd, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.bucket],
        set: {
          count: sql`${usageCounters.count} + 1`,
          costUsd: sql`${usageCounters.costUsd} + ${costUsd}`,
          updatedAt: new Date(),
        },
      })
      .returning({ count: usageCounters.count });

    return rows[0]?.count ?? 1;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'incrementUsage failed');
    return 0;
  }
}

/** Read the current value of a quota bucket. */
export async function getUsage(userId: string, bucket: string): Promise<{ count: number; costUsd: number }> {
  try {
    const db = getDb();
    const row = await db
      .select({ count: usageCounters.count, costUsd: usageCounters.costUsd })
      .from(usageCounters)
      .where(sql`${usageCounters.userId} = ${userId} AND ${usageCounters.bucket} = ${bucket}`)
      .limit(1);
    return { count: row[0]?.count ?? 0, costUsd: row[0]?.costUsd ?? 0 };
  } catch {
    return { count: 0, costUsd: 0 };
  }
}

/** Total AI spend for a user in the current month. */
export async function monthlySpend(userId: string): Promise<number> {
  try {
    const db = getDb();
    const month = new Date().toISOString().slice(0, 7);
    const rows = await db
      .select({ total: sql<number>`COALESCE(SUM(${aiUsageLogs.costUsd}), 0)` })
      .from(aiUsageLogs)
      .where(sql`${aiUsageLogs.userId} = ${userId} AND to_char(${aiUsageLogs.createdAt}, 'YYYY-MM') = ${month}`);
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

/** Per-user daily spend guard — blocks runaway loops. */
export async function dailySpendForUser(userId: string): Promise<number> {
  try {
    const db = getDb();
    const rows = await db
      .select({ total: sql<number>`COALESCE(SUM(${aiUsageLogs.costUsd}), 0)` })
      .from(aiUsageLogs)
      .where(sql`${aiUsageLogs.userId} = ${userId} AND ${aiUsageLogs.createdAt} >= date_trunc('day', now())`)
      .limit(1);
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

/** Hard cap on AI spend per user per day (USD). */
export const DAILY_SPEND_CAP_USD = Number(process.env.AI_DAILY_SPEND_CAP_USD ?? 5);

export async function isSpendCapped(userId: string): Promise<boolean> {
  const spend = await dailySpendForUser(userId);
  return spend >= DAILY_SPEND_CAP_USD;
}

export { eq };
