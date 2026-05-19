// Side-by-side recorder comparison: bundled Chromium vs system Chrome.
// Captures the same URL twice and renders both to MP4 via our pipeline.
//
// Usage:  npx tsx /tmp/chrome-comparison.mjs <url> [--channel chrome|chromium]

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn } from 'node:child_process';

const REPO = '/Users/arsenii/Desktop/loom morph';
const URL_ARG = process.argv[2] ?? 'https://askjeff.com/';
const DURATION_SEC = 15;
const VIEWPORT = { width: 1920, height: 1080 };

const OUT_DIR = '/tmp/loom-channel-comparison';
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const CHANNELS = [
  { name: 'chromium-bundled', channel: undefined },
  { name: 'chrome-system', channel: 'chrome' },
];

const stealthApplied = new Set();

async function captureOne(channelDef) {
  const tmpDir = path.join(tmpdir(), `loom-cmp-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });

  const chromium = playwrightExtra.chromium;
  if (!stealthApplied.has(channelDef.name)) {
    chromium.use(StealthPlugin());
    stealthApplied.add(channelDef.name);
  }
  const launchOptions = {
    headless: true,
    args: [
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=LazyImageLoading,LazyFrameLoading',
    ],
  };
  if (channelDef.channel) launchOptions.channel = channelDef.channel;

  console.log(`[${channelDef.name}] launching…`);
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: tmpDir, size: VIEWPORT },
  });
  // Force-play all videos.
  await context.addInitScript({
    content: `
      (() => {
        const kicked = new WeakSet();
        const playAll = () => {
          for (const v of document.querySelectorAll('video')) {
            if (kicked.has(v)) continue;
            kicked.add(v);
            try { v.muted = true; v.setAttribute('muted',''); v.setAttribute('playsinline',''); const p = v.play(); if (p?.catch) p.catch(() => {}); } catch {}
          }
        };
        const start = () => {
          playAll();
          new MutationObserver(playAll).observe(document.body || document.documentElement, { childList: true, subtree: true });
        };
        if (document.body) start();
        else new MutationObserver(() => { if (document.body) { start(); } }).observe(document.documentElement, { childList: true, subtree: true });
      })();
    `,
  });
  const page = await context.newPage();
  const started = Date.now();
  try {
    await page.goto(URL_ARG, { waitUntil: 'load', timeout: 25000 });
  } catch {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const offsetSec = (Date.now() - started) / 1000;
  console.log(`[${channelDef.name}] settled in ${offsetSec.toFixed(1)}s, recording ${DURATION_SEC}s static…`);
  // Static recording so the comparison is purely about video playback,
  // not scroll behavior.
  await page.waitForTimeout(DURATION_SEC * 1000);

  const video = page.video();
  await page.close();
  await context.close();
  // saveAs MUST happen while the browser is alive — Playwright streams
  // the recorded webm out of the browser process.
  const webmPath = path.join(OUT_DIR, `${channelDef.name}.webm`);
  await video.saveAs(webmPath);
  await browser.close();
  await rm(tmpDir, { recursive: true, force: true });

  // Trim offset & re-encode to MP4 so user can open in QuickTime.
  const mp4Path = path.join(OUT_DIR, `${channelDef.name}.mp4`);
  await runFfmpeg([
    '-y', '-ss', offsetSec.toFixed(3), '-i', webmPath,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-fps_mode', 'passthrough',
    '-t', String(DURATION_SEC),
    mp4Path,
  ]);
  console.log(`[${channelDef.name}] → ${mp4Path}`);
  return mp4Path;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-10).join('\n')}`));
    });
  });
}

console.log(`URL: ${URL_ARG}`);
console.log(`Duration: ${DURATION_SEC}s (static, no scroll)`);
console.log(`Viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
console.log('');

const results = [];
for (const c of CHANNELS) {
  try {
    const out = await captureOne(c);
    results.push({ name: c.name, path: out });
  } catch (err) {
    console.error(`[${c.name}] FAILED:`, err.message);
    results.push({ name: c.name, error: err.message });
  }
}

console.log('');
console.log('Comparison ready:');
for (const r of results) {
  console.log(`  ${r.name.padEnd(20)} ${r.path ?? `ERROR: ${r.error}`}`);
}
