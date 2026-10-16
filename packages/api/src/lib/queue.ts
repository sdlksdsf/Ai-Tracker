import { Queue, Worker, type ConnectionOptions, type Job, type Processor } from 'bullmq';
import { env } from '../config/env.js';
import { getRedisClient } from './redis.js';
import { logger } from './logger.js';

/**
 * Job queue
 * ===========================================================================
 * BullMQ over Redis in production. When Redis is unavailable (fresh clone,
 * `ENABLE_REDIS=false`, CI) we fall back to an **in-process queue** with the
 * same semantics: `add()` returns a job id immediately and the processor runs
 * asynchronously on the event loop. That keeps the async scan API contract
 * (`POST /scan/fridge` → poll `GET /scan/:id/status`) intact everywhere.
 */

export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  data: T;
}

export interface QueueLike<T = unknown> {
  readonly name: string;
  add(jobName: string, data: T, opts?: AddJobOptions): Promise<QueueJob<T>>;
  getJob(id: string): Promise<QueueJob<T> | null>;
  close(): Promise<void>;
  readonly isRedisBacked: boolean;
}

export interface AddJobOptions {
  jobId?: string;
  delayMs?: number;
  attempts?: number;
  backoffMs?: number;
  /** Repeat with a cron expression (schedules). */
  pattern?: string;
  priority?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
}

// ---------------------------------------------------------------------------
// In-process implementation
// ---------------------------------------------------------------------------

interface InProcessJobRecord<T> {
  id: string;
  name: string;
  data: T;
  timer?: NodeJS.Timeout;
  /** Delivery attempts for this job, mirroring BullMQ's per-job `attempts`. */
  attempts?: number;
  /** Fixed delay between attempts, in milliseconds. */
  backoffMs?: number;
}

/** Matches `RedisQueue`'s `defaultJobOptions.attempts` so both back-ends retry alike. */
const DEFAULT_ATTEMPTS = 3;

class InProcessQueue<T> implements QueueLike<T> {
  readonly isRedisBacked = false;
  private readonly jobs = new Map<string, InProcessJobRecord<T>>();
  private processor: Processor<T> | null = null;
  private running = 0;
  private readonly maxConcurrency: number;
  private counter = 0;

  constructor(readonly name: string, maxConcurrency = 2) {
    this.maxConcurrency = maxConcurrency;
  }

  setProcessor(processor: Processor<T>): void {
    this.processor = processor;
  }

  async add(jobName: string, data: T, opts: AddJobOptions = {}): Promise<QueueJob<T>> {
    this.counter += 1;
    const id = opts.jobId ?? `${this.name}:${Date.now()}:${this.counter}`;
    const record: InProcessJobRecord<T> = { id, name: jobName, data, attempts: opts.attempts, backoffMs: opts.backoffMs };
    this.jobs.set(id, record);

    const run = () => {
      void this.execute(record);
    };

    if (opts.delayMs && opts.delayMs > 0) {
      record.timer = setTimeout(run, opts.delayMs);
      // Do not keep the event loop alive just for a scheduled job.
      record.timer.unref?.();
    } else {
      setImmediate(run);
    }

    return { id, name: jobName, data };
  }

  private async execute(record: InProcessJobRecord<T>): Promise<void> {
    if (!this.processor) {
      // Drop the record: leaving it behind made `getJob()` report a job that
      // nothing would ever run, and the map grew for the life of the process.
      this.jobs.delete(record.id);
      logger.warn({ queue: this.name, job: record.id }, 'In-process queue has no registered processor');
      return;
    }
    if (this.running >= this.maxConcurrency) {
      // Back-pressure: retry shortly.
      setTimeout(() => void this.execute(record), 250).unref?.();
      return;
    }
    this.running += 1;
    const started = Date.now();
    // Honour the caller's retry policy. This was hard-coded to two attempts,
    // so `attempts`/`backoffMs` on `add()` were silently ignored whenever the
    // queue ran in-process (dev, CI, a Redis-less deployment) and a scan that
    // failed once was retried once instead of twice.
    const attempts = Math.max(1, record.attempts ?? DEFAULT_ATTEMPTS);
    const backoffMs = Math.max(0, record.backoffMs ?? 0);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const fakeJob = {
          id: record.id,
          name: record.name,
          data: record.data,
          attemptsMade: attempt - 1,
          log: () => Promise.resolve(),
        } as unknown as Job<T>;
        await this.processor(fakeJob);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        logger.warn(
          { queue: this.name, job: record.id, attempt, err: (err as Error).message },
          'In-process job failed',
        );
        if (attempt < attempts) await sleep(backoffMs > 0 ? backoffMs : 500 * attempt);
      }
    }

    this.running -= 1;
    this.jobs.delete(record.id);

    if (lastError) {
      logger.error({ queue: this.name, job: record.id, err: lastError }, 'In-process job exhausted retries');
    } else {
      logger.debug({ queue: this.name, job: record.id, ms: Date.now() - started }, 'In-process job done');
    }
  }

  async getJob(id: string): Promise<QueueJob<T> | null> {
    const record = this.jobs.get(id);
    return record ? { id: record.id, name: record.name, data: record.data } : null;
  }

  async close(): Promise<void> {
    for (const record of this.jobs.values()) if (record.timer) clearTimeout(record.timer);
    this.jobs.clear();
  }
}

