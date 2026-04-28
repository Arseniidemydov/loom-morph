import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptureError } from '@/types';
import { __resetForTests, recordWebsite, shutdownRecordPool } from '@/pipeline/record';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'capture', '.rec');

function chromiumInstalled(): boolean {
  try {
    const r = spawnSync('node', ['-e', "import('playwright').then((m)=>console.log(m.chromium.executablePath()))"], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) return false;
    const exec = r.stdout.trim();
    return exec.length > 0 && existsSync(exec);
  } catch {
    return false;
  }
}

const haveChromium = chromiumInstalled();
const maybe = haveChromium ? describe : describe.skip;

const PAGE = `<!doctype html>
<html><head><title>record-fixture</title>
<style>
html,body{margin:0;font-family:system-ui}
.section{height:600px;display:flex;align-items:center;justify-content:center;font-size:48px;color:#fff}
.section:nth-child(1){background:#1a73e8}
.section:nth-child(2){background:#34a853}
.section:nth-child(3){background:#fbbc04}
.section:nth-child(4){background:#ea4335}
.section:nth-child(5){background:#673ab7}
</style></head><body>
<div class="section">One</div>
<div class="section">Two</div>
<div class="section">Three</div>
<div class="section">Four</div>
<div class="section">Five</div>
</body></html>`;

let server: Server;
let port = 0;

beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
  __resetForTests();
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('bad addr');
      port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await shutdownRecordPool();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('recordWebsite — input validation (no browser needed)', () => {
  it('rejects empty url', async () => {
    await expect(
      recordWebsite({ url: '', outputPath: '/tmp/x.webm', durationSec: 3 }),
    ).rejects.toBeInstanceOf(CaptureError);
  });

  it('rejects malformed url', async () => {
    await expect(
      recordWebsite({ url: 'not-a-url', outputPath: '/tmp/x.webm', durationSec: 3 }),
    ).rejects.toMatchObject({ name: 'CaptureError', reason: 'invalid-url' });
  });

  it('rejects non-positive duration', async () => {
    await expect(
      recordWebsite({ url: 'https://example.com', outputPath: '/tmp/x.webm', durationSec: 0 }),
    ).rejects.toBeInstanceOf(CaptureError);
  });
});

maybe('recordWebsite — integration (real Chromium)', () => {
  it('records a fixture page to a WebM that playables back at the requested duration', async () => {
    const out = path.join(OUT_DIR, 'fixture.webm');
    const result = await recordWebsite({
      url: `http://127.0.0.1:${port}/`,
      outputPath: out,
      durationSec: 3,
    });

    expect(result.videoPath).toBe(out);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(800);
    expect(existsSync(out)).toBe(true);

    // ffprobe the recording. Playwright's WebM encodes duration in the
    // container; should be ≥ requested duration (some buffer flushing).
    const probe = spawnSync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        out,
      ],
      { encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    const lines = probe.stdout.trim().split('\n');
    const duration = Number.parseFloat(lines.at(-1) ?? '0');
    expect(duration).toBeGreaterThanOrEqual(2.5);
  }, 60_000);

  it('output WebM works as a backgroundKind=video render input', async () => {
    const recOut = path.join(OUT_DIR, 'for-render.webm');
    await recordWebsite({
      url: `http://127.0.0.1:${port}/`,
      outputPath: recOut,
      durationSec: 2,
    });

    // Pull in the render module + a tiny circle PNG fixture.
    const { createRender } = await import('@/pipeline/render');
    const sharp = (await import('sharp')).default;
    const circlePath = path.join(OUT_DIR, 'circle.png');
    await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 80, g: 80, b: 200 } } })
      .png()
      .toFile(circlePath);

    const render = createRender({ maskDir: path.join(REPO_ROOT, 'public') });
    const renderOut = path.join(OUT_DIR, 'rendered.mp4');
    await render({
      screenshotPath: recOut,
      screenshotHeight: 800, // ignored for video bg
      circleSourcePath: circlePath,
      circleHasAudio: false,
      outputPath: renderOut,
      backgroundKind: 'video',
      config: {
        durationSec: 2,
        resolution: '720p',
        circlePosition: 'bottom-right',
        circleSize: 'S',
        circleMargin: 20,
        filenameTemplate: '',
      },
    });

    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', renderOut],
      { encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toMatch(/^h264,1280,720$/);
  }, 90_000);
});
