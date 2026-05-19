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
  // Scale step count with duration so each scroll-pause cycle stays in the
  // ~7-12s range that feels like a real reader. Short clips (≤30s) keep the
  // original 2-4 segments; a 2-min clip gets ~10-14 segments instead of
  // dragging each scroll out to 30s.
  const baseSteps = Math.max(2, Math.round(durationSec / 12));
  const stepCount = baseSteps + (seed % 3);
  const travelRatio = 0.7 + pseudo(seed, 1) * 0.3; // travel 70-100% of the page.
  const initialPause = round1(1 + pseudo(seed, 2) * 2);
  const usable = Math.max(1, durationSec - initialPause - 1);
  const scrollTotal = usable * (0.42 + pseudo(seed, 3) * 0.18);
  const pauseTotal = Math.max(0.5, usable - scrollTotal);

  const segments: ScrollSegment[] = [];
  // Per-step targets divide by stepCount (not remaining): otherwise later
  // cycles balloon as remaining shrinks, which on long durations bunches all
  // the motion near the end and the time budget cuts the loop off before it
  // finishes the planned travelRatio.
  const baseScrollDur = scrollTotal / stepCount;
  const basePauseDur = pauseTotal / stepCount;
  const baseTravelFrac = travelRatio / stepCount;
  let t = initialPause;
  let yFrac = 0;
  for (let i = 0; i < stepCount; i += 1) {
    const scrollWeight = 0.75 + pseudo(seed, 10 + i) * 0.7;
    const scrollDur = round1(baseScrollDur * scrollWeight);
    const tentativeEnd = Math.min(durationSec, t + scrollDur);
    const tentativePauseDur = round1(basePauseDur * (0.7 + pseudo(seed, 20 + i) * 0.9));
    // Last segment is whichever finishes the planned step count OR runs out
    // of duration first. It always travels to travelRatio so the page never
    // ends half-scrolled.
    const isLast =
      i === stepCount - 1 ||
      tentativeEnd + tentativePauseDur >= durationSec - 0.5;
    const pauseDur = isLast ? 0 : tentativePauseDur;
    const remainingTravelFrac = travelRatio - yFrac;
    const stepFrac = isLast
      ? remainingTravelFrac
      : Math.max(0.001, baseTravelFrac * (0.75 + pseudo(seed, 30 + i) * 0.85));
    const nextYFrac = clampFraction(yFrac + stepFrac, 0, travelRatio);
    segments.push({
      start: round1(t),
      end: round1(tentativeEnd),
      from: round4(yFrac),
      to: round4(nextYFrac),
    });
    yFrac = nextYFrac;
    t = Math.min(durationSec, tentativeEnd + pauseDur);
    if (isLast) break;
  }

  return injectRewind(segments, seed, durationSec);
}

// Insert a single "scroll back up" segment near the middle of the timeline
// so the recording reads like a real human re-scanning a section, not a
// monotonic top-to-bottom pan. Picks a pause window between two existing
// forward segments, eats part of that pause for the rewind motion, and
// shifts the next forward segment's `from` to the rewind's `to` — so the
// cumulative travel still terminates at travelRatio without skipping
// content (the next segment just covers more ground in the same time).
//
// Skipped on short clips or when there's nowhere natural to insert.
function injectRewind(
  segments: ScrollSegment[],
  seed: number,
  durationSec: number,
): ScrollSegment[] {
  if (segments.length < 3) return segments;
  if (durationSec < 12) return segments;

  // Choose an insertion point biased to the 35-65% range of the timeline so
  // the rewind feels mid-recording rather than tacked on either end.
  const idx = Math.max(
    1,
    Math.min(
      segments.length - 2,
      Math.floor(segments.length * (0.35 + pseudo(seed, 50) * 0.3)),
    ),
  );
  const before = segments[idx]!;
  const after = segments[idx + 1]!;
  const pauseWindow = after.start - before.end;
  if (pauseWindow < 1.6) return segments;

  // The rewind is short and snappy: 0.7-1.4s of motion, leaving the
  // surrounding pause as before-pause + after-pause around it.
  const rewindDur = round1(0.7 + pseudo(seed, 51) * 0.7);
  const beforePause = round1((pauseWindow - rewindDur) * (0.35 + pseudo(seed, 52) * 0.3));
  const rewindStart = round1(before.end + beforePause);
  const rewindEnd = round1(rewindStart + rewindDur);

  // Pull back 5-15% of the page; clamp so we never go negative.
  const rewindAmount = 0.05 + pseudo(seed, 53) * 0.1;
  const rewindTo = round4(Math.max(0, before.to - rewindAmount));
  if (rewindTo >= before.to - 0.001) return segments; // nothing meaningful to rewind to

  const rewindSeg: ScrollSegment = {
    start: rewindStart,
    end: rewindEnd,
    from: round4(before.to),
    to: rewindTo,
  };
  // Continuity: the next forward segment now picks up from the lower
  // position. Its `to` is unchanged, so it covers slightly more travel in
  // the same time slot — a natural "catching back up" feel.
  const updatedAfter: ScrollSegment = { ...after, from: rewindTo };
  return [
    ...segments.slice(0, idx + 1),
    rewindSeg,
    updatedAfter,
    ...segments.slice(idx + 2),
  ];
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
