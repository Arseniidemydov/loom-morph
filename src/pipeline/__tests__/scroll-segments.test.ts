import { describe, expect, it } from 'vitest';
import { evaluateScrollAt, generateScrollSegments } from '@/pipeline/scroll-segments';

describe('generateScrollSegments', () => {
  it('returns empty for non-positive durations', () => {
    expect(generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 0 })).toEqual([]);
    expect(generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: -1 })).toEqual([]);
  });

  it('generates 2-6 segments at 30s, with continuity and at most one rewind', () => {
    const segs = generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 30 });
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.length).toBeLessThanOrEqual(6);
    let rewinds = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      expect(s.from).toBeGreaterThanOrEqual(0);
      expect(s.start).toBeLessThanOrEqual(s.end);
      if (s.to < s.from) rewinds += 1;
      if (i > 0) {
        // Continuity: next segment starts at the previous segment's `to`,
        // even after a rewind (where the next forward segment picks up from
        // the rewound-to position).
        expect(s.from).toBeCloseTo(segs[i - 1]!.to, 5);
        expect(s.start).toBeGreaterThanOrEqual(segs[i - 1]!.end);
      }
    }
    expect(rewinds).toBeLessThanOrEqual(1);
  });

  it('inserts a single rewind segment on long clips', () => {
    const segs = generateScrollSegments({ screenshotHeight: 8000, viewportHeight: 1080, durationSec: 90 });
    const rewinds = segs.filter((s) => s.to < s.from);
    expect(rewinds.length).toBe(1);
    const rewind = rewinds[0]!;
    expect(rewind.from - rewind.to).toBeGreaterThan(0.04);
    expect(rewind.from - rewind.to).toBeLessThan(0.16);
    // Final cumulative travel still reaches the per-seed travelRatio.
    expect(segs.at(-1)!.to).toBeGreaterThanOrEqual(0.7);
  });

  it('skips the rewind on very short clips', () => {
    const segs = generateScrollSegments({ screenshotHeight: 4000, viewportHeight: 1080, durationSec: 6 });
    expect(segs.every((s) => s.to >= s.from)).toBe(true);
  });

  it('scales segment count with duration so 2-min clips stay readable', () => {
    const segs = generateScrollSegments({ screenshotHeight: 8000, viewportHeight: 1080, durationSec: 120 });
    // ~10 base + 0-2 jitter + optional rewind segment.
    expect(segs.length).toBeGreaterThanOrEqual(8);
    expect(segs.length).toBeLessThanOrEqual(15);
    // Every scroll segment finishes well inside the duration.
    expect(segs.at(-1)!.end).toBeLessThanOrEqual(120);
    // Each individual scroll motion stays in the natural 1.5-15s window —
    // never the dragged-out 30s+ scrolls the old fixed-count code produced.
    for (const s of segs) {
      const dur = s.end - s.start;
      expect(dur).toBeGreaterThan(0);
      expect(dur).toBeLessThan(15.001);
    }
  });

  it('caps the final fraction at the per-seed travelRatio (≤ 1.0)', () => {
    const segs = generateScrollSegments({ screenshotHeight: 8000, viewportHeight: 1080, durationSec: 45 });
    expect(segs.at(-1)!.to).toBeGreaterThanOrEqual(0.7);
    expect(segs.at(-1)!.to).toBeLessThanOrEqual(1.0001);
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
