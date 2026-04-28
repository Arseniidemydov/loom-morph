import { describe, expect, it } from 'vitest';
import { getRegisteredBatch, registerRunningBatch } from '@/lib/batch-registry';
import type { BatchEvent } from '@/types';
import type { BatchSummary, RunningBatch } from '@/lib/engine';
import type { PathHelpers } from '@/lib/storage';

// The registry is a thin in-memory pub/sub layer between the engine's
// single-iterator event stream and one-or-more SSE consumers. These tests
// drive it with synthetic RunningBatch objects so we don't need real
// Playwright/ffmpeg.

interface PushableSource {
  events: AsyncIterable<BatchEvent>;
  push(event: BatchEvent): void;
  finish(): void;
  fail(err: Error): void;
}

interface Waiter {
  resolve(r: IteratorResult<BatchEvent>): void;
  reject(err: Error): void;
}

// Build a manually-driven async iterable so the test controls when events
// arrive — same shape the engine produces, but synthetic.
function makePushableSource(): PushableSource {
  const queue: BatchEvent[] = [];
  const waiters: Waiter[] = [];
  let closed = false;
  let error: Error | undefined;

  const events: AsyncIterable<BatchEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<BatchEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (error) return Promise.reject(error);
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<BatchEvent>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };

  return {
    events,
    push(event) {
      const w = waiters.shift();
      if (w) w.resolve({ value: event, done: false });
      else queue.push(event);
    },
    finish() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as never, done: true });
      }
    },
    fail(err) {
      error = err;
      while (waiters.length > 0) waiters.shift()!.reject(err);
    },
  };
}

function makeRunningBatch(batchId: string, source: PushableSource, summary: BatchSummary): RunningBatch {
  // Minimal stub — the registry only uses .batchId, .events, .completion.
  return {
    batchId,
    paths: { /* unused by registry */ } as unknown as PathHelpers,
    events: source.events,
    completion: Promise.resolve(summary),
  };
}

const dummySummary = (id: string): BatchSummary => ({
  batchId: id,
  total: 1,
  done: 1,
  failed: 0,
  reportPath: `/tmp/${id}/report.csv`,
});

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('batch-registry', () => {
  it('buffers events for a late subscriber to replay', async () => {
    const id = 'late-1';
    const src = makePushableSource();
    const entry = registerRunningBatch(makeRunningBatch(id, src, dummySummary(id)));

    src.push({ type: 'batch-started', batchId: id, total: 1 });
    src.push({ type: 'lead-status', leadId: 'L1', status: 'capturing' });
    await tick(); // give consumeBatch a tick to drain
    expect(entry.events.length).toBe(2);

    // A subscriber connecting late sees the buffered events via `entry.events`.
    expect(entry.events[0]).toMatchObject({ type: 'batch-started' });
    expect(entry.events[1]).toMatchObject({ type: 'lead-status' });

    src.push({ type: 'batch-completed', batchId: id, summary: { done: 1, failed: 0, totalMs: 10 } });
    src.finish();
    await tick();
    expect(entry.completed).toBe(true);
    expect(entry.summary).toMatchObject({ batchId: id, done: 1, failed: 0 });
  });

  it('fans out live events to all subscribers in emit order', async () => {
    const id = 'fanout-1';
    const src = makePushableSource();
    const entry = registerRunningBatch(makeRunningBatch(id, src, dummySummary(id)));

    const a: BatchEvent[] = [];
    const b: BatchEvent[] = [];
    const unsubA = entry.subscribe((ev) => a.push(ev));
    const unsubB = entry.subscribe((ev) => b.push(ev));

    src.push({ type: 'batch-started', batchId: id, total: 2 });
    src.push({ type: 'lead-status', leadId: 'L1', status: 'capturing' });
    await tick();

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a.map((e) => e.type)).toEqual(['batch-started', 'lead-status']);
    expect(b).toEqual(a);

    unsubA();
    src.push({ type: 'lead-status', leadId: 'L1', status: 'rendering' });
    await tick();
    expect(a).toHaveLength(2); // didn't receive after unsubscribe
    expect(b).toHaveLength(3);

    unsubB();
    src.finish();
  });

  it('returns the existing entry on duplicate registerRunningBatch (idempotent)', () => {
    const id = 'dup-1';
    const src = makePushableSource();
    const first = registerRunningBatch(makeRunningBatch(id, src, dummySummary(id)));
    const second = registerRunningBatch(makeRunningBatch(id, makePushableSource(), dummySummary(id)));
    expect(second).toBe(first); // same object — second registration is a no-op
    src.finish();
  });

  it('getRegisteredBatch returns undefined for an unknown id', () => {
    expect(getRegisteredBatch('does-not-exist')).toBeUndefined();
  });

  it('captures a thrown error from the source iterator into entry.error', async () => {
    const id = 'err-1';
    const src = makePushableSource();
    const entry = registerRunningBatch(makeRunningBatch(id, src, dummySummary(id)));

    src.fail(new Error('boom'));
    await tick();
    expect(entry.completed).toBe(true);
    expect(entry.error).toBe('boom');
  });
});
