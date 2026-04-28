import { describe, expect, it } from 'vitest';
import { createEventChannel } from '@/orchestrator/events';

describe('EventChannel', () => {
  it('delivers events in emit order', async () => {
    const ch = createEventChannel<number>();
    ch.emit(1);
    ch.emit(2);
    ch.emit(3);
    ch.close();

    const out: number[] = [];
    for await (const v of ch) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it('resolves a pending consumer when an event is emitted later', async () => {
    const ch = createEventChannel<string>();
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of ch) collected.push(v);
    })();

    // Let the consumer park on next().
    await new Promise((r) => setTimeout(r, 5));
    ch.emit('a');
    ch.emit('b');
    ch.close();

    await consumer;
    expect(collected).toEqual(['a', 'b']);
  });

  it('throws on emit-after-close', () => {
    const ch = createEventChannel<number>();
    ch.close();
    expect(() => ch.emit(1)).toThrow(/closed/);
  });

  it('close() unblocks pending consumer with done', async () => {
    const ch = createEventChannel<number>();
    const consumer = (async () => {
      const out: number[] = [];
      for await (const v of ch) out.push(v);
      return out;
    })();
    await new Promise((r) => setTimeout(r, 5));
    ch.close();
    expect(await consumer).toEqual([]);
  });
});
