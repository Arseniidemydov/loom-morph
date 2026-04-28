import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CIRCLE_PIXELS,
  RESOLUTIONS,
  type RenderConfig,
  type RenderJob,
} from '@/types';

// Builder for the FFmpeg filter graph + full argv (D-006, D-007).
//
// The filter graph is a string composed of four required stages plus one of
// four audio paths (D-015). All numeric values are baked in at build time so
// the graph is fully deterministic — we lean on golden snapshots in tests.
//
// Stage layout, fixed input order:
//   [0:v] = panned screenshot (looped still image, length = duration)
//   [1:v|a] = circle source (image OR video; carries audio iff circleHasAudio)
//   [2:v] = pre-generated alpha mask (looped still PNG)
//   [3:a] = optional MP3 (only present if audioMp3Present)

export interface FilterGraph {
  filterComplex: string;
  videoMap: string;        // e.g. '[v]'
  audioMap?: string;       // e.g. '[a]'; undefined → caller passes -an
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/pipeline/filter-graph.ts → repo root is two directories up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MASK_DIR = path.join(REPO_ROOT, 'public');

export interface BuildOptions {
  // Override mask directory; defaults to <repo>/public.
  maskDir?: string;
}

export function buildFilterGraph(config: RenderConfig): FilterGraph {
  const dims = RESOLUTIONS[config.resolution];
  const W = dims.width;
  const H = dims.height;
  const SH = config.screenshotHeight;
  const D = config.durationSec;
  const C = CIRCLE_PIXELS[config.circleSize];
  const margin = config.circleMargin;
  const { x: X, y: Y } = overlayCoords(config.circlePosition, W, H, C, margin);

  // Pan expression is in fractional units of `(ih-H)` so it works regardless
  // of the input screenshot's width or height — see buildHumanScrollExpression.
  const panY = buildHumanScrollExpression(SH, H, D);

  // Scale the screenshot so it covers the output frame on both axes
  // (`force_original_aspect_ratio=increase` ⇒ both iw≥W and ih≥H, aspect
  // preserved). Then center-crop horizontally — `(iw-W)/2` is 0 in the
  // common case where iw == W (e.g. 1280-wide capture → 1080p ⇒ scaled to
  // 1920-wide ⇒ iw == W). Vertical position is the time-based pan.
  // Without this scale step, a 1280-wide capture rendered to 1920×1080
  // failed because crop=1920:1080 needs iw ≥ 1920 / ih ≥ 1080.
  const lines = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})/2:${panY},setsar=1,fps=30[bg];`,
    `[1:v]scale=${C}:${C}:force_original_aspect_ratio=increase,crop=${C}:${C}[c_raw];`,
    `[c_raw][2:v]alphamerge[circle];`,
    `[bg][circle]overlay=${X}:${Y}:shortest=0[v]`,
  ];

  const audio = audioBranch(config);
  if (audio) lines[lines.length - 1] += ';';
  if (audio) lines.push(audio);

  return {
    filterComplex: lines.join(''),
    videoMap: '[v]',
    audioMap: audio ? '[a]' : undefined,
  };
}

interface ScrollSegment {
  start: number;
  end: number;
  // Fractions of (ih - viewportHeight) at runtime, NOT absolute pixels. The
  // FFmpeg expression multiplies these by `(ih-H)` so the same graph adapts
  // to whatever the post-scale input height turns out to be.
  from: number;
  to: number;
}

function buildHumanScrollExpression(
  screenshotHeight: number,
  viewportHeight: number,
  durationSec: number,
): string {
  if (durationSec <= 0) return '0';

  const seed = hashNumbers(screenshotHeight, viewportHeight, durationSec);
  const stepCount = 2 + (seed % 3); // 2-4 scrolls, never a full robotic sweep.
  const travelRatio = 0.32 + pseudo(seed, 1) * 0.42; // stop around 32-74% down.
  const initialPause = round1(1 + pseudo(seed, 2) * 2);
  const usable = Math.max(1, durationSec - initialPause - 1);
  const scrollTotal = usable * (0.42 + pseudo(seed, 3) * 0.18);
  const pauseTotal = Math.max(0.5, usable - scrollTotal);

  // Build segments in fractional space [0..travelRatio]. At runtime each
  // fraction is multiplied by `(ih-H)`, so a tall page produces a long pan
  // and a near-viewport-sized page produces a tiny pan — both safely.
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

  return nestedScrollExpression(segments, viewportHeight);
}

function nestedScrollExpression(
  segments: ScrollSegment[],
  viewportHeight: number,
): string {
  // FFmpeg expression for current max pan after scaling. ih here is the
  // crop filter's input height — i.e. the screenshot AFTER `scale=W:H:
  // force_original_aspect_ratio=increase`. Always ≥ viewportHeight.
  const maxPan = `(ih-${viewportHeight})`;
  const fracExpr = (frac: number): string => {
    if (frac === 0) return '0';
    return `${maxPan}*${formatFrac(frac)}`;
  };

  let expr = fracExpr(segments.at(-1)?.to ?? 0);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const s = segments[i]!;
    const p = `((t-${s.start})/${Math.max(0.1, round1(s.end - s.start))})`;
    const fromExpr = fracExpr(s.from);
    const deltaExpr = fracExpr(round4(s.to - s.from));
    const eased = `${fromExpr}+(${deltaExpr})*${p}*${p}*(3-2*${p})`;
    expr = `if(lt(t\\,${s.start})\\,${fromExpr}\\,if(lt(t\\,${s.end})\\,${eased}\\,${expr}))`;
  }
  return expr;
}

