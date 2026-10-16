import { QUEUE_NAMES, getQueue, isRedisBacked } from '../lib/queue.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { runMaintenanceTask, SCAN_RETENTION_DAYS, type MaintenancePayload, type MaintenanceTask } from './workers.js';

/**
 * Scheduled jobs (Section 7 — Notifications, Section 2 — BullMQ).
 *
 * The six notification triggers the product promises:
 *
 *   expiry alerts        daily 09:00 local   → jobs/expiry-notifications.ts
 *   meal reminders       daily 08:00/12:00/18:00 local
 *   weekly report        Sunday 18:00 local
 *   smart suggestions    daily 17:00 local
 *   achievements         on unlock (event-driven, not scheduled)
 *   scan complete        on job finish (event-driven)
 *
 * Schedules are expressed in UTC here and the per-user local time is resolved
 * inside each job, because a cron pattern cannot follow 200 timezones. Running
 * hourly and filtering on "is it the right local hour for this user" is what
 * makes the 9 AM promise actually true for the user.
 *
 * With Redis, BullMQ repeatable jobs own the schedule. Without Redis (single
 * process), a plain `setInterval` drives the same functions — so local dev and
 * CI behave identically to production.
 */

export interface CronDefinition {
  key: string;
  /** Human-readable description for the log line and `/health`. */
  description: string;
  /** BullMQ cron pattern (UTC). */
  pattern: string;
  /** Milliseconds between runs in the in-process fallback. */
  intervalMs: number;
  /**
   * The task this schedule runs. It is the *only* thing that decides what the
   * job does — both back-ends dispatch through `runMaintenanceTask`, so a
   * schedule can no longer enqueue a job the worker does not recognise (or the
   * wrong one).
   */
  task: MaintenanceTask;
}

/** Hourly marker jobs — each resolves the user's local time internally. */
const HOURLY = 60 * 60 * 1000;
const DAILY = 24 * HOURLY;

export const CRONS: CronDefinition[] = [
  {
    key: 'expiry-alerts',
    description: 'Expiry alerts — 3 days out and on the day, delivered at the user\'s 9 AM',
    pattern: '0 * * * *',
    intervalMs: HOURLY,
    task: 'expiry-alerts',
  },
  {
    key: 'meal-reminders',
    description: 'Breakfast/lunch/dinner reminders at each user\'s configured times',
    pattern: '0 * * * *',
    intervalMs: HOURLY,
    task: 'meal-reminders',
  },
  {
    key: 'smart-suggestions',
    description: '"Cook this before it expires" suggestions at the user\'s 5 PM',
    pattern: '0 * * * *',
    intervalMs: HOURLY,
    task: 'smart-suggestions',
  },
  {
    key: 'weekly-report',
    description: 'Sunday 6 PM digest: waste, savings, streak and next week\'s plan',
    pattern: '0 * * * *',
    intervalMs: HOURLY,
    task: 'weekly-report',
  },
  {
    key: 'refresh-expiry-flags',
    description: 'Recompute pantry `is_expired` flags at 04:00 UTC',
    pattern: '0 4 * * *',
    intervalMs: DAILY,
    task: 'refresh-expiry',
  },
  {
    key: 'purge-tokens',
    description: 'Delete expired refresh tokens and password-reset tokens at 03:30 UTC',
    pattern: '30 3 * * *',
    intervalMs: DAILY,
    task: 'purge-tokens',
  },
  {
    key: 'purge-scans',
    description: `Drop scans older than ${SCAN_RETENTION_DAYS} days at 03:45 UTC (photos stay in storage)`,
    pattern: '45 3 * * *',
    intervalMs: DAILY,
    task: 'purge-scans',
  },
  {
    key: 'recalculate-achievements',
    description: 'Re-evaluate badges for recently active users at 05:00 UTC',
    pattern: '0 5 * * *',
    intervalMs: DAILY,
    task: 'recalculate-achievements',
  },
];

let timers: NodeJS.Timeout[] = [];

/**
 * Start the scheduler.
 *
 * With Redis we register BullMQ repeatable jobs (deduplicated across replicas).
 * Without it we use `setInterval`, offsetting the first tick so a restart does
 * not immediately re-run every daily job.
 */
export async function startCrons(): Promise<void> {
  if (!env.ENABLE_CRONS) {
    logger.info('ENABLE_CRONS=false — scheduled jobs are disabled');
    return;
  }

  if (isRedisBacked()) {
    const queue = getQueue<MaintenancePayload>(QUEUE_NAMES.maintenance);

    for (const cron of CRONS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await queue.add(
          cron.key,
          // Each schedule carries its own task. Hard-coding a payload here is
          // what made the scheduler and the worker disagree.
          { task: cron.task },
          {
            pattern: cron.pattern,
            // No `:` — BullMQ rejects custom ids containing it ("Custom Id cannot contain :").
            jobId: `cron-${cron.key}`,
            removeOnComplete: true,
          },
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message, cron: cron.key }, 'Could not schedule repeatable job');
      }
    }

    logger.info({ crons: CRONS.length, backend: 'bullmq' }, 'Scheduled jobs registered');
    return;
  }

  // In-process fallback: one timer per cron. They share a phase, so every job
  // fires one full interval after boot rather than immediately on startup.
  timers = CRONS.map((cron) => {
    const timer = setInterval(() => {
      runMaintenanceTask(cron.task).catch((err: unknown) => {
        logger.error({ err, cron: cron.key, task: cron.task }, 'Scheduled job failed');
      });
    }, cron.intervalMs);
    timer.unref();
    return timer;
  });

  logger.info({ crons: CRONS.length, backend: 'in-process', firstRun: `~${Math.round(CRONS[0]!.intervalMs / 60_000)} min` }, 'Scheduled jobs registered');
}

/** Stop every timer. Called on shutdown. */
export function stopCrons(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}
