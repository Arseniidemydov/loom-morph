import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { probeMediaDurationSec } from '@/lib/media-probe';

const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const haveFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const maybe = haveFfmpeg && haveFfprobe ? describe : describe.skip;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'mediaprobe-test-'));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

function makeFixtureMedia(out: string, durationSec: number, kind: 'audio' | 'video'): void {
  const args =
    kind === 'video'
      ? [
          '-y',
          '-f', 'lavfi',
          '-i', `testsrc=size=160x120:rate=30:duration=${durationSec}`,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-t', String(durationSec),
          out,
        ]
      : [
          '-y',
          '-f', 'lavfi',
          '-i', `sine=frequency=440:duration=${durationSec}`,
          '-c:a', 'libmp3lame',
          '-t', String(durationSec),
          out,
        ];
  const r = spawnSync('ffmpeg', args, { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture gen failed: ${r.stderr}`);
}

maybe('probeMediaDurationSec', () => {
  it('reads the duration of a video file', async () => {
    const file = path.join(workDir, 'sample.mp4');
    makeFixtureMedia(file, 4, 'video');
    const d = await probeMediaDurationSec(file);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(3.5);
    expect(d!).toBeLessThan(4.5);
  });

  it('reads the duration of an audio file', async () => {
    const file = path.join(workDir, 'sample.mp3');
    makeFixtureMedia(file, 7, 'audio');
    const d = await probeMediaDurationSec(file);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(6.5);
    expect(d!).toBeLessThan(7.5);
  });

  it('returns null for a nonexistent file', async () => {
    expect(await probeMediaDurationSec(path.join(workDir, 'missing.mp4'))).toBeNull();
  });

  it('returns null for a non-media file', async () => {
    const file = path.join(workDir, 'not-media.txt');
    await writeFile(file, 'just some text', 'utf8');
    expect(await probeMediaDurationSec(file)).toBeNull();
  });

  it('returns null when ffprobe binary is missing', async () => {
    const file = path.join(workDir, 'sample.mp4');
    expect(await probeMediaDurationSec(file, { ffprobePath: '/nonexistent/ffprobe-bin' })).toBeNull();
  });
});