// ---------------------------------------------------------------------------
// BullMQ implementation
// ---------------------------------------------------------------------------

/**
 * BullMQ forbids `:` in queue names (it is its own key separator) and namespaces
 * every key with `prefix` instead. Queue names used to be `platematch:scan`,
 * which made `new Queue()` throw "Queue name cannot contain :" — so with Redis
 * enabled the API crashed at boot, or failed every scan upload with a 500.
 */
export function toBullQueueName(name: string): string {
  return name.replace(/:/g, '-');
}

class RedisQueue<T> implements QueueLike<T> {
  readonly isRedisBacked = true;
  readonly queue: Queue<T>;

  constructor(readonly name: string, private readonly connection: ConnectionOptions) {
    this.queue = new Queue<T>(toBullQueueName(name), {
      connection,
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async add(jobName: string, data: T, opts: AddJobOptions = {}): Promise<QueueJob<T>> {
    const job = await this.queue.add(jobName as never, data as never, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: opts.attempts ?? 3,
      priority: opts.priority,
      backoff: opts.backoffMs ? { type: 'fixed', delay: opts.backoffMs } : undefined,
      removeOnComplete: opts.removeOnComplete === false ? false : undefined,
      removeOnFail: opts.removeOnFail === false ? false : undefined,
      ...(opts.pattern
        ? { repeat: { pattern: opts.pattern } }
        : {}),
    });
    return { id: String(job.id ?? ''), name: jobName, data };
  }

  async getJob(id: string): Promise<QueueJob<T> | null> {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    return { id: String(job.id), name: job.name, data: job.data };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Queue names. Redis keys are namespaced by BullMQ's `prefix` (QUEUE_PREFIX), so
 * these end up as `platematch:scan:*` — the names themselves must not contain `:`.
 */
export const QUEUE_NAMES = {
  scan: 'scan',
  recipe: 'recipe',
  mealplan: 'mealplan',
  nutrition: 'nutrition',
  prices: 'prices',
  notifications: 'notifications',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const registry = new Map<string, QueueLike<never>>();

/**
 * Which back-end queues use — see QUEUE_DRIVER in config/env.ts.
 * `memory` keeps jobs in-process even when Redis serves the cache and limits.
 */
export function queueDriver(): 'redis' | 'memory' {
  if (env.QUEUE_DRIVER === 'memory' || !env.ENABLE_REDIS) return 'memory';
  return getRedisClient() ? 'redis' : 'memory';
}

/** Get (or create) a queue. Falls back to in-process when Redis is down. */
export function getQueue<T = unknown>(name: QueueName | string): QueueLike<T> {
  const existing = registry.get(name);
  if (existing) return existing as unknown as QueueLike<T>;

  const connection = queueDriver() === 'redis' ? getRedisClient() : null;

  let queue: QueueLike<T>;
  if (connection) {
    queue = new RedisQueue<T>(name, connection as ConnectionOptions);
    logger.info({ queue: name }, 'Queue registered (BullMQ/Redis)');
  } else {
    queue = new InProcessQueue<T>(name, name === QUEUE_NAMES.scan ? 3 : 2);
    logger.info({ queue: name }, 'Queue registered (in-process fallback)');
  }

  registry.set(name, queue as unknown as QueueLike<never>);
  return queue;
}

export function isRedisBacked(): boolean {
  return queueDriver() === 'redis';
}

/** Attach a BullMQ worker (no-op for in-process queues, which self-execute). */
export function attachWorker<T>(name: QueueName | string, processor: Processor<T>, concurrency = 2): Worker<T> | null {
  const queue = getQueue<T>(name);

  if (queue instanceof InProcessQueue) {
    queue.setProcessor(processor);
    return null;
  }

  const connection = getRedisClient();
  if (!connection) return null;

  const worker = new Worker<T>(toBullQueueName(name), processor, {
    connection: connection as ConnectionOptions,
    // Must match the Queue's prefix or the worker listens on different keys.
    prefix: env.QUEUE_PREFIX,
    concurrency,
    // How long an idle worker blocks before polling again. BullMQ's default (5s)
    // made five idle workers send ~490 Redis commands a minute (measured) —
    // ~21M a month, against Upstash's 500K free tier. A new job still wakes a
    // blocked worker immediately (BullMQ adds a marker on enqueue), and queues
    // with delayed/repeatable jobs wake on their own timer, so a longer block
    // only removes idle polling. Single instance? Prefer QUEUE_DRIVER=memory.
    drainDelay: 30,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });

  worker.on('failed', (job, err) => {
    logger.error({ queue: name, jobId: job?.id, err: err.message }, 'Job failed');
  });
  worker.on('completed', (job) => {
    logger.debug({ queue: name, jobId: job.id }, 'Job completed');
  });
  worker.on('error', (err) => {
    logger.error({ queue: name, err: err.message }, 'Worker error');
  });

  return worker;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...registry.values()].map((q) => q.close().catch(() => undefined)));
  registry.clear();
}

export type { Queue, Worker, Job };
