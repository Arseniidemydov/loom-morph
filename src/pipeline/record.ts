import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CaptureError } from '@/types';
import { injectionCss } from './cookie-selectors';
import { generateScrollSegments, type ScrollSegment } from './scroll-segments';

// Live-page recorder. The screenshot-pan worker (capture.ts) is the right
// strategy for batches because it parallelises freely, but it freezes any
// hero animation, autoplay video, or parallax effect. For dynamic landing
// pages we want the real motion — that's what this module is for.
//
// How it works:
//   1. Playwright opens the URL in a context configured with `recordVideo`.
//   2. We drive `window.scrollTo` over the full output duration using the
//      same human-ish segment pattern that filter-graph emits — so the
//      generated video has the same scroll "feel" as the static-pan path.
//   3. When the context closes, Playwright finalizes a WebM. We `saveAs`
//      it to the requested output path.
//
// The render pipeline downstream (filter-graph.ts) recognises a video
// background via `RenderJob.backgroundKind = 'video'` and skips the
// time-based crop expression — instead it just scales + center-crops.

export interface RecordInput {
  url: string;             // pre-normalized https://...
  outputPath: string;      // absolute path; .webm extension recommended
  durationSec: number;     // total recording length
  viewportWidth?: number;  // default 1280
  viewportHeight?: number; // default 800
}

