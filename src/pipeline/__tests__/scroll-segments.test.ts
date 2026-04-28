import { describe, expect, it } from 'vitest';
import { evaluateScrollAt, generateScrollSegments } from '@/pipeline/scroll-segments';

describe('generateScrollSegments', () => {
  it('returns empty for non-positive durations', () => {
    expect(generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 0 })).toEqual([]);
    expect(generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: -1 })).toEqual([]);
  });

  it('generates 1-4 segments with monotonically increasing fractions', () => {
    const segs = generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 30 });
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs.length).toBeLessThanOrEqual(4);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      expect(s.from).toBeGreaterThanOrEqual(0);
      expect(s.to).toBeGreaterThanOrEqual(s.from);
      expect(s.start).toBeLessThanOrEqual(s.end);
      if (i > 0) {
        expect(s.from).toBeCloseTo(segs[i - 1]!.to, 5);
        expect(s.start).toBeGreaterThanOrEqual(segs[i - 1]!.end);
      }
    }
  });

  it('caps the final fraction at the per-seed travelRatio (≤ 0.74)', () => {
    const segs = generateScrollSegments({ screenshotHeight: 8000, viewportHeight: 1080, durationSec: 45 });
    expect(segs.at(-1)!.to).toBeLessThanOrEqual(0.7401);
  });

  it('is deterministic for the same inputs', () => {
    const a = generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 30 });
    const b = generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 30 });
    expect(a).toEqual(b);
  });

  it('different seeds produce different patterns', () => {
    const a = generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 30 });
    const b = generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 60 });
    expect(a).not.toEqual(b);
  });
});

describe('evaluateScrollAt', () => {
  const segs = [
    { start: 1, end: 3, from: 0, to: 0.4 },
    { start: 4, end: 5, from: 0.4, to: 0.6 },
  ];

  it('returns 0 when maxPan is 0', () => {
    expect(evaluateScrollAt(segs, 2, 0)).toBe(0);
  });

  it('returns the from-fraction × maxPan before the first segment', () => {
    expect(evaluateScrollAt(segs, 0.5, 1000)).toBe(0);
  });

  it('eases inside a segment (smoothstep)', () => {
    // Midpoint of segment 0: from=0, to=0.4, p=0.5, eased=0.5 → 0.2 × 1000 = 200.
    expect(evaluateScrollAt(segs, 2, 1000)).toBe(200);
  });

  it('holds the previous segment value during a pause', () => {
    // t=3.5 sits between segment 0 (ends at 3) and segment 1 (starts at 4).
    expect(evaluateScrollAt(segs, 3.5, 1000)).toBe(400);
  });

  it('clamps to the last segment.to after the timeline ends', () => {
    expect(evaluateScrollAt(segs, 6, 1000)).toBe(600);
    expect(evaluateScrollAt(segs, 99, 1000)).toBe(600);
  });

  it('handles the empty-segment case', () => {
    expect(evaluateScrollAt([], 5, 1000)).toBe(0);
  });
});
