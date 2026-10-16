import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { mealPlanEntries, mealPlans, notificationPreferences, users } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { getPreferences, isQuietHour, sendMealReminder } from '../services/notification.service.js';
import { hourInTimezone, minuteOfHourInTimezone, todayInTimezone } from '../utils/dates.js';
import type { SweepResult } from './expiry-notifications.js';

/**
 * Meal reminders (Section 7, trigger 2).
 *
 * "Your dinner plan: Lemon Herb Chicken — start cooking now (35 min)".
 *
 * Each user configures three local times (breakfast/lunch/dinner). The sweep
 * runs hourly and fires for a meal when the user's local clock has reached that
 * meal's hour, there is an active plan with an entry for today, and the meal has
 * not been marked cooked yet.
 *
 * A `userId:localDay:mealType` marker guarantees one reminder per meal per day
 * even though the sweep repeats every hour.
 */

type MealType = 'breakfast' | 'lunch' | 'dinner';

const MEALS: MealType[] = ['breakfast', 'lunch', 'dinner'];

/**
 * How late a reminder may still be delivered.
 *
 * The sweep runs hourly (BullMQ cron `0 * * * *`; the in-process fallback fires
 * one interval after boot, at whatever minute that is), so the first sweep at or
 * after a configured time can be up to 59 minutes later. 60 covers the whole
 * cycle: a time of 18:30 is delivered by the 19:00 sweep.
 *
 * The previous implementation compared `localHour === hour` and then skipped
 * when `localMinute < minute`, which meant a reminder configured at *any*
 * non-zero minute — including both shipping defaults, 07:30 breakfast and 18:30
 * dinner — could never fire: the only sweep in its hour is the one at :00, and
 * the next sweep is in the next hour.
 */
export const GRACE_MINUTES = 60;

const MINUTES_PER_DAY = 24 * 60;

/**
 * Is a reminder configured for `configured` ("HH:MM", the user's local clock)
 * due at local time `localHour:localMinute`?
 *
 * True when local time has reached the configured minute-of-day and is no more
 * than `graceMinutes` past it, wrapping across midnight so a 23:30 reminder is
 * delivered by the 00:00 sweep instead of being skipped until the next day.
 */
export function isReminderDue(
  configured: string,
  localHour: number,
  localMinute: number,
  graceMinutes: number = GRACE_MINUTES,
): boolean {
  const [hour, minute] = parseClock(configured);
  const target = hour * 60 + minute;
  const now = localHour * 60 + localMinute;
  const elapsed = (now - target + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return elapsed <= graceMinutes;
}

function defaultHourFor(meal: MealType): string {
  return meal === 'breakfast' ? '07:30' : meal === 'lunch' ? '12:00' : '18:30';
}

export async function sendMealRemindersSweep(now = new Date()): Promise<SweepResult> {
  const db = getDb();
  const result: SweepResult = { scanned: 0, eligible: 0, sent: 0, suppressed: 0 };

  // Users with meal reminders on AND an active plan covering today.
  const today = todayInTimezone('UTC');

  const candidates = await db
    .select({
      userId: users.id,
      timezone: users.timezone,
      planId: mealPlans.id,
      dayOfWeek: mealPlanEntries.dayOfWeek,
      entryDate: mealPlanEntries.date,
      breakfast: notificationPreferences.reminderBreakfastTime,
      lunch: notificationPreferences.reminderLunchTime,
      dinner: notificationPreferences.reminderDinnerTime,
      remindersOn: notificationPreferences.mealReminders,
      completedCount: sql<number>`count(*) FILTER (WHERE ${mealPlanEntries.isCompleted})::int`,
      entryCount: sql<number>`count(*)::int`,
    })
    .from(users)
    .innerJoin(mealPlans, eq(mealPlans.userId, users.id))
    .innerJoin(mealPlanEntries, eq(mealPlanEntries.mealPlanId, mealPlans.id))
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
    .where(
      and(
        isNull(users.deletedAt),
        eq(mealPlans.status, 'active'),
        sql`${mealPlans.weekStartDate} <= ${today}`,
        sql`${mealPlans.weekEndDate} >= ${today}`,
        sql`(${mealPlanEntries.date} = ${today} OR ${mealPlanEntries.date} IS NULL)`,
      ),
    )
    .groupBy(
      users.id,
      mealPlans.id,
      mealPlanEntries.dayOfWeek,
      mealPlanEntries.date,
      notificationPreferences.reminderBreakfastTime,
      notificationPreferences.reminderLunchTime,
      notificationPreferences.reminderDinnerTime,
      notificationPreferences.mealReminders,
    )
    .limit(2_000);

  result.scanned = candidates.length;

  for (const candidate of candidates) {
    if (candidate.remindersOn === false) {
      result.suppressed += 1;
      continue;
    }

    const timezone = candidate.timezone ?? 'UTC';
    const localHour = hourInTimezone(timezone, now);
    const localMinute = minuteOfHourInTimezone(timezone, now);
    const localDay = todayInTimezone(timezone);

    for (const meal of MEALS) {
      const configured = candidate[meal] ?? defaultHourFor(meal);

      // Fire on the first sweep at or after the configured time, never twice.
      if (!isReminderDue(configured, localHour, localMinute)) continue;

      const marker = `${CacheKeys.mealReminder(candidate.userId)}:${localDay}:${meal}`;
      // eslint-disable-next-line no-await-in-loop
      if (await cache.get<string>(marker)) continue;

      try {
        // eslint-disable-next-line no-await-in-loop
        const prefs = await getPreferences(candidate.userId);

        if (isQuietHour(prefs, timezone, now)) {
          result.suppressed += 1;
          await cache.set(marker, 'quiet', 3600);
          continue;
        }

        result.eligible += 1;

        // eslint-disable-next-line no-await-in-loop
        const delivered = await sendMealReminder(candidate.userId, meal);
        await cache.set(marker, delivered ? 'sent' : 'nothing-planned', delivered ? 24 * 3600 : 3600);
        if (delivered) result.sent += 1;
        else result.suppressed += 1;
      } catch (err) {
        logger.warn({ err: (err as Error).message, userId: candidate.userId, meal }, 'Meal reminder failed');
      }
    }
  }

  return result;
}

/** Parse "HH:MM" defensively — a bad value falls back to the top of the hour. */
function parseClock(value: string): [hour: number, minute: number] {
  const [rawHour, rawMinute] = value.split(':');
  const hour = Number.parseInt(rawHour ?? '', 10);
  const minute = Number.parseInt(rawMinute ?? '0', 10);
  return [Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0, Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0];
}
