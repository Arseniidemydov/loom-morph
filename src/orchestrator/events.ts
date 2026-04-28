import type { BatchEvent } from '@/types';

// Async event channel for the orchestrator → consumer (CLI / SSE / tests).
//
// Producer calls `emit(event)` from inside the orchestration loop. Consumer
// iterates with `for await (const ev of channel)`. Order of delivery is the
// order of `emit` calls; backpressure is the queue itself (events buffer in
// memory until consumed). For v1 batch sizes (100 leads × a few events) this
// is fine and avoids the complexity of a typed EventEmitter.
//
// `close()` ends the iteration after the queue drains.
export interface EventChannel<T> extends AsyncIterable<T> {
  emit(event: T): void;
  close(): void;
}

export function createEventChannel<T>(): EventChannel<T> {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const next = (): Promise<IteratorResult<T>> => {
    if (queue.length > 0) {
      const value = queue.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
  };

  return {
    emit(event) {
      if (closed) {
        throw new Error('emit() on a closed event channel');
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter({ value: undefined as never, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return { next };
    },
  };
}

// Re-export the union for ergonomic imports inside the orchestrator package.
export type { BatchEvent };
