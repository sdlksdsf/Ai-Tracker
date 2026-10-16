import { DAY_NAMES, DAY_SHORT_NAMES, type DayOfWeek } from '@platematch/shared';

/** Date helpers — all timezone-safe (we work in UTC and format per user TZ). */

export const MS_PER_DAY = 86_400_000;

/** `2025-06-16` */
export function toIsoDate(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/** Midnight UTC for an ISO date string. */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addDays(date: Date | string, days: number): Date {
  const base = typeof date === 'string' ? fromIsoDate(date) : new Date(date.getTime());
  return new Date(base.getTime() + days * MS_PER_DAY);
}

/** Whole days between two dates (b - a), ignoring time of day. */
export function daysBetween(a: Date | string, b: Date | string): number {
  const da = typeof a === 'string' ? fromIsoDate(a) : new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
  const db = typeof b === 'string' ? fromIsoDate(b) : new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()));
  return Math.round((db.getTime() - da.getTime()) / MS_PER_DAY);
}

/** Days until an expiry date from today (negative = already expired). */
export function daysUntilExpiry(expiryIso: string | Date | null | undefined): number | null {
  if (!expiryIso) return null;
  const expiry = typeof expiryIso === 'string' ? fromIsoDate(expiryIso) : expiryIso;
  return daysBetween(todayUtc(), expiry);
}

export type ExpiryUrgency = 'expired' | 'critical' | 'warning' | 'soon' | 'ok' | 'none';

/** Colour-code an item by how close it is to expiry (UI spec, Screen 7). */
export function expiryUrgency(days: number | null): ExpiryUrgency {
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= 1) return 'critical';
  if (days <= 2) return 'warning';
  if (days <= 5) return 'soon';
  return 'ok';
}

/** Human string: "Expires tomorrow", "Expires in 3 days", "Expired 2 days ago". */
export function expiryLabel(days: number | null): string {
  if (days === null) return 'No expiry date';
  if (days < 0) return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

/** ISO day-of-week where Monday = 1 … Sunday = 7. */
export function isoDayOfWeek(date: Date | string): DayOfWeek {
  const d = typeof date === 'string' ? fromIsoDate(date) : date;
  const js = d.getUTCDay(); // 0 = Sunday
  return (js === 0 ? 7 : js) as DayOfWeek;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: Date | string = new Date()): Date {
  const d = typeof date === 'string' ? fromIsoDate(date) : new Date(date.getTime());
  const day = isoDayOfWeek(d);
  return addDays(toIsoDate(d), -(day - 1));
}

export function endOfWeek(date: Date | string = new Date()): Date {
  return addDays(toIsoDate(startOfWeek(date)), 6);
}

/** Map day-of-week (1..7) onto real dates for a plan starting on `weekStart`. */
export function dateForDayOfWeek(weekStart: Date | string, dayOfWeek: number): string {
  // weekStart may be any day; day 1 maps to the plan's first day.
  return toIsoDate(addDays(toIsoDate(weekStart), dayOfWeek - 1));
}

export function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek as DayOfWeek] ?? 'Monday';
}

export function dayShortName(dayOfWeek: number): string {
  return DAY_SHORT_NAMES[dayOfWeek as DayOfWeek] ?? 'Mon';
}

export function dayKeyFromDayOfWeek(dayOfWeek: number): string {
  return dayName(dayOfWeek).toLowerCase();
}

export function dayOfWeekFromKey(key: string): DayOfWeek {
  const idx = Object.values(DAY_NAMES).findIndex((n) => n.toLowerCase() === key.toLowerCase());
  return ((idx === -1 ? 0 : idx) + 1) as DayOfWeek;
}

/** "Good morning" / "Good afternoon" / "Good evening" in the user's timezone. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return 'Burning the midnight oil';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Good night';
}

/** Current hour in a user's IANA timezone. */
export function hourInTimezone(timezone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    return hour ? Number(hour) % 24 : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

/**
 * Current minute within the hour, in a user's IANA timezone.
 *
 * The meal-reminder sweep needs this so a reminder configured for 18:30 does
 * not fire at 18:00. Falls back to UTC when the timezone string is invalid.
 */
export function minuteOfHourInTimezone(timezone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      minute: '2-digit',
    }).formatToParts(date);
    const minute = parts.find((p) => p.type === 'minute')?.value;
    return minute ? Number(minute) % 60 : date.getUTCMinutes();
  } catch {
    return date.getUTCMinutes();
  }
}

