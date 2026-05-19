import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn } from 'node:child_process';

const URLS = process.argv.slice(2);
if (URLS.length === 0) {
  console.error('Usage: tsx scripts/cmp-multi.mjs <url1> [url2 ...]');
  process.exit(1);
}
const DURATION_SEC = 12;
const VIEWPORT = { width: 1920, height: 1080 };
const OUT_DIR = '/tmp/loom-channel-comparison';
await mkdir(OUT_DIR, { recursive: true });

const chromium = playwrightExtra.chromium;
chromium.use(StealthPlugin());

async function captureOne(url, channelName, channel) {
  const tmpDir = path.join(tmpdir(), `loom-cmp-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  const launchOptions = {
    headless: true,
    args: [
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  };
  if (channel) launchOptions.channel = channel;

  console.log(`  [${channelName}] launching…`);
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: tmpDir, size: VIEWPORT },
  });
  await context.addInitScript({
    content: `(() => {
      const kicked = new WeakSet();
      const playAll = () => {
        for (const v of document.querySelectorAll('video')) {
          if (kicked.has(v)) continue; kicked.add(v);
          try { v.muted = true; v.setAttribute('muted',''); v.setAttribute('playsinline',''); const p = v.play(); if (p?.catch) p.catch(() => {}); } catch {}
        }
      };
      const start = () => { playAll(); new MutationObserver(playAll).observe(document.body || document.documentElement, { childList: true, subtree: true }); };
      if (document.body) start();
      else new MutationObserver(() => { if (document.body) start(); }).observe(document.documentElement, { childList: true, subtree: true });
    })();`,
  });
  const page = await context.newPage();
  const started = Date.now();
  try { await page.goto(url, { waitUntil: 'load', timeout: 25000 }); }
  catch { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}); }
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const offsetSec = (Date.now() - started) / 1000;
  console.log(`  [${channelName}] settled in ${offsetSec.toFixed(1)}s`);
  await page.waitForTimeout(DURATION_SEC * 1000);

  const video = page.video();
  await page.close();
  await context.close();
  const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/_+$/, '');
  const webmPath = path.join(OUT_DIR, `${slug}_${channelName}.webm`);
  await video.saveAs(webmPath);
  await browser.close();

  const mp4Path = path.join(OUT_DIR, `${slug}_${channelName}.mp4`);
  await runFfmpeg([
    '-y', '-ss', offsetSec.toFixed(3), '-i', webmPath,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-fps_mode', 'passthrough',
    '-t', String(DURATION_SEC),
    mp4Path,
  ]);
  await rm(tmpDir, { recursive: true, force: true });
  return mp4Path;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-5).join('\n')}`)));
  });
}

const outputs = [];
for (const url of URLS) {
  console.log(`\n== ${url} ==`);
  for (const [name, ch] of [['chromium', undefined], ['chrome', 'chrome']]) {
    try {
      const p = await captureOne(url, name, ch);
      outputs.push({ url, name, path: p });
    } catch (err) {
      console.error(`  [${name}] FAILED: ${err.message}`);
      outputs.push({ url, name, error: err.message });
    }
  }
}
console.log('\nAll outputs:');
for (const o of outputs) {
  console.log(`  ${o.url.padEnd(35)} ${o.name.padEnd(10)} ${o.path ?? `ERR: ${o.error}`}`);
}
