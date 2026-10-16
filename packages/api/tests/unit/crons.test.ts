import { describe, expect, it } from 'vitest';
import { CRONS } from '../../src/jobs/crons.js';
import { MAINTENANCE_TASKS } from '../../src/jobs/workers.js';

/**
 * The schedule and the worker must agree.
 *
 * They did not. `startCrons()` hard-coded `{ task: 'refresh-expiry' }` as the
 * payload for *every* repeatable job it registered, so on a Redis-backed
 * deployment (production, and CI's integration job) none of the four
 * notification sweeps ran at all, `purge-tokens` / `purge-scans` /
 * `recalculate-achievements` never ran either, and `refresh-expiry` ran five
 * times a day. The in-process fallback — which is what local development uses,
 * and what the notification unit tests therefore cover — called each cron's own
 * `run()`, so everything looked fine everywhere except production.
 *
 * A cron now declares the task it runs, both back-ends dispatch through
 * `runMaintenanceTask`, and these tests fail if the two lists ever drift again.
 */

describe('scheduled jobs', () => {
  it('schedules every maintenance task exactly once', () => {
    const scheduled = CRONS.map((cron) => cron.task).sort();
    expect(scheduled).toEqual([...MAINTENANCE_TASKS].sort());
  });

  it('runs the four notification sweeps the product promises', () => {
    const tasks = new Set(CRONS.map((cron) => cron.task));
    for (const task of ['expiry-alerts', 'meal-reminders', 'smart-suggestions', 'weekly-report']) {
      expect(tasks.has(task as never), `${task} is not scheduled`).toBe(true);
    }
  });

  it('keeps hourly sweeps hourly and housekeeping daily', () => {
    const hourly = (task: string) => CRONS.find((cron) => cron.task === task)?.pattern;
    expect(hourly('expiry-alerts')).toBe('0 * * * *');
    expect(hourly('meal-reminders')).toBe('0 * * * *');
    expect(hourly('smart-suggestions')).toBe('0 * * * *');
    expect(hourly('weekly-report')).toBe('0 * * * *');
    expect(hourly('purge-tokens')).toBe('30 3 * * *');
    expect(hourly('refresh-expiry')).toBe('0 4 * * *');
    expect(hourly('purge-scans')).toBe('45 3 * * *');
    expect(hourly('recalculate-achievements')).toBe('0 5 * * *');
  });

  it('gives every cron a unique key and a positive interval', () => {
    const keys = CRONS.map((cron) => cron.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const cron of CRONS) {
      expect(cron.intervalMs, cron.key).toBeGreaterThan(0);
      expect(cron.description.length, cron.key).toBeGreaterThan(10);
    }
  });
});
