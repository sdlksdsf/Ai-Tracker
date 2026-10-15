import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  addDays,
  dateForDayOfWeek,
  dayKey,
  dayKeyFromDayOfWeek,
  dayName,
  dayOfWeekFromKey,
  dayShortName,
  dayOfWeekFromIso,
  daysBetween,
  daysUntilExpiry,
  expiryLabel,
  expiryUrgency,
  fromIsoDate,
  greetingForHour,
  hourInTimezone,
  isoDayOfWeek,
  isoWeekKey,
  minuteOfHourInTimezone,
  monthKey,
  parseExpiryLabel,
  periodStart,
  previousPeriodRange,
  startOfWeek,
  endOfWeek,
  suggestExpiry,
  todayInTimezone,
  todayUtc,
  toIsoDate,
} from '../../src/utils/dates.js';

/**
 * Date maths.
 *
 * Everything expiry-, streak- and period-related flows through here, and the
 * notification sweeps depend on the timezone helpers to deliver at a user's
 * local 9 AM / 6 PM. An off-by-one in `daysUntilExpiry` shows up as "Expires
 * today" on something with three days left.
 *
 * All dates are UTC by design — the API never depends on the server's locale.
 */

const REF = new Date(Date.UTC(2026, 9, 15, 12, 30, 0)); // Thursday 15 Oct 2026

describe('toIsoDate / fromIsoDate', () => {
  it('formats a Date as YYYY-MM-DD in UTC', () => {
    expect(toIsoDate(REF)).toBe('2026-10-15');
  });

  it('accepts a string and a timestamp', () => {
    expect(toIsoDate('2026-10-15T23:00:00Z')).toBe('2026-10-15');
    expect(toIsoDate(REF.getTime())).toBe('2026-10-15');
  });

  it('round-trips', () => {
    expect(toIsoDate(fromIsoDate('2026-10-15'))).toBe('2026-10-15');
  });

  it('does not shift the day for late-UTC times', () => {
    // A local-time formatter would roll 23:30Z back a day in the Americas.
    expect(toIsoDate(new Date(Date.UTC(2026, 9, 15, 23, 30)))).toBe('2026-10-15');
  });
});

describe('todayUtc', () => {
  it('returns midnight UTC so day comparisons are stable', () => {
    const today = todayUtc();
    expect(today.getUTCHours()).toBe(0);
    expect(today.getUTCMinutes()).toBe(0);
    expect(today.getUTCSeconds()).toBe(0);
  });
});

describe('addDays', () => {
  it('adds and subtracts whole days', () => {
    expect(toIsoDate(addDays(REF, 1))).toBe('2026-10-16');
    expect(toIsoDate(addDays(REF, -1))).toBe('2026-10-14');
    expect(toIsoDate(addDays(REF, 0))).toBe('2026-10-15');
  });

  it('crosses month and year boundaries', () => {
    expect(toIsoDate(addDays('2026-10-31', 1))).toBe('2026-11-01');
    expect(toIsoDate(addDays('2026-12-31', 1))).toBe('2027-01-01');
  });

  it('handles leap years', () => {
    expect(toIsoDate(addDays('2028-02-28', 1))).toBe('2028-02-29');
    expect(toIsoDate(addDays('2028-02-29', 1))).toBe('2028-03-01');
    // 2026 is not a leap year.
    expect(toIsoDate(addDays('2026-02-28', 1))).toBe('2026-03-01');
  });
});

describe('daysBetween', () => {
  it('counts whole days, not elapsed hours', () => {
    expect(daysBetween('2026-10-15', '2026-10-18')).toBe(3);
    expect(daysBetween('2026-10-18', '2026-10-15')).toBe(-3);
    expect(daysBetween('2026-10-15', '2026-10-15')).toBe(0);
  });

  it('ignores the time component', () => {
    // 23:59 to 00:01 the next day is one calendar day apart.
    expect(daysBetween(new Date(Date.UTC(2026, 9, 15, 23, 59)), new Date(Date.UTC(2026, 9, 16, 0, 1)))).toBe(1);
  });

  it('agrees with MS_PER_DAY over long spans', () => {
    const days = daysBetween('2026-01-01', '2027-01-01');
    expect(days).toBe(365);
    expect(days * MS_PER_DAY).toBe(fromIsoDate('2027-01-01').getTime() - fromIsoDate('2026-01-01').getTime());
  });
});

describe('daysUntilExpiry', () => {
  it('returns null when there is no expiry date', () => {
    expect(daysUntilExpiry(null)).toBeNull();
    expect(daysUntilExpiry(undefined)).toBeNull();
  });

  it('returns a negative number for items already past', () => {
    const past = toIsoDate(addDays(todayUtc(), -3));
    expect(daysUntilExpiry(past)).toBe(-3);
  });

  it('returns 0 for something expiring today', () => {
    expect(daysUntilExpiry(toIsoDate(todayUtc()))).toBe(0);
  });

  it('counts forward correctly', () => {
    expect(daysUntilExpiry(toIsoDate(addDays(todayUtc(), 5)))).toBe(5);
  });
});

