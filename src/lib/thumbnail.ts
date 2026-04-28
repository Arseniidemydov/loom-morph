import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Extract a single still frame from a video for use as a poster / preview
// thumbnail. Lives in src/lib/ rather than src/pipeline/ because this is a
// utility consumed by the API + UI layer, not part of the render filter
// graph (D-006 single-ffmpeg-invocation rule applies to per-lead renders;
// thumbnails are a separate offline operation).
//
// Algorithm:
//   1. Probe the video duration with ffprobe.
//   2. Seek to the midpoint with `-ss` BEFORE `-i` (input-side fast seek;
//      lands on the nearest preceding keyframe — accurate enough for a
//      thumbnail).
//   3. Decode one frame and write a PNG.
//
// Why the middle? Title cards and intro fade-ups at t=0 are common in
// loom-style talking-head videos; the middle frame is far more
// representative of "what does the speaker look like."

export interface ThumbnailOptions {
  /** Absolute path where the PNG should be written. Required. */
  outputPath: string;
  /**
   * Optional max output dimension in pixels. If set, the thumbnail is
   * scaled with `force_original_aspect_ratio=increase` to fully cover a
   * `size × size` square, then center-cropped to `size × size`. This is
   * what the workbench wants for a circular CSS-clipped poster.
   */
  size?: number;
  /** Override binaries; default to whatever's on PATH. */
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface ThumbnailResult {
  outputPath: string;
  /** Reported duration of the source video in seconds. */
  sourceDurationSec: number;
  /** Time within the source the captured frame came from. */
  frameTimeSec: number;
  width: number;
  height: number;
}

export async function extractVideoThumbnail(
  videoPath: string,
  opts: ThumbnailOptions,
): Promise<ThumbnailResult> {
  const ffmpegBin = opts.ffmpegPath ?? 'ffmpeg';
  const ffprobeBin = opts.ffprobePath ?? 'ffprobe';

  await mkdir(path.dirname(opts.outputPath), { recursive: true });
  await assertReadable(videoPath);

  const durationSec = await probeDuration(ffprobeBin, videoPath);
  // Floor to a hundredth of a second; ffmpeg accepts decimal `-ss`.
  const seek = Math.max(0, Math.round((durationSec / 2) * 100) / 100);

  const filterChain = opts.size && opts.size > 0
    ? `scale=${opts.size}:${opts.size}:force_original_aspect_ratio=increase,crop=${opts.size}:${opts.size}`
    : null;

  const args = [
    '-y',
    // -ss before -i: input-side seek. Fast (no decoding from frame 0) and
    // accurate enough — lands on the nearest preceding keyframe.
    '-ss', String(seek),
    '-i', videoPath,
    '-frames:v', '1',
    '-an',
    ...(filterChain ? ['-vf', filterChain] : []),
    // -update 1 silences the "image2 sequence" warning when the output is a
    // single PNG.
    '-update', '1',
    opts.outputPath,
  ];

  await runFfmpeg(ffmpegBin, args);

  const written = await stat(opts.outputPath);
  if (written.size === 0) {
    throw new Error(`thumbnail extraction produced an empty file at ${opts.outputPath}`);
  }

  // Probe the produced PNG to report final dimensions.
  const dims = await probePngDims(ffprobeBin, opts.outputPath);
  return {
    outputPath: opts.outputPath,
    sourceDurationSec: durationSec,
    frameTimeSec: seek,
    width: dims.width,
    height: dims.height,
  };
}

// ────────────────────── internals ──────────────────────

async function assertReadable(p: string): Promise<void> {
  try {
    const s = await stat(p);
    if (!s.isFile()) throw new Error(`${p} is not a regular file`);
  } catch (err) {
    throw new Error(`cannot read video for thumbnail: ${p} (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function probeDuration(ffprobeBin: string, videoPath: string): Promise<number> {
  const out = await runProbe(ffprobeBin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  // ffprobe prints two lines (stream duration + format duration) with this
  // -show_entries combo; the format duration is authoritative.
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines.reverse()) {
    const n = Number.parseFloat(line);
    if (Number.isFinite(n) && n > 0) return n;
  }
  throw new Error(`ffprobe could not determine duration of ${videoPath}; raw output:\n${out}`);
}

async function probePngDims(ffprobeBin: string, pngPath: string): Promise<{ width: number; height: number }> {
  const out = await runProbe(ffprobeBin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
    pngPath,
  ]);
  const m = /^(\d+)x(\d+)/.exec(out.trim());
  if (!m) throw new Error(`ffprobe could not read dimensions of ${pngPath}: ${out}`);
  return { width: Number.parseInt(m[1]!, 10), height: Number.parseInt(m[2]!, 10) };
}

function runProbe(bin: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.split('\n').slice(-10).join('\n')}`));
    });
  });
}
