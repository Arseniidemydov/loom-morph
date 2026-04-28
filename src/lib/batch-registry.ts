import type { BatchEvent } from '@/types';
import type { BatchSummary, RunningBatch } from './engine';

type BatchListener = (event: BatchEvent) => void;

export interface RegisteredBatch {
  batchId: string;
  events: BatchEvent[];
  summary?: BatchSummary;
  error?: string;
  completed: boolean;
  subscribe(listener: BatchListener): () => void;
}

interface RegisteredBatchInternal extends RegisteredBatch {
  listeners: Set<BatchListener>;
}

const GLOBAL_KEY = '__loomMorphBatches';

const globalStore = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, RegisteredBatchInternal>;
};

const batches = globalStore[GLOBAL_KEY] ?? new Map<string, RegisteredBatchInternal>();
globalStore[GLOBAL_KEY] = batches;

export function registerRunningBatch(running: RunningBatch): RegisteredBatch {
  const existing = batches.get(running.batchId);
  if (existing) return existing;

  const entry: RegisteredBatchInternal = {
    batchId: running.batchId,
    events: [],
    completed: false,
    listeners: new Set(),
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };
  batches.set(running.batchId, entry);

  void consumeBatch(running, entry);
  return entry;
}

export function getRegisteredBatch(batchId: string): RegisteredBatch | undefined {
  return batches.get(batchId);
}

async function consumeBatch(
  running: RunningBatch,
  entry: RegisteredBatchInternal,
): Promise<void> {
  try {
    for await (const event of running.events) {
      if (event.type === 'batch-completed') {
        entry.summary = await running.completion;
      }
      entry.events.push(event);
      for (const listener of entry.listeners) listener(event);
    }
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
  } finally {
    entry.completed = true;
  }
}
