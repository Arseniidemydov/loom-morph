import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Skip if either ffmpeg or chromium is missing; the spike chains both.
function chromiumInstalled(): boolean {
  const r = spawnSync('node', ['-e', "console.log(require('playwright').chromium.executablePath())"], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return r.status === 0 && existsSync(r.stdout.trim());
}
const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const haveChromium = chromiumInstalled();
const maybe = haveFfmpeg && haveChromium ? describe : describe.skip;

const PAGE = `<!doctype html><html><head><title>spike-fixture</title>
<style>body{margin:0}.hero{height:1200px;background:#222;color:#fff;display:flex;align-items:center;justify-content:center;font-size:48px}</style>
</head><body><div class="hero">Spike Fixture</div></body></html>`;

let server: Server;
let port = 0;
let workDir: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
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
  workDir = await mkdtemp(path.join(tmpdir(), 'loom-spike-test-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe('spike CLI — argument parsing', () => {
  it('--help exits 0 and prints usage', () => {
    const r = spawnSync('npm', ['run', '--silent', 'spike', '--', '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('loom-morph spike');
    expect(r.stdout).toContain('--url');
  });

  it('exits non-zero with a clear error when --url is missing', () => {
    const r = spawnSync('npm', ['run', '--silent', 'spike', '--', '--circle', 'whatever.png'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/--url/);
  });
});

maybe('spike CLI — integration (real Chromium + ffmpeg)', () => {
  it('captures a fixture URL and renders a valid 720p MP4', async () => {
    const out = path.join(workDir, 'spike.mp4');
    const circle = path.join(REPO_ROOT, 'public', 'circle-mask-280.png');
    expect(existsSync(circle)).toBe(true);

    const args = [
      'run', '--silent', 'spike', '--',
      '--url', `http://127.0.0.1:${port}/`,
      '--circle', circle,
      '--duration', '2',
      '--resolution', '720p',
      '--output', out,
      '--circle-size', 'S',
    ];

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('npm', args, { cwd: REPO_ROOT, stdio: 'inherit' });
      child.on('close', (code) => resolve(code ?? -1));
    });
    expect(exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(1000);

    const probe = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out], { encoding: 'utf8' });
    expect(probe.status).toBe(0);
    const streams = JSON.parse(probe.stdout) as { streams: Array<Record<string, unknown>> };
    const video = streams.streams.find((s) => s.codec_type === 'video');
    expect(video).toBeDefined();
    expect(video!.codec_name).toBe('h264');
    expect(video!.width).toBe(1280);
    expect(video!.height).toBe(720);
  }, 90_000);
});
