import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { pantryItems, users } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { getPreferences, isQuietHour, sendSmartSuggestion } from '../services/notification.service.js';
import { hourInTimezone, todayInTimezone } from '../utils/dates.js';
import type { SweepResult } from './expiry-notifications.js';

/**
 * Smart suggestions (Section 7, trigger 4).
 *
 * "You have spinach expiring tomorrow — try this 15-minute recipe". Delivered
 * at the user's local 5 PM, when they are deciding what to cook for dinner,
 * which is the moment the suggestion is actually useful.
 *
 * Only users with at least one item expiring inside 2 days are contacted; a
 * suggestion with nothing urgent behind it is noise, and noise trains people to
 * disable notifications.
 */

/** Local hour the suggestion lands (17:00, per the spec). */
export const SMART_SUGGESTION_HOUR = 17;

/** Urgency window — items expiring within this many days. */
const SUGGESTION_HORIZON_DAYS = 2;

export async function sendSmartSuggestionsSweep(now = new Date()): Promise<SweepResult> {
  const db = getDb();
  const result: SweepResult = { scanned: 0, eligible: 0, sent: 0, suppressed: 0 };

  const todayUtc = todayInTimezone('UTC');

  const candidates = await db
    .select({
      userId: users.id,
      timezone: users.timezone,
      expiring: sql<number>`count(*)::int`,
    })
    .from(users)
    .innerJoin(pantryItems, eq(pantryItems.userId, users.id))
    .where(
      and(
        isNull(users.deletedAt),
        eq(pantryItems.isUsed, false),
        eq(pantryItems.isExpired, false),
        sql`${pantryItems.expiryDate} IS NOT NULL`,
        lte(pantryItems.expiryDate, sql`(${todayUtc}::date + ${SUGGESTION_HORIZON_DAYS})`),
      ),
    )
    .groupBy(users.id)
    .limit(2_000);

  result.scanned = candidates.length;

  for (const candidate of candidates) {
    const timezone = candidate.timezone ?? 'UTC';
    if (hourInTimezone(timezone, now) !== SMART_SUGGESTION_HOUR) continue;

    const localDay = todayInTimezone(timezone);
    const marker = `${CacheKeys.smartSuggestion(candidate.userId)}:${localDay}`;
    if (await cache.get<string>(marker)) {
      result.suppressed += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const prefs = await getPreferences(candidate.userId);

      if (!prefs.smartSuggestions) {
        result.suppressed += 1;
        await cache.set(marker, 'off', 24 * 3600);
        continue;
      }

      if (isQuietHour(prefs, timezone, now)) {
        result.suppressed += 1;
        await cache.set(marker, 'quiet', 6 * 3600);
        continue;
      }

      result.eligible += 1;

      // eslint-disable-next-line no-await-in-loop
      const delivered = await sendSmartSuggestion(candidate.userId);
      await cache.set(marker, delivered ? 'sent' : 'no-recipe', delivered ? 24 * 3600 : 6 * 3600);

      if (delivered) result.sent += 1;
      else result.suppressed += 1;
    } catch (err) {
      logger.warn({ err: (err as Error).message, userId: candidate.userId }, 'Smart suggestion failed');
    }
  }

  return result;
}
