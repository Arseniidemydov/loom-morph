import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CaptureError } from '@/types';
import { __resetForTests, captureWebsite, shutdownCapturePool } from '@/pipeline/capture';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'capture', '.out');

// ────────────────────── chromium availability check ──────────────────────

function chromiumInstalled(): boolean {
  // Try the Playwright CLI's "show me where chromium is" probe; presence of
  // the launcher path is enough.
  try {
    const r = spawnSync('node', ['-e', "console.log(require('playwright').chromium.executablePath())"], {
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

// ────────────────────── fixture HTTP server ──────────────────────

interface Fixtures {
  port: number;
  server: Server;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function startServer(handler: Handler): Promise<Fixtures> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('bad address');
      resolve({ port: addr.port, server });
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    s.close((err) => (err ? reject(err) : resolve()));
  });
}

const SIMPLE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>simple</title>
<style>body{margin:0;font-family:sans-serif} .hero{height:1200px;background:linear-gradient(#444,#222);color:#fff;padding:40px}</style>
</head><body>
<div class="hero"><h1>Hello from a fixture</h1><p>scroll-friendly content</p></div>
<div id="onetrust-banner-sdk" style="position:fixed;inset:0;background:rgba(0,0,0,0.9);color:#fff;z-index:9999;padding:40px">cookie banner — should be hidden</div>
</body></html>`;

const TALL_PAGE = `<!doctype html>
<html><head><style>html,body{margin:0} .row{height:1000px;background:#888;border-bottom:2px solid #fff}</style></head>
<body>${'<div class="row"></div>'.repeat(20)}</body></html>`;

const CLOUDFLARE_PAGE = `<!doctype html>
<html><head><title>Just a moment...</title></head>
<body><div class="cf-browser-verification">Checking your browser before accessing</div></body></html>`;

// ────────────────────── tests ──────────────────────

beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
  __resetForTests();
});

afterAll(async () => {
  await shutdownCapturePool();
  // best-effort cleanup
  await rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('captureWebsite — input validation (no browser needed)', () => {
  it('rejects empty url', async () => {
    await expect(captureWebsite({ url: '', outputPath: '/tmp/x.png' })).rejects.toBeInstanceOf(CaptureError);
  });

  it('rejects malformed url', async () => {
    await expect(captureWebsite({ url: 'not-a-url', outputPath: '/tmp/x.png' })).rejects.toMatchObject({
      name: 'CaptureError',
      reason: 'invalid-url',
    });
  });
});

maybe('captureWebsite — integration (real Chromium)', () => {
  let fixtures: Fixtures;
  // Each test customizes the response handler so we can vary status codes /
  // bodies without spinning up a new server every time.
  let responder: Handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(SIMPLE_PAGE);
  };

  beforeAll(async () => {
    fixtures = await startServer((req, res) => responder(req, res));
  });

  afterAll(async () => {
    await stopServer(fixtures.server);
  });

  afterEach(() => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(SIMPLE_PAGE);
    };
  });

  it('captures a simple page to a PNG with valid dimensions', async () => {
    const out = path.join(OUT_DIR, 'simple.png');
    const result = await captureWebsite({ url: `http://127.0.0.1:${fixtures.port}/`, outputPath: out });
    expect(result.pngPath).toBe(out);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(statSync(out).size).toBeGreaterThan(500);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(result.width);
    expect(meta.height).toBe(result.height);
  }, 30_000);

  it('caps screenshot height at 16,000 px on a pathologically tall page', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(TALL_PAGE);
    };
    const out = path.join(OUT_DIR, 'tall.png');
    const result = await captureWebsite({ url: `http://127.0.0.1:${fixtures.port}/`, outputPath: out });
    expect(result.height).toBe(16_000);
    const meta = await sharp(out).metadata();
    expect(meta.height).toBe(16_000);
  }, 30_000);

  it('rejects with bot-blocked on HTTP 403', async () => {
    responder = (_req, res) => {
      res.writeHead(403, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end('<html><body>Forbidden</body></html>');
    };
    await expect(
      captureWebsite({ url: `http://127.0.0.1:${fixtures.port}/`, outputPath: path.join(OUT_DIR, 'wont-write.png') }),
    ).rejects.toMatchObject({ name: 'CaptureError', reason: 'bot-blocked' });
  }, 30_000);

  it('rejects with bot-blocked when body matches a Cloudflare interstitial fingerprint', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(CLOUDFLARE_PAGE);
    };
    await expect(
      captureWebsite({ url: `http://127.0.0.1:${fixtures.port}/`, outputPath: path.join(OUT_DIR, 'wont-write.png') }),
    ).rejects.toMatchObject({ name: 'CaptureError', reason: 'bot-blocked' });
  }, 30_000);

  it('rejects with network when host is unreachable', async () => {
    // Port 1 is reserved + always unbound — fastest portable network failure.
    await expect(
      captureWebsite({ url: 'http://127.0.0.1:1/', outputPath: path.join(OUT_DIR, 'net.png') }),
    ).rejects.toMatchObject({ name: 'CaptureError' });
  }, 30_000);
});