export interface RecordResult {
  videoPath: string;
  width: number;
  height: number;
  durationSec: number;
  capturedAtMs: number;
  durationMs: number;      // wall-clock time spent (≥ durationSec)
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const GOTO_TIMEOUT_MS = 30_000;
const SETTLE_MS = 500;
const FALLBACK_PAGE_HEIGHT_RATIO = 4; // when a page reports zero scroll height, pretend it's 4× viewport so the segment generator still produces motion.

let stealthApplied = false;
let browserPromise: Promise<Browser> | null = null;
let activeBrowser: Browser | null = null;

export async function recordWebsite(input: RecordInput): Promise<RecordResult> {
  validateInput(input);

  const viewport = {
    width: input.viewportWidth ?? DEFAULT_VIEWPORT.width,
    height: input.viewportHeight ?? DEFAULT_VIEWPORT.height,
  };
  const tmpDir = path.join(tmpdir(), `loom-record-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  await mkdir(path.dirname(input.outputPath), { recursive: true });

  const browser = await ensureBrowser();
  const startedAt = Date.now();

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      recordVideo: { dir: tmpDir, size: viewport },
    });
    page = await context.newPage();

    try {
      await page.goto(input.url, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });
    } catch (err) {
      throw classifyNavError(err);
    }

    await page.addStyleTag({ content: injectionCss() });
    await page.waitForTimeout(SETTLE_MS);

    // Measure the page's true scroll extent BEFORE driving the scroll, so
    // segment positions translate to absolute pixels accurately. If the
    // page lazy-loads more content during the recording, the segment
    // targets might be slightly short — still acceptable.
    const pageScrollHeight = await measureScrollHeight(page, viewport.height);
    const segments = generateScrollSegments({
      screenshotHeight: pageScrollHeight,
      viewportHeight: viewport.height,
      durationSec: input.durationSec,
    });
    const maxPan = Math.max(0, pageScrollHeight - viewport.height);

    await driveScroll(page, segments, maxPan, input.durationSec);

    const video = page.video();
    await page.close();
    await context.close();
    page = null;
    context = null;

    if (!video) throw new CaptureError('unknown', 'Playwright did not record a video for the page');
    await video.saveAs(input.outputPath);

    return {
      videoPath: input.outputPath,
      width: viewport.width,
      height: viewport.height,
      durationSec: input.durationSec,
      capturedAtMs: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    throw new CaptureError('unknown', err instanceof Error ? err.message : String(err), err);
  } finally {
    try {
      if (page) await page.close();
    } catch {
      // ignore — context teardown will clean up
    }
    try {
      if (context) await context.close();
    } catch {
      // ignore
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function shutdownRecordPool(): Promise<void> {
  const browser = activeBrowser;
  if (!browser) return;
  activeBrowser = null;
  browserPromise = null;
  await browser.close().catch(() => {});
}

// Test hook — same shape as capture.ts.
export function __resetForTests(): void {
  activeBrowser = null;
  browserPromise = null;
}

// ────────────────────── internals ──────────────────────

function validateInput(input: RecordInput): void {
  if (!input.url || typeof input.url !== 'string') {
    throw new CaptureError('invalid-url', 'RecordInput.url must be a non-empty string');
  }
  try {
    new URL(input.url);
  } catch {
    throw new CaptureError('invalid-url', `not a valid URL: ${input.url}`);
  }
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) {
    throw new CaptureError('unknown', `RecordInput.durationSec must be positive (got ${input.durationSec})`);
  }
}

function classifyNavError(err: unknown): CaptureError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Timeout|timeout/.test(msg)) return new CaptureError('timeout', msg, err);
  if (/net::|ENOTFOUND|ECONNREFUSED|ECONNRESET|ERR_/.test(msg)) return new CaptureError('network', msg, err);
  if (/crashed/.test(msg)) return new CaptureError('page-crashed', msg, err);
  return new CaptureError('unknown', msg, err);
}

async function ensureBrowser(): Promise<Browser> {
  if (activeBrowser) return activeBrowser;
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    if (!stealthApplied) {
      const chromium = playwrightExtra.chromium;
      chromium.use(StealthPlugin());
      stealthApplied = true;
    }
    const browser = (await playwrightExtra.chromium.launch({ headless: true })) as Browser;
    activeBrowser = browser;
    return browser;
  })();
  return browserPromise;
}

async function measureScrollHeight(page: Page, viewportHeight: number): Promise<number> {
  // Same string-eval workaround as capture.ts — bundlers wrap arrow funcs
  // with __name() helpers that don't exist in the browser context.
  const result = (await page.evaluate(`
    Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    )
  `)) as number;
  if (typeof result !== 'number' || !Number.isFinite(result) || result <= 0) {
    return Math.round(viewportHeight * FALLBACK_PAGE_HEIGHT_RATIO);
  }
  return result;
}

async function driveScroll(
  page: Page,
  segments: ScrollSegment[],
  maxPan: number,
  durationSec: number,
): Promise<void> {
  // Pass the body as a string. Bundlers (tsx/esbuild) wrap named functions
  // with __name(...) helpers when transpiling, and those don't exist when
  // Playwright serializes the function for page.evaluate(). String form
  // survives the round trip cleanly.
  const segmentsJson = JSON.stringify(segments);
  const src = `
    (async () => {
      const segments = ${segmentsJson};
      const maxPan = ${maxPan};
      const durationSec = ${durationSec};
      const computeY = function(t) {
        if (segments.length === 0 || maxPan <= 0) return 0;
        if (t <= segments[0].start) return Math.round(segments[0].from * maxPan);
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i];
          if (t < s.start) return Math.round(s.from * maxPan);
          if (t < s.end) {
            const p = (t - s.start) / Math.max(0.0001, s.end - s.start);
            const eased = p * p * (3 - 2 * p);
            return Math.round((s.from + (s.to - s.from) * eased) * maxPan);
          }
        }
        return Math.round(segments[segments.length - 1].to * maxPan);
      };
      return new Promise(function(resolve) {
        const start = performance.now();
        function tick() {
          const t = (performance.now() - start) / 1000;
          if (t >= durationSec) {
            window.scrollTo(0, computeY(durationSec));
            resolve();
            return;
          }
          window.scrollTo(0, computeY(t));
          requestAnimationFrame(tick);
        }
        // Initial position before the first frame.
        window.scrollTo(0, computeY(0));
        requestAnimationFrame(tick);
      });
    })()
  `;
  await page.evaluate(src);
}