function clampFraction(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function formatFrac(n: number): string {
  // Trim trailing zeros so the filter string stays readable; FFmpeg's
  // expression parser accepts plain decimals.
  return n.toFixed(4).replace(/\.?0+$/, '') || '0';
}

function hashNumbers(...values: number[]): number {
  let hash = 2166136261;
  for (const value of values) {
    hash ^= Math.round(value * 100);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pseudo(seed: number, salt: number): number {
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

function overlayCoords(
  pos: RenderConfig['circlePosition'],
  W: number,
  H: number,
  C: number,
  margin: number,
): { x: number; y: number } {
  switch (pos) {
    case 'top-left':
      return { x: margin, y: margin };
    case 'top-right':
      return { x: W - C - margin, y: margin };
    case 'bottom-left':
      return { x: margin, y: H - C - margin };
    case 'bottom-right':
      return { x: W - C - margin, y: H - C - margin };
  }
}

function audioBranch(config: RenderConfig): string | null {
  const c = config.circleHasAudio;
  const m = config.audioMp3Present;
  if (c && m) return `[1:a][3:a]amix=inputs=2:duration=first:dropout_transition=0[a]`;
  if (c) return `[1:a]anull[a]`;
  if (m) return `[3:a]anull[a]`;
  return null;
}

// Build the full ffmpeg argv. Pure: same inputs → same args.
//
// Input order matches the filter-graph stream indexes above. Mask path is
// derived from CIRCLE_PIXELS[size] and `opts.maskDir` (default <repo>/public).
export function buildFfmpegArgs(job: RenderJob, opts: BuildOptions = {}): string[] {
  const maskDir = opts.maskDir ?? DEFAULT_MASK_DIR;
  const C = CIRCLE_PIXELS[job.config.circleSize];
  const maskPath = path.join(maskDir, `circle-mask-${C}.png`);
  const D = job.config.durationSec;

  const audioMp3Present = job.audioPath !== undefined;
  const renderConfig: RenderConfig = {
    screenshotHeight: job.screenshotHeight,
    durationSec: job.config.durationSec,
    resolution: job.config.resolution,
    circlePosition: job.config.circlePosition,
    circleSize: job.config.circleSize,
    circleMargin: job.config.circleMargin,
    circleHasAudio: job.circleHasAudio,
    audioMp3Present,
  };
  const graph = buildFilterGraph(renderConfig);

  const args: string[] = [
    '-y',
    // [0] screenshot — still image, loop and cap at D seconds at 30fps so
    // the time-based crop expression has frames to drive.
    '-loop', '1', '-framerate', '30', '-t', String(D), '-i', job.screenshotPath,
    // [1] circle source — could be image or video. The render module decides
    // whether to add `-stream_loop` etc. before this; for v1 we trust the
    // caller and rely on overlay shortest=0 for short circle videos.
    '-i', job.circleSourcePath,
    // [2] mask — looped still PNG.
    '-loop', '1', '-framerate', '30', '-t', String(D), '-i', maskPath,
  ];

  if (audioMp3Present) {
    args.push('-i', job.audioPath as string);
  }

  args.push(
    '-filter_complex', graph.filterComplex,
    '-map', graph.videoMap,
  );
  if (graph.audioMap) {
    args.push('-map', graph.audioMap);
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
  );
  if (graph.audioMap) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }
  args.push(
    '-movflags', '+faststart',
    '-r', '30',
    '-t', String(D),
    job.outputPath,
  );

  return args;
}
