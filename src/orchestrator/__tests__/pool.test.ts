import { describe, expect, it } from 'vitest';
import { createPool } from '@/orchestrator/pool';

describe('createPool', () => {
  it('rejects non-positive concurrency', () => {
    expect(() => createPool(0)).toThrow(RangeError);
    expect(() => createPool(-1)).toThrow(RangeError);
    expect(() => createPool(1.5)).toThrow(RangeError);
  });

  it('caps active tasks at the configured concurrency', async () => {
    const pool = createPool(3);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, () =>
      pool.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('returns the task value', async () => {
    const pool = createPool(2);
    const value = await pool.run(async () => 42);
    expect(value).toBe(42);
  });
});
