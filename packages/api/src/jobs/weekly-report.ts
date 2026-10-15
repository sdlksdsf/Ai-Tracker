import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { notificationPreferences, users } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { getPreferences, isQuietHour, sendWeeklyReport } from '../services/notification.service.js';
import { buildWeeklyReport } from '../services/dashboard.service.js';
import { isoWeekKey } from '../utils/dates.js';
import { dayOfWeekFromIso, hourInTimezone } from '../utils/dates.js';
import type { SweepResult } from './expiry-notifications.js';

/**
 * Weekly report (Section 7, trigger 3) — Sunday 6 PM.
 *
 * "This week: 2.3 kg waste prevented, $18.40 saved, 5-day streak 🔥".
 *
 * Keyed by ISO week rather than by day, so a user who is offline on Sunday
 * evening still gets exactly one report for that week and never two.
 */

/** Local hour the digest lands (18:00 on Sunday, per the spec). */
export const WEEKLY_REPORT_HOUR = 18;

/** Sunday. */
const SUNDAY = 7;

export async function sendWeeklyReportsSweep(now = new Date()): Promise<SweepResult> {
  const db = getDb();
  const result: SweepResult = { scanned: 0, eligible: 0, sent: 0, suppressed: 0 };

  const candidates = await db
    .select({
      userId: users.id,
      timezone: users.timezone,
      weeklyOn: notificationPreferences.weeklyReports,
    })
    .from(users)
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
    .where(and(isNull(users.deletedAt), sql`${users.lastActiveAt} > now() - interval '60 days'`))
    .limit(5_000);

  result.scanned = candidates.length;

  for (const candidate of candidates) {
    if (candidate.weeklyOn === false) {
      result.suppressed += 1;
      continue;
    }

    const timezone = candidate.timezone ?? 'UTC';

    // Only on the user's local Sunday, only at their local 6 PM.
    if (dayOfWeekFromIso(timezone, now) !== SUNDAY) continue;
    if (hourInTimezone(timezone, now) !== WEEKLY_REPORT_HOUR) continue;

    const marker = `${CacheKeys.weeklyReport(candidate.userId)}:${isoWeekKey(now)}`;
    if (await cache.get<string>(marker)) {
      result.suppressed += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const prefs = await getPreferences(candidate.userId);

      if (isQuietHour(prefs, timezone, now)) {
        result.suppressed += 1;
        await cache.set(marker, 'quiet', 6 * 3600);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const report = await buildWeeklyReport(candidate.userId);

      result.eligible += 1;

      // eslint-disable-next-line no-await-in-loop
      await sendWeeklyReport(candidate.userId, {
        savedUsd: report.money_saved_usd,
        wasteChangePct: report.waste_change_pct,
        mealsCooked: report.meals_cooked,
      });

      // 8 days: long enough to cover the whole ISO week, short enough to free
      // the key before the next one matters.
      await cache.set(marker, 'sent', 8 * 24 * 3600);
      result.sent += 1;
    } catch (err) {
      logger.warn({ err: (err as Error).message, userId: candidate.userId }, 'Weekly report failed');
    }
  }

  return result;
}