/** Today's date (YYYY-MM-DD) in a user's IANA timezone. */
export function todayInTimezone(timezone: string, date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return toIsoDate(date);
  }
}

/**
 * ISO day of week (1 = Monday … 7 = Sunday) for `date` in a user's timezone.
 *
 * The weekly-report sweep needs the user's *local* Sunday, which is not the
 * same instant as UTC Sunday for anyone east of Greenwich.
 */
export function dayOfWeekFromIso(timezone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
    }).formatToParts(date);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const index = order.indexOf(weekday ?? '');
    return index === -1 ? ((date.getUTCDay() + 6) % 7) + 1 : index + 1;
  } catch {
    return ((date.getUTCDay() + 6) % 7) + 1;
  }
}

/** ISO week key, e.g. `2025-W24`. */
export function isoWeekKey(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Parse the many date formats food labels use. Returns ISO date or null. */
export function parseExpiryLabel(raw: string | null | undefined, referenceYear = new Date().getUTCFullYear()): string | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // Already ISO.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;

  // 12/06/2025 — assume DD/MM/YYYY (most of the world) unless month > 12.
  const slash = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (slash) {
    let [, a, b, yearStr] = slash as unknown as [string, string, string, string];
    let first = Number(a);
    let second = Number(b);
    let year = Number(yearStr);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (first > 12 && second <= 12) {
      // DD/MM
      return fmt(year, second, first);
    }
    if (second > 12 && first <= 12) {
      return fmt(year, first, second);
    }
    // Ambiguous → treat as DD/MM/YYYY.
    if (first > 31) [first, second] = [second, first];
    return fmt(year, second, first);
  }

  // "12 Jun 2025" / "Jun 12, 2025" / "June 2025"
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7,
    aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const named = text.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  // The day-after-month group must not swallow the first two digits of a
  // 4-digit year: without the (?!\d) guard, "12 Jun 2026" parsed as day 12,
  // month Jun, year <none> — and the "assume next year" fallback below then
  // pushed a valid expiry date a whole year into the future, suppressing the
  // alert for food that was actually about to go off.
  const nameMatch = named.match(
    /(\d{1,2})?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(?:(\d{1,2})(?!\d))?\s*(\d{4})?/,
  );
  if (nameMatch) {
    const month = months[nameMatch[2] as string];
    const day = Number(nameMatch[1] ?? nameMatch[3] ?? 1);
    let year = Number(nameMatch[4] ?? referenceYear);
    if (month && day >= 1 && day <= 31) {
      // If no year was given and the date is in the past, assume next year.
      if (!nameMatch[4]) {
        const candidate = new Date(Date.UTC(year, month - 1, day));
        if (candidate.getTime() < Date.now() - MS_PER_DAY) year += 1;
      }
      return fmt(year, month, day);
    }
  }

  // "Best before 120 days from purchase" → not parseable here.
  const daysMatch = text.match(/(\d{1,4})\s*days?/i);
  if (daysMatch) return toIsoDate(addDays(todayUtc(), Number(daysMatch[1])));

  return null;
}

function fmt(year: number, month: number, day: number): string {
  const m = Math.min(12, Math.max(1, month));
  const d = Math.min(31, Math.max(1, day));
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Expiry date = purchase/today + suggested shelf life. */
export function suggestExpiry(name: string, shelfLifeDays: number | null, from = todayUtc()): string {
  const days = shelfLifeDays ?? 7;
  return toIsoDate(addDays(from, days));
}

/** Start of the period covered by `period=week|month|quarter|year`. */
export function periodStart(period: 'week' | 'month' | 'quarter' | 'year' | 'all', now = new Date()): Date {
  switch (period) {
    case 'week':
      return startOfWeek(now);
    case 'month':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    case 'quarter': {
      const q = Math.floor(now.getUTCMonth() / 3) * 3;
      return new Date(Date.UTC(now.getUTCFullYear(), q, 1));
    }
    case 'year':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case 'all':
      return new Date(Date.UTC(1970, 0, 1));
  }
}

export function previousPeriodRange(period: 'week' | 'month' | 'quarter' | 'year' | 'all', now = new Date()): { start: Date; end: Date } {
  const start = periodStart(period, now);
  const end = startOfWeek(start) === start && period === 'week' ? addDays(toIsoDate(start), -1) : new Date(start.getTime() - 1);

  switch (period) {
    case 'week':
      return { start: addDays(toIsoDate(start), -7), end: addDays(toIsoDate(start), -1) };
    case 'month':
      return { start: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)), end };
    case 'quarter':
      return { start: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1)), end };
    case 'year':
      return { start: new Date(Date.UTC(start.getUTCFullYear() - 1, 0, 1)), end };
    case 'all':
      return { start, end };
  }
}

