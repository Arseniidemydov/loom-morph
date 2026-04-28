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

  // Smoothstep ease: (t/D)^2 * (3 - 2*(t/D)). Pan distance = SH - H.
  // Pre-multiply so the expression is short and self-contained.
  // FFmpeg's expression parser treats single quotes as literal grouping in
  // arg parsing, but inside the filter graph string they are not special —
  // commas would be, but our crop expression has no commas (wrapping
  // arithmetic in parentheses keeps it within the single arg).
  const panY = `(${SH}-${H})*(t/${D})*(t/${D})*(3-2*(t/${D}))`;

  const lines = [
    `[0:v]crop=${W}:${H}:0:${panY},scale=${W}:${H},setsar=1,fps=30[bg];`,
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
