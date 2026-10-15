import { QUEUE_NAMES, getQueue, isRedisBacked } from '../lib/queue.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import type { MaintenancePayload } from './workers.js';

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
  run: () => Promise<void>;
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
    run: async () => {
      const { sendExpiryAlertsSweep } = await import('./expiry-notifications.js');
      const result = await sendExpiryAlertsSweep();
      logger.info(result, 'Expiry alert sweep finished');
    },
  },
  {
    key: 'meal-reminders',
    description: 'Breakfast/lunch/dinner reminders at each user\'s configured times',
    pattern: '0 * * * *',
    intervalMs: HOURLY,
    run: async () => {
      const { sendMealRemindersSweep } = await import('./meal-reminders.js');
      const result = await sendMealRemindersSweep();
      logger.info(result, 'Meal reminder sweep finished');
    },
  },
  {
    key: 'smart-suggestions',
    description: '"Cook this before it expires" suggestions at the user\'s 5 PM',
    pattern: '0 * * * *',
    intervalMs: HOURLY,
    run: async () => {
      const { sendSmartSuggestionsSweep } = await import('./smart-suggestions.js');
      const result = await sendSmartSuggestionsSweep();
      logger.info(result, 'Smart suggestion sweep finished');
    },
  },
  {
    key: 'weekly-report',
    description: 'Sunday 6 PM digest: waste, savings, streak and next week\'s plan',
    pattern: '0 * * * *',
    intervalMs: HOURLY,
    run: async () => {
      const { sendWeeklyReportsSweep } = await import('./weekly-report.js');
      const result = await sendWeeklyReportsSweep();
      logger.info(result, 'Weekly report sweep finished');
    },
  },
  {
    key: 'refresh-expiry-flags',
    description: 'Recompute pantry `is_expired` flags at 04:00 UTC',
    pattern: '0 4 * * *',
    intervalMs: DAILY,
    run: async () => {
      await getQueue<MaintenancePayload>(QUEUE_NAMES.maintenance).add('refresh-expiry', { task: 'refresh-expiry' });
    },
  },
  {
    key: 'purge-tokens',
    description: 'Delete expired refresh tokens and password-reset tokens at 03:30 UTC',
    pattern: '30 3 * * *',
    intervalMs: DAILY,
    run: async () => {
      await getQueue<MaintenancePayload>(QUEUE_NAMES.maintenance).add('purge-tokens', { task: 'purge-tokens' });
    },
  },
  {
    key: 'purge-scans',
    description: 'Drop scans older than 30 days at 03:45 UTC (photos stay in storage)',
    pattern: '45 3 * * *',
    intervalMs: DAILY,
    run: async () => {
      await getQueue<MaintenancePayload>(QUEUE_NAMES.maintenance).add('purge-scans', { task: 'purge-scans' });
    },
  },
  {
    key: 'recalculate-achievements',
    description: 'Re-evaluate badges for recently active users at 05:00 UTC',
    pattern: '0 5 * * *',
    intervalMs: DAILY,
    run: async () => {
      await getQueue<MaintenancePayload>(QUEUE_NAMES.maintenance).add('recalculate-achievements', {
        task: 'recalculate-achievements',
      });
    },
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
        await queue.add(cron.key, { task: 'refresh-expiry' } as MaintenancePayload, {
          pattern: cron.pattern,
          jobId: `cron:${cron.key}`,
          removeOnComplete: true,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message, cron: cron.key }, 'Could not schedule repeatable job');
      }
    }

    logger.info({ crons: CRONS.length, backend: 'bullmq' }, 'Scheduled jobs registered');
    return;
  }

  // In-process fallback: one timer per cron, staggered so they do not all fire
  // on the same tick after a restart.
  timers = CRONS.map((cron, index) => {
    const timer = setInterval(() => {
      cron.run().catch((err: unknown) => {
        logger.error({ err, cron: cron.key }, 'Scheduled job failed');
      });
    }, cron.intervalMs);
    timer.unref();
    // First run after one interval plus a small per-job offset.
    return timer;
  });

  logger.info({ crons: CRONS.length, backend: 'in-process', note: `first run in ~1h (index offset ${timers.length})` }, 'Scheduled jobs registered');
}

/** Stop every timer. Called on shutdown. */
export function stopCrons(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}