// ---------------------------------------------------------------------------
// Per-user local calendars
// ---------------------------------------------------------------------------

/**
 * Offset of `timezone` from UTC, in minutes east, at `instant`.
 *
 * `Intl` renders a zoned wall clock; subtracting the instant back out gives the
 * zone's offset for that exact moment, which is what makes DST transitions
 * resolvable without a library.
 */
export function timezoneOffsetMinutes(timezone: string, instant = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);

    const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const wallClock = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'));

    // Millisecond precision is dropped by the formatter, so compare against the
    // whole-second instant.
    const whole = instant.getTime() - instant.getMilliseconds();
    return Math.round((wallClock - whole) / 60_000);
  } catch {
    // Unknown IANA zone (or an Intl without that zone): treat as UTC.
    return 0;
  }
}

/**
 * The UTC instant at which `isoDate` begins (00:00) in `timezone`.
 *
 * Used to turn a user's local calendar day into the instant range a
 * `timestamptz` column can be filtered by — "wasted today in Karachi" starts at
 * 19:00 UTC the day before.
 */
export function startOfDayInTimezone(timezone: string, isoDate: string): Date {
  const naive = fromIsoDate(isoDate);
  const guess = new Date(naive.getTime() - timezoneOffsetMinutes(timezone, naive) * 60_000);
  // Re-resolve with the offset in force at the resolved instant: on a DST
  // boundary the first guess can land in a different offset.
  return new Date(naive.getTime() - timezoneOffsetMinutes(timezone, guess) * 60_000);
}

export interface LocalPeriodDates {
  /** First local day of the current period (inclusive). */
  startIso: string;
  /** Last local day of the current period (inclusive). */
  endIso: string;
  /** Last local day of the preceding period (inclusive). */
  previousStartIso: string;
  previousEndIso: string;
}

/**
 * Calendar boundaries for a stats period, expressed as the *user's* local
 * dates.
 *
 * `periodStart` above anchors everything to UTC midnight, which is wrong for
 * the ~2/3 of the world that is not on UTC: a Karachi user logging waste at
 * 02:00 on Monday was filing it under the previous UTC week, and at 02:00 on
 * the first of the month the whole screen still showed last month.
 */
export function localPeriodDates(
  period: 'week' | 'month' | 'quarter' | 'year' | 'all',
  localToday: string,
): LocalPeriodDates {
  const year = Number(localToday.slice(0, 4));
  const month = Number(localToday.slice(5, 7));

  let startIso: string;
  let previousStartIso: string;

  switch (period) {
    case 'week':
      // Monday of the local week containing `localToday`.
      startIso = toIsoDate(addDays(localToday, -(isoDayOfWeek(localToday) - 1)));
      previousStartIso = toIsoDate(addDays(startIso, -7));
      break;
    case 'month':
      startIso = `${localToday.slice(0, 7)}-01`;
      previousStartIso = month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`;
      break;
    case 'quarter': {
      const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
      startIso = `${year}-${String(quarterStartMonth).padStart(2, '0')}-01`;
      previousStartIso =
        quarterStartMonth === 1
          ? `${year - 1}-10-01`
          : `${year}-${String(quarterStartMonth - 3).padStart(2, '0')}-01`;
      break;
    }
    case 'year':
      startIso = `${year}-01-01`;
      previousStartIso = `${year - 1}-01-01`;
      break;
    case 'all':
      startIso = '1970-01-01';
      previousStartIso = '1970-01-01';
      break;
  }

  return {
    startIso,
    endIso: localToday,
    previousStartIso,
    previousEndIso: toIsoDate(addDays(startIso, -1)),
  };
}

/** Every local date from `startIso` to `endIso` inclusive (capped at 400 days). */
export function isoDatesInRange(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const last = fromIsoDate(endIso).getTime();
  let cursor = fromIsoDate(startIso).getTime();

  while (cursor <= last && dates.length < 400) {
    dates.push(toIsoDate(cursor));
    cursor += MS_PER_DAY;
  }

  return dates;
}
