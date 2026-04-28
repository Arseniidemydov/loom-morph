import pLimit from 'p-limit';

// Concurrency-capped task pool. Thin wrapper over p-limit so the orchestrator
// has a single point to mock or swap implementations.
//
// Usage:
//   const pool = createPool(6);
//   await pool.run(() => doWork());           // resolves with the task's value
//   pool.activeCount;                          // currently executing
//   pool.pendingCount;                         // queued but not yet started
export interface Pool {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly concurrency: number;
  readonly activeCount: number;
  readonly pendingCount: number;
}

export function createPool(concurrency: number): Pool {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`pool concurrency must be a positive integer, got ${concurrency}`);
  }
  const limit = pLimit(concurrency);
  return {
    run: (task) => limit(task),
    concurrency,
    get activeCount() {
      return limit.activeCount;
    },
    get pendingCount() {
      return limit.pendingCount;
    },
  };
}