describe('expiryUrgency', () => {
  it('buckets by days remaining', () => {
    expect(expiryUrgency(null)).toBe('none');
    expect(expiryUrgency(-1)).toBe('expired');
    expect(expiryUrgency(0)).toBe('critical');
    expect(expiryUrgency(1)).toBe('critical');
    expect(expiryUrgency(2)).toBe('warning');
    expect(expiryUrgency(3)).toBe('soon');
    expect(expiryUrgency(5)).toBe('soon');
    expect(expiryUrgency(6)).toBe('ok');
    expect(expiryUrgency(90)).toBe('ok');
  });

  it('never returns an out-of-enum value', () => {
    const allowed = ['expired', 'critical', 'warning', 'soon', 'ok', 'none'];
    for (const days of [-100, -1, 0, 1, 2, 3, 5, 6, 30, 365, null]) {
      expect(allowed).toContain(expiryUrgency(days));
    }
  });
});

describe('expiryLabel', () => {
  it('phrases every case in plain English', () => {
    expect(expiryLabel(null)).toBe('No expiry date');
    expect(expiryLabel(0)).toBe('Expires today');
    expect(expiryLabel(1)).toBe('Expires tomorrow');
    expect(expiryLabel(3)).toBe('Expires in 3 days');
  });

  it('uses the past tense for expired items and pluralises correctly', () => {
    expect(expiryLabel(-1)).toBe('Expired 1 day ago');
    expect(expiryLabel(-2)).toBe('Expired 2 days ago');
  });
});

describe('isoDayOfWeek / startOfWeek / endOfWeek', () => {
  it('uses ISO numbering where Monday is 1 and Sunday is 7', () => {
    expect(isoDayOfWeek('2026-10-12')).toBe(1); // Monday
    expect(isoDayOfWeek('2026-10-15')).toBe(4); // Thursday
    expect(isoDayOfWeek('2026-10-18')).toBe(7); // Sunday
  });

  it('starts the week on Monday and ends on Sunday', () => {
    expect(toIsoDate(startOfWeek(REF))).toBe('2026-10-12');
    expect(toIsoDate(endOfWeek(REF))).toBe('2026-10-18');
  });

  it('is stable when the reference is already a Monday or Sunday', () => {
    expect(toIsoDate(startOfWeek('2026-10-12'))).toBe('2026-10-12');
    expect(toIsoDate(endOfWeek('2026-10-18'))).toBe('2026-10-18');
    expect(toIsoDate(startOfWeek('2026-10-18'))).toBe('2026-10-12');
  });

  it('spans exactly seven days', () => {
    expect(daysBetween(startOfWeek(REF), endOfWeek(REF))).toBe(6);
  });
});

describe('dateForDayOfWeek', () => {
  it('maps day numbers onto concrete dates within the week', () => {
    expect(dateForDayOfWeek('2026-10-12', 1)).toBe('2026-10-12');
    expect(dateForDayOfWeek('2026-10-12', 4)).toBe('2026-10-15');
    expect(dateForDayOfWeek('2026-10-12', 7)).toBe('2026-10-18');
  });
});

describe('day names', () => {
  it('returns full and short names for ISO day numbers', () => {
    expect(dayName(1)).toBe('Monday');
    expect(dayName(7)).toBe('Sunday');
    expect(dayShortName(1)).toBe('Mon');
    expect(dayShortName(7)).toBe('Sun');
  });

  it('falls back safely for out-of-range numbers', () => {
    expect(typeof dayName(0)).toBe('string');
    expect(typeof dayName(9)).toBe('string');
    expect(dayName(0).length).toBeGreaterThan(0);
  });

  it('round-trips day number ⇄ key', () => {
    for (let day = 1; day <= 7; day += 1) {
      expect(dayOfWeekFromKey(dayKeyFromDayOfWeek(day))).toBe(day);
    }
  });

  it('produces lowercase keys matching the AI meal-plan day keys', () => {
    // ai/mealplan.service.ts keys its output by dayKeyFromDayOfWeek(n).
    expect(dayKeyFromDayOfWeek(1)).toBe('monday');
    expect(dayKeyFromDayOfWeek(7)).toBe('sunday');
  });

  it('is case-insensitive on the way back', () => {
    expect(dayOfWeekFromKey('Monday')).toBe(1);
    expect(dayOfWeekFromKey('SUNDAY')).toBe(7);
  });
});

