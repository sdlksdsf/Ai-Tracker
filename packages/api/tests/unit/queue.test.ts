import { afterEach, describe, expect, it } from 'vitest';
import { attachWorker, closeQueues, getQueue, isRedisBacked } from '../../src/lib/queue.js';

/**
 * In-process queue semantics.
 *
 * This is the back-end every developer and CI run uses (no Redis), and it is
 * also what a Redis-less deployment gets. It has to behave like BullMQ where
 * the API contract depends on it: jobs run asynchronously, a job disappears
 * once it settles, delays are delays — and the `attempts`/`backoffMs` a caller
 * passes are the retry policy that actually applies, instead of a hard-coded
 * number inside the queue.
 */

// With Redis configured `getQueue()` builds a real BullMQ queue, which needs a
// server this suite does not have.
const inProcessOnly = isRedisBacked() ? describe.skip : describe;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let queueCounter = 0;
const freshQueueName = (): string => `platematch:unit-queue-${(queueCounter += 1)}`;

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

inProcessOnly('in-process queue', () => {
  afterEach(async () => {
    await closeQueues();
  });

  it('is the fallback back-end when Redis is off', () => {
    const queue = getQueue(freshQueueName());
    expect(queue.isRedisBacked).toBe(false);
  });

  it('runs a processor asynchronously and forgets the job once it resolves', async () => {
    const queue = getQueue<{ value: number }>(freshQueueName());
    let seen: { value: number } | null = null;

    attachWorker<{ value: number }>(queue.name, async (job) => {
      seen = job.data;
    });

    const job = await queue.add('scan', { value: 42 });
    expect(seen).toBeNull(); // never inline — the API returns before work starts

    await waitFor(() => seen !== null);
    expect(seen).toEqual({ value: 42 });

    // The record is dropped after the run, so polling a settled job id reports
    // "gone" instead of a job that looks queued forever.
    await sleep(10);
    expect(await queue.getJob(job.id)).toBeNull();
  });

  it('retries a failing job the number of times the caller asked for', async () => {
    const queue = getQueue<Record<string, never>>(freshQueueName());
    let calls = 0;
    let notify: (() => void) | null = null;
    const succeeded = new Promise<void>((resolve) => {
      notify = resolve;
    });

    attachWorker(queue.name, async () => {
      calls += 1;
      if (calls < 3) throw new Error('scan provider timed out');
      notify?.();
    });

    await queue.add('scan', {}, { attempts: 3, backoffMs: 1 });
    await succeeded;
    expect(calls).toBe(3);
  });

  it('does not retry when the caller asks for a single attempt', async () => {
    const queue = getQueue<Record<string, never>>(freshQueueName());
    let calls = 0;

    attachWorker(queue.name, async () => {
      calls += 1;
      throw new Error('permanent');
    });

    await queue.add('scan', {}, { attempts: 1 });
    await waitFor(() => calls === 1);
    await sleep(40);

    expect(calls).toBe(1);
  });

  it('defaults to three attempts, matching the BullMQ defaults', async () => {
    const queue = getQueue<Record<string, never>>(freshQueueName());
    let calls = 0;

    attachWorker(queue.name, async () => {
      calls += 1;
      throw new Error('still failing');
    });

    await queue.add('scan', {}, { backoffMs: 1 });
    await waitFor(() => calls === 3);
    await sleep(40);

    expect(calls).toBe(3);
  });

  it('runs a delayed job only after the delay', async () => {
    const queue = getQueue<Record<string, never>>(freshQueueName());
    let called = false;

    attachWorker(queue.name, async () => {
      called = true;
    });

    await queue.add('sweep', {}, { delayMs: 60 });
    expect(called).toBe(false);

    await waitFor(() => called);
  });

  it('drops a job instead of crashing when no processor is attached', async () => {
    const queue = getQueue<Record<string, never>>(freshQueueName());

    // No `attachWorker` call: the job is discarded and the process stays up.
    const job = await queue.add('orphan', {});
    expect(job.id).toBeTruthy();

    await sleep(20);
    expect(await queue.getJob(job.id)).toBeNull();
  });

  it('cancels pending delayed work on close', async () => {
    const queue = getQueue<Record<string, never>>(freshQueueName());
    let called = false;

    attachWorker(queue.name, async () => {
      called = true;
    });

    await queue.add('sweep', {}, { delayMs: 80 });
    await queue.close();
    await sleep(120);

    expect(called).toBe(false);
  });
});
