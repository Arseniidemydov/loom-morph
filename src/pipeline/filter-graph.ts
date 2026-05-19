import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CIRCLE_PIXELS,
  RESOLUTIONS,
  type RenderConfig,
  type RenderJob,
} from '@/types';
import { generateScrollSegments, type ScrollSegment } from './scroll-segments';

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
  const circleCrop = circleCropFilter(C, config);
  const backgroundKind = config.backgroundKind ?? 'image';

  // The background stage differs by source kind:
  //   'image' (default) — looped still PNG; we apply a time-based crop
  //     expression to pan over it (D-001 screenshot-pan strategy). Forced
  //     to 30 fps so the pan motion sample-rates evenly.
  //   'video'           — Playwright recording of the live page. We
  //     deliberately DO NOT add `fps=30` here: Playwright records at ~25
  //     fps, and forcing 30 fps duplicates every 5th frame, which makes
  //     any on-page hero video judder visibly. Passing through the
  //     native rate and matching the output framerate downstream keeps
  //     playback smooth.
  // Optional motion-smoothing pass for video-bg: ffmpeg's minterpolate
  // synthesizes frames between captured ones. `mi_mode=blend` is the
  // cheap path — averages adjacent frames rather than running motion
  // estimation — and adds maybe 30-50% to render time instead of the
  // 5-10× hit of `mi_mode=mci`. Targeting 50fps doubles the perceived
  // frame rate of Playwright's ~25fps capture, which is what makes
  // hero videos read as "stitched screenshots" without this filter.
  const smoothPass =
    backgroundKind === 'video' && config.smoothMotion
      ? `,minterpolate=fps=50:mi_mode=blend`
      : '';

  const bgStage =
    backgroundKind === 'video'
      ? // Lanczos is overkill for an exact-size no-op scale, but Playwright's
        // supersampled capture (renderViewport > recordVideo.size) means the
        // bg WebM almost always arrives at a different resolution than the
        // target — lanczos keeps text and UI edges crisp.
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2,setsar=1${smoothPass}[bg];`
      : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})/2:${buildHumanScrollExpression(SH, H, D)},setsar=1,fps=30[bg];`;

  const lines = [
    bgStage,
    `[1:v]${circleCrop}[c_raw];`,
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

// Headroom applied when the user actively edits crop position or scale, so
// the X AND Y sliders always have pixels to pan over — without it, sources
// whose aspect ratio matches the crop on one axis leave that axis with
// zero room and the slider does nothing. Mirrors PREVIEW_BASE_ZOOM in
// batch-workbench.tsx so the preview and the rendered output stay in sync.
const CROP_BASE_ZOOM = 1.25;

function circleCropFilter(size: number, config: RenderConfig): string {
  const scale = clampNumber(config.circleCropScale ?? 1, 1, 2.5);
  const x = clampNumber(config.circleCropX ?? 0, -100, 100);
  const y = clampNumber(config.circleCropY ?? 0, -100, 100);
  if (scale === 1 && x === 0 && y === 0) {
    return `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`;
  }

  const scaled = Math.round(size * scale * CROP_BASE_ZOOM);
  return [
    `scale=${scaled}:${scaled}:force_original_aspect_ratio=increase`,
    `crop=${size}:${size}:${cropOffsetExpr('iw', size, x)}:${cropOffsetExpr('ih', size, y)}`,
  ].join(',');
}

function cropOffsetExpr(axis: 'iw' | 'ih', size: number, offset: number): string {
  if (offset === 0) return `(${axis}-${size})/2`;
  const frac = formatFrac((offset + 100) / 200);
  return `(${axis}-${size})*${frac}`;
}

function clampNumber(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function formatSeconds(seconds: number): string {
  // Plain decimal seconds — ffmpeg accepts any positive number, e.g. "3.4".
  return (Math.round(seconds * 1000) / 1000).toString();
}

function buildHumanScrollExpression(
  screenshotHeight: number,
  viewportHeight: number,
  durationSec: number,
): string {
  if (durationSec <= 0) return '0';
  const segments = generateScrollSegments({ screenshotHeight, viewportHeight, durationSec });
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function formatFrac(n: number): string {
  // Trim trailing zeros so the filter string stays readable; FFmpeg's
  // expression parser accepts plain decimals.
  return n.toFixed(4).replace(/\.?0+$/, '') || '0';
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
    circleCropScale: job.config.circleCropScale,
    circleCropX: job.config.circleCropX,
    circleCropY: job.config.circleCropY,
    circleHasAudio: job.circleHasAudio,
    audioMp3Present,
    backgroundKind: job.backgroundKind,
    smoothMotion: job.config.smoothMotion,
  };
  const graph = buildFilterGraph(renderConfig);
  const backgroundKind = job.backgroundKind ?? 'image';

  // [0] background. For 'image' (default) we loop the still PNG for D
  // seconds at 30 fps so the time-based crop expression has frames to
  // drive. For 'video' the input is a real recording — no loop, ffmpeg
  // reads frames as-they-come; output is capped to D via the trailing -t.
  // An optional `-ss <offset>` BEFORE `-i` is input-seek (fast, keyframe-
  // snapped) and skips the navigation + settle prefix from a recording so
  // the user never sees a blank/loading page in the final output.
  const startOffset = job.backgroundStartOffsetSec ?? 0;
  const seekArgs =
    backgroundKind === 'video' && startOffset > 0 ? ['-ss', formatSeconds(startOffset)] : [];
  const bgInputArgs =
    backgroundKind === 'video'
      ? [...seekArgs, '-i', job.screenshotPath]
      : ['-loop', '1', '-framerate', '30', '-t', String(D), '-i', job.screenshotPath];

  const args: string[] = [
    '-y',
    ...bgInputArgs,
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
  args.push('-movflags', '+faststart');
  if (backgroundKind === 'video') {
    // Preserve the bg recording's native timestamps end-to-end. Forcing
    // `-r 30` here would re-duplicate the very frames the filter-graph
    // change was meant to avoid, putting the judder right back. The
    // image-bg path is still locked to 30 fps so a still-pan output is
    // perfectly smooth.
    args.push('-fps_mode', 'passthrough');
  } else {
    args.push('-r', '30');
  }
  args.push('-t', String(D), job.outputPath);

  return args;
}
