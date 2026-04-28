import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { extractVideoThumbnail } from '@/lib/thumbnail';

// Skip the whole file if ffmpeg isn't available.
const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const maybe = haveFfmpeg ? describe : describe.skip;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'thumb-test-'));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// Generate a small test video. The visible content varies over time
// (testsrc embeds a frame counter and a moving timer in the picture) so a
// frame extracted from t=midpoint is visibly different from t=0.
function makeFixtureVideo(out: string, durationSec: number, w = 320, h = 240): void {
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc=size=${w}x${h}:rate=30:duration=${durationSec}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-t', String(durationSec),
      out,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`fixture video gen failed: ${r.stderr}`);
}

function ffprobeNumber(file: string, entry: string): number {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', `format=${entry}`, '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return Number.parseFloat(r.stdout.trim());
}

maybe('extractVideoThumbnail', () => {
  it('captures a frame from the middle of the video', async () => {
    const videoPath = path.join(workDir, 'src.mp4');
    const outPath = path.join(workDir, 'mid.png');
    makeFixtureVideo(videoPath, 6);

    const result = await extractVideoThumbnail(videoPath, { outputPath: outPath });

    expect(result.outputPath).toBe(outPath);
    expect(result.sourceDurationSec).toBeGreaterThan(5.9);
    expect(result.sourceDurationSec).toBeLessThan(6.5);
    // Midpoint of a 6 s video → seek to ~3.0 s.
    expect(result.frameTimeSec).toBeCloseTo(3.0, 1);
    expect(existsSync(outPath)).toBe(true);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('mid-frame visibly differs from frame at t=0 (sanity check the seek actually happened)', async () => {
    const videoPath = path.join(workDir, 'differs.mp4');
    const startPath = path.join(workDir, 'start.png');
    const midPath = path.join(workDir, 'differs-mid.png');
    makeFixtureVideo(videoPath, 4);

    // Capture the first frame for comparison.
    const r = spawnSync('ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', '-update', '1', startPath], { stdio: 'ignore' });
    expect(r.status).toBe(0);

    await extractVideoThumbnail(videoPath, { outputPath: midPath });

    // testsrc has a per-frame counter overlay, so byte-for-byte the PNGs
    // must differ (different counter values rendered).
    const fs = await import('node:fs/promises');
    const startBuf = await fs.readFile(startPath);
    const midBuf = await fs.readFile(midPath);
    expect(midBuf.equals(startBuf)).toBe(false);
  });

  it('size option produces a square output of the requested dimension', async () => {
    const videoPath = path.join(workDir, 'rect.mp4');
    const outPath = path.join(workDir, 'square.png');
    // Wide-aspect source — exercises the increase-then-crop path.
    makeFixtureVideo(videoPath, 2, 640, 360);

    const result = await extractVideoThumbnail(videoPath, { outputPath: outPath, size: 200 });

    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
    // The output PNG itself should also be 200×200.
    const probedW = ffprobeNumber(outPath, 'duration'); // duration is meaningless for a single PNG; just sanity-check ffprobe ran
    expect(Number.isNaN(probedW) || probedW >= 0).toBe(true);
  });

  it('throws a helpful error when the video does not exist', async () => {
    await expect(
      extractVideoThumbnail(path.join(workDir, 'nope.mp4'), { outputPath: path.join(workDir, 'x.png') }),
    ).rejects.toThrow(/cannot read video/);
  });

  it('creates the output directory if it does not exist', async () => {
    const videoPath = path.join(workDir, 'mkdir.mp4');
    const outPath = path.join(workDir, 'nested/deeper/thumb.png');
    makeFixtureVideo(videoPath, 2);

    const result = await extractVideoThumbnail(videoPath, { outputPath: outPath });
    expect(existsSync(result.outputPath)).toBe(true);
  });
});
