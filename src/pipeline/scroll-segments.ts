// Human-ish scroll segment generator. Shared between two consumers:
//
//   - src/pipeline/filter-graph.ts → emits an FFmpeg `crop=...:...:0:Y(t)`
//     expression that pans a static screenshot.
//   - src/pipeline/record.ts → drives `window.scrollTo(0, y)` inside a
//     Playwright page so a recorded video has the same segmented motion
//     as the screenshot-pan path.
//
// Segments are expressed as FRACTIONS in [0..travelRatio] of the maximum
// pan distance (`ih - H` in FFmpeg, `pageScrollHeight - viewportHeight`
// in the browser). The consumer multiplies by the actual maxPan at
// runtime — keeps the generator size-independent.
//
// Determinism: the seed is hashed from (screenshotHeight, viewportHeight,
// durationSec). Same inputs → same segments. Different page heights or
// durations produce different patterns so two videos don't feel like
// copy-paste.

export interface ScrollSegment {
  /** Wall-clock start of the scroll motion, seconds. */
  start: number;
  /** Wall-clock end of the scroll motion, seconds. */
  end: number;
  /** Fraction of maxPan to start from. Range [0..travelRatio]. */
  from: number;
  /** Fraction of maxPan to end at. Range [0..travelRatio]. */
  to: number;
}

export interface ScrollSegmentInputs {
  /** Original screenshot / page height in pixels. Used for seeding only. */
  screenshotHeight: number;
  /** Viewport height (the height of the visible window during pan). */
  viewportHeight: number;
  /** Total duration of the panning motion. */
  durationSec: number;
}

export function generateScrollSegments(input: ScrollSegmentInputs): ScrollSegment[] {
  const { screenshotHeight, viewportHeight, durationSec } = input;
  if (durationSec <= 0) return [];

  const seed = hashNumbers(screenshotHeight, viewportHeight, durationSec);
  const stepCount = 2 + (seed % 3); // 2-4 scrolls, never a robotic full sweep.
  const travelRatio = 0.32 + pseudo(seed, 1) * 0.42; // stop around 32-74% down.
  const initialPause = round1(1 + pseudo(seed, 2) * 2);
  const usable = Math.max(1, durationSec - initialPause - 1);
  const scrollTotal = usable * (0.42 + pseudo(seed, 3) * 0.18);
  const pauseTotal = Math.max(0.5, usable - scrollTotal);

  const segments: ScrollSegment[] = [];
  let t = initialPause;
  let yFrac = 0;
  for (let i = 0; i < stepCount; i += 1) {
    const remaining = stepCount - i;
    const scrollWeight = 0.75 + pseudo(seed, 10 + i) * 0.7;
    const scrollDur = round1((scrollTotal / remaining) * scrollWeight);
    const pauseDur = round1(
      i === stepCount - 1 ? 0 : (pauseTotal / remaining) * (0.7 + pseudo(seed, 20 + i) * 0.9),
    );
    const remainingTravelFrac = travelRatio - yFrac;
    const stepFrac =
      i === stepCount - 1
        ? remainingTravelFrac
        : Math.max(
            0.001,
            (remainingTravelFrac / remaining) * (0.75 + pseudo(seed, 30 + i) * 0.85),
          );
    const nextYFrac = clampFraction(yFrac + stepFrac, 0, travelRatio);
    const end = Math.min(durationSec, t + scrollDur);
    segments.push({
      start: round1(t),
      end: round1(end),
      from: round4(yFrac),
      to: round4(nextYFrac),
    });
    yFrac = nextYFrac;
    t = Math.min(durationSec, end + pauseDur);
    if (t >= durationSec - 0.5) break;
  }

  return segments;
}

// Smoothstep easing applied per-segment; clamp output to last segment's
// `to` outside [start, end]. Useful for the in-page scroll driver — given
// `t` and the page's `maxPan`, returns the absolute scroll position.
export function evaluateScrollAt(segments: ScrollSegment[], t: number, maxPan: number): number {
  if (segments.length === 0) return 0;
  if (maxPan <= 0) return 0;
  if (t <= segments[0]!.start) return Math.round(segments[0]!.from * maxPan);
  for (const s of segments) {
    if (t < s.start) {
      // Hold previous segment's `to` (or `from` of this one if no prev).
      return Math.round(s.from * maxPan);
    }
    if (t < s.end) {
      const p = (t - s.start) / Math.max(0.0001, s.end - s.start);
      const eased = p * p * (3 - 2 * p);
      return Math.round((s.from + (s.to - s.from) * eased) * maxPan);
    }
  }
  return Math.round(segments.at(-1)!.to * maxPan);
}

// ────────────────────── helpers (private) ──────────────────────

export function hashNumbers(...values: number[]): number {
  let hash = 2166136261;
  for (const value of values) {
    hash ^= Math.round(value * 100);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pseudo(seed: number, salt: number): number {
  let x = seed + Math.imul(salt + 1, 0x9e3779b9);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 0xffffffff;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clampFraction(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
