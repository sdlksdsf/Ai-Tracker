import { describe, expect, it } from 'vitest';
import { GRACE_MINUTES, isReminderDue } from '../../src/jobs/meal-reminders.js';

/**
 * When a meal reminder is allowed to fire.
 *
 * The sweep runs hourly at :00 (BullMQ cron `0 * * * *`), so for any configured
 * time with a non-zero minute the only sweep inside that hour is the one that
 * comes *before* it. The old test — `localHour === hour` followed by
 * `skip if localMinute < minute` — therefore skipped the reminder forever:
 * breakfast (07:30, the default) and dinner (18:30, the default) could never be
 * delivered, while 08:00 and 19:00 worked.
 *
 * The rule is now "the first sweep at or after the configured time, within one
 * sweep cycle", which is exactly what a :00-only schedule can honour.
 */

describe('isReminderDue', () => {
  it('fires on the sweep that lands inside the configured minute', () => {
    expect(isReminderDue('18:30', 18, 30)).toBe(true);
    expect(isReminderDue('08:00', 8, 0)).toBe(true);
  });

  it('fires on the next hourly sweep when the configured minute has already passed', () => {
    // 18:30 configured, sweep at 19:00 — the only sweep this hour can offer.
    expect(isReminderDue('18:30', 19, 0)).toBe(true);
    // 07:30 configured, sweep at 08:00.
    expect(isReminderDue('07:30', 8, 0)).toBe(true);
    // The in-process fallback has an arbitrary phase, so a late sweep counts too.
    expect(isReminderDue('07:30', 8, 29)).toBe(true);
  });

  it('does not fire before the configured time', () => {
    // Sweep at 18:00 for a 18:30 reminder — the whole point of the guard.
    expect(isReminderDue('18:30', 18, 0)).toBe(false);
    expect(isReminderDue('12:00', 11, 0)).toBe(false);
    expect(isReminderDue('23:30', 23, 29)).toBe(false);
  });

  it('does not fire a whole cycle late', () => {
    // 19:30 is more than one sweep after 18:30: the reminder was already
    // delivered by the 19:00 sweep (or suppressed), and delivering again would
    // wake someone up with yesterday's dinner.
    expect(isReminderDue('18:30', 19, 31)).toBe(false);
    expect(isReminderDue('00:00', 1, 1)).toBe(false);
  });

  it('wraps across midnight instead of dropping the reminder', () => {
    // 23:30 configured → the 00:00 sweep delivers it, 30 minutes late.
    expect(isReminderDue('23:30', 0, 0)).toBe(true);
    expect(isReminderDue('23:45', 0, 44)).toBe(true);
    // …but the previous evening's 23:00 sweep must stay quiet.
    expect(isReminderDue('23:30', 23, 0)).toBe(false);
    expect(isReminderDue('23:30', 22, 0)).toBe(false);
  });

  it('never fires for every meal at once', () => {
    // A user with 07:30 / 12:00 / 18:30 configured: exactly one of the three is
    // due in any given sweep.
    const meals = ['07:30', '12:00', '18:30'];
    const dueAt = (hour: number, minute: number) => meals.filter((m) => isReminderDue(m, hour, minute));
    expect(dueAt(8, 0)).toEqual(['07:30']);
    expect(dueAt(12, 0)).toEqual(['12:00']);
    expect(dueAt(19, 0)).toEqual(['18:30']);
    expect(dueAt(3, 0)).toEqual([]);
  });

  it('covers exactly one sweep cycle', () => {
    // Every minute of a 60-minute cycle is reachable, so no configured time can
    // be starved by the schedule.
    expect(GRACE_MINUTES).toBeGreaterThanOrEqual(59);
    for (let minute = 0; minute < 60; minute += 1) {
      const configured = `10:${String(minute).padStart(2, '0')}`;
      expect(isReminderDue(configured, 11, 0), configured).toBe(true);
    }
  });

  it('falls back to the top of the hour for a malformed setting', () => {
    expect(isReminderDue('garbage', 0, 0)).toBe(true);
    expect(isReminderDue('', 0, 0)).toBe(true);
    expect(isReminderDue('25:99', 23, 59)).toBe(true);
  });
});