describe('greetingForHour', () => {
  it('greets appropriately through the day', () => {
    expect(greetingForHour(9)).toMatch(/morning/i);
    expect(greetingForHour(14)).toMatch(/afternoon/i);
    expect(greetingForHour(19)).toMatch(/evening/i);
    expect(greetingForHour(2)).toMatch(/midnight/i);
  });

  it('covers every hour without throwing', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(greetingForHour(hour).length).toBeGreaterThan(0);
    }
  });
});

describe('timezone helpers', () => {
  // 2026-10-15T12:30Z is 17:30 in Karachi (UTC+5) and 05:30 in Los Angeles (UTC-7).
  it('resolves the local hour in a named timezone', () => {
    expect(hourInTimezone('UTC', REF)).toBe(12);
    expect(hourInTimezone('Asia/Karachi', REF)).toBe(17);
    expect(hourInTimezone('America/Los_Angeles', REF)).toBe(5);
  });

  it('resolves the local minute', () => {
    expect(minuteOfHourInTimezone('UTC', REF)).toBe(30);
    // Half-hour offset: Kathmandu is UTC+5:45.
    expect(minuteOfHourInTimezone('Asia/Kathmandu', REF)).toBe(15);
  });

  it('resolves the local calendar date', () => {
    expect(todayInTimezone('UTC', REF)).toBe('2026-10-15');
    // Still the 15th in Karachi, but only the 15th early morning in LA.
    expect(todayInTimezone('Asia/Karachi', REF)).toBe('2026-10-15');
    expect(todayInTimezone('America/Los_Angeles', REF)).toBe('2026-10-15');
  });

  it('rolls the date over for a late-UTC instant', () => {
    const lateUtc = new Date(Date.UTC(2026, 9, 15, 23, 30));
    expect(todayInTimezone('UTC', lateUtc)).toBe('2026-10-15');
    expect(todayInTimezone('Asia/Karachi', lateUtc)).toBe('2026-10-16');
  });

  it('resolves the local ISO day of week', () => {
    expect(dayOfWeekFromIso('UTC', REF)).toBe(4); // Thursday
    // 2026-10-15T23:30Z is already Friday in Karachi.
    expect(dayOfWeekFromIso('Asia/Karachi', new Date(Date.UTC(2026, 9, 15, 23, 30)))).toBe(5);
  });

  it('falls back to UTC for an invalid timezone instead of throwing', () => {
    // A user with a corrupt timezone string must not break every sweep.
    expect(() => hourInTimezone('Not/AZone', REF)).not.toThrow();
    expect(hourInTimezone('Not/AZone', REF)).toBe(12);
    expect(dayOfWeekFromIso('Not/AZone', REF)).toBe(4);
    expect(todayInTimezone('Not/AZone', REF)).toBe('2026-10-15');
  });
});

