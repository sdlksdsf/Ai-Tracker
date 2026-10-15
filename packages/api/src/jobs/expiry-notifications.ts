import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { pantryItems, users } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache } from '../lib/redis.js';
import {
  getPreferences,
  isQuietHour,
  sendExpiryAlerts,
} from '../services/notification.service.js';
import { hourInTimezone, todayInTimezone } from '../utils/dates.js';

/**
 * Expiry alerts — "3 items expire today" (Section 7, trigger 1).
 *
 * The product promises a 9 AM delivery. A cron pattern cannot follow 200
 * timezones, so this sweep runs hourly and only acts for users whose *local*
 * hour is the delivery hour. That is what makes the alert genuinely arrive in
 * the morning for a user in Karachi and in the morning for a user in Toronto.
 *
 * Each user is processed at most once per local day: a `userId:localDay` marker
 * in Redis records that today's alert already went out.
 */

export interface SweepResult {
  scanned: number;
  eligible: number;
  sent: number;
  suppressed: number;
}

/** Local hour the expiry alert is delivered (09:00, per the spec). */
export const EXPIRY_ALERT_HOUR = 9;

/** Items expiring within this many days are worth an alert. */
const EXPIRY_HORIZON_DAYS = 3;

/** Upper bound on users examined per sweep, so a large install stays bounded. */
const SWEEP_BATCH = 2_000;

export async function sendExpiryAlertsSweep(now = new Date()): Promise<SweepResult> {
  const db = getDb();
  const result: SweepResult = { scanned: 0, eligible: 0, sent: 0, suppressed: 0 };

  const todayUtc = todayInTimezone('UTC');

  // Only users who actually have something expiring soon are worth waking up.
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
        lte(pantryItems.expiryDate, sql`(${todayUtc}::date + ${EXPIRY_HORIZON_DAYS})`),
      ),
    )
    .groupBy(users.id)
    .orderBy(sql`count(*) DESC`)
    .limit(SWEEP_BATCH);

  result.scanned = candidates.length;

  for (const candidate of candidates) {
    const timezone = candidate.timezone ?? 'UTC';

    // Not this user's delivery hour yet — the next hourly sweep will catch them.
    if (hourInTimezone(timezone, now) !== EXPIRY_ALERT_HOUR) continue;

    const localDay = todayInTimezone(timezone);
    const marker = `${CacheKeys.expiryDigest(candidate.userId)}:${localDay}`;

    if (await cache.get<string>(marker)) {
      result.suppressed += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const prefs = await getPreferences(candidate.userId);

      if (!prefs.expiryAlerts) {
        result.suppressed += 1;
        // Remember the decision so we do not re-read preferences every hour.
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
      const delivered = await sendExpiryAlerts(candidate.userId);

      if (delivered > 0) {
        result.sent += 1;
        await cache.set(marker, 'sent', 24 * 3600);
      } else {
        result.suppressed += 1;
        await cache.set(marker, 'nothing-to-report', 12 * 3600);
      }
    } catch (err) {
      // One user failing must never abort the sweep for everyone else.
      logger.warn(
        { err: (err as Error).message, userId: candidate.userId },
        'Expiry alert failed for one user — continuing',
      );
    }
  }

  return result;
}