describe('isoWeekKey / monthKey / dayKey', () => {
  it('produces stable bucket keys', () => {
    expect(isoWeekKey(REF)).toMatch(/^\d{4}-W\d{2}$/);
    expect(monthKey(REF)).toBe('2026-10');
    expect(dayKey(REF)).toBe('2026-10-15');
  });

  it('groups every day of the same week together', () => {
    const monday = isoWeekKey(fromIsoDate('2026-10-12'));
    for (let offset = 0; offset < 7; offset += 1) {
      expect(isoWeekKey(addDays('2026-10-12', offset))).toBe(monday);
    }
    expect(isoWeekKey(addDays('2026-10-12', 7))).not.toBe(monday);
  });

  it('defaults to now when called without arguments', () => {
    expect(monthKey()).toMatch(/^\d{4}-\d{2}$/);
    expect(dayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('parseExpiryLabel', () => {
  it('passes an ISO date straight through', () => {
    expect(parseExpiryLabel('2026-11-20')).toBe('2026-11-20');
  });

  it('returns null for empty input', () => {
    expect(parseExpiryLabel(null)).toBeNull();
    expect(parseExpiryLabel('')).toBeNull();
    expect(parseExpiryLabel('   ')).toBeNull();
  });

  it('parses unambiguous DD/MM dates', () => {
    // 25 can only be a day, so the order is unambiguous.
    expect(parseExpiryLabel('25/12/2026')).toBe('2026-12-25');
  });

  it('parses unambiguous MM/DD dates', () => {
    expect(parseExpiryLabel('12/25/2026')).toBe('2026-12-25');
  });

  it('treats ambiguous dates as DD/MM (most of the world)', () => {
    expect(parseExpiryLabel('05/06/2026')).toBe('2026-06-05');
  });

  it('expands two-digit years', () => {
    expect(parseExpiryLabel('25/12/26')).toBe('2026-12-25');
    expect(parseExpiryLabel('25/12/99')).toBe('1999-12-25');
  });

  it('parses named months', () => {
    expect(parseExpiryLabel('12 Jun 2026')).toBe('2026-06-12');
    expect(parseExpiryLabel('Jun 12, 2026')).toBe('2026-06-12');
  });

  it('honours an explicit year on a named-month label', () => {
    // Regression: the optional day group used to swallow the first two digits of
    // the year, so "12 Jun 2026" lost its year and the "assume next year"
    // fallback pushed the expiry a full year into the future — suppressing the
    // alert for food that was actually about to go off.
    expect(parseExpiryLabel('12 Jun 2026')).toBe('2026-06-12');
    expect(parseExpiryLabel('5 Dec 2027')).toBe('2027-12-05');
    expect(parseExpiryLabel('28 Feb 2028')).toBe('2028-02-28');
    // A past date with an explicit year must NOT be rolled forward either.
    expect(parseExpiryLabel('1 Jan 2020')).toBe('2020-01-01');
  });

  it('assumes next year for a named month with no year that has already passed', () => {
    const parsed = parseExpiryLabel('1 Jan', 2026);
    expect(parsed).toBe('2027-01-01');
  });

  it('parses relative "N days" labels from a pack', () => {
    expect(parseExpiryLabel('best before 120 days from purchase')).toBe(toIsoDate(addDays(todayUtc(), 120)));
  });

  it('returns null for text it cannot parse', () => {
    expect(parseExpiryLabel('see pack')).toBeNull();
    expect(parseExpiryLabel('best before end')).toBeNull();
  });

  it('clamps impossible day and month values instead of producing junk', () => {
    const parsed = parseExpiryLabel('45/18/2026');
    expect(parsed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('suggestExpiry', () => {
  it('adds the shelf life to the reference date', () => {
    expect(suggestExpiry('milk', 7, REF)).toBe('2026-10-22');
  });

  it('defaults to a week when no shelf life is known', () => {
    expect(suggestExpiry('mystery', null, REF)).toBe('2026-10-22');
  });
});

describe('periodStart', () => {
  it('starts a week on the Monday', () => {
    expect(toIsoDate(periodStart('week', REF))).toBe('2026-10-12');
  });

  it('starts a month on the first', () => {
    expect(toIsoDate(periodStart('month', REF))).toBe('2026-10-01');
  });

  it('starts a quarter on its first month', () => {
    expect(toIsoDate(periodStart('quarter', REF))).toBe('2026-10-01');
    expect(toIsoDate(periodStart('quarter', fromIsoDate('2026-05-20')))).toBe('2026-04-01');
    expect(toIsoDate(periodStart('quarter', fromIsoDate('2026-02-20')))).toBe('2026-01-01');
  });

  it('starts a year on 1 January', () => {
    expect(toIsoDate(periodStart('year', REF))).toBe('2026-01-01');
  });

  it('returns the epoch for "all"', () => {
    expect(toIsoDate(periodStart('all', REF))).toBe('1970-01-01');
  });

  it('is never in the future', () => {
    for (const period of ['week', 'month', 'quarter', 'year', 'all'] as const) {
      expect(periodStart(period, REF).getTime()).toBeLessThanOrEqual(REF.getTime());
    }
  });
});

describe('previousPeriodRange', () => {
  it('returns the seven days before this week', () => {
    const { start, end } = previousPeriodRange('week', REF);
    expect(toIsoDate(start)).toBe('2026-10-05');
    expect(toIsoDate(end)).toBe('2026-10-11');
    expect(daysBetween(start, end)).toBe(6);
  });

  it('returns the whole of the previous month', () => {
    const { start, end } = previousPeriodRange('month', REF);
    expect(toIsoDate(start)).toBe('2026-09-01');
    expect(toIsoDate(end)).toBe('2026-09-30');
  });

  it('returns the whole of the previous year', () => {
    const { start, end } = previousPeriodRange('year', REF);
    expect(toIsoDate(start)).toBe('2025-01-01');
    expect(toIsoDate(end)).toBe('2025-12-31');
  });

  it('returns the previous quarter', () => {
    const { start, end } = previousPeriodRange('quarter', REF);
    expect(toIsoDate(start)).toBe('2026-07-01');
    expect(toIsoDate(end)).toBe('2026-09-30');
  });

  it('always ends before the current period starts', () => {
    for (const period of ['week', 'month', 'quarter', 'year'] as const) {
      const { end } = previousPeriodRange(period, REF);
      expect(end.getTime()).toBeLessThan(periodStart(period, REF).getTime());
    }
  });

  it('produces ranges of equal length for month and year comparisons', () => {
    // Week-over-week and year-over-year comparisons are only meaningful if the
    // two windows cover the same amount of time.
    const week = previousPeriodRange('week', REF);
    expect(daysBetween(week.start, week.end)).toBe(6);

    const year = previousPeriodRange('year', REF);
    expect(daysBetween(year.start, year.end)).toBe(364);
  });
});
