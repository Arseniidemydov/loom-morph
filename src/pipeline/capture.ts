import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Browser, BrowserContext, Page, Response } from 'playwright';
// playwright-extra wraps the launcher with the puppeteer-extra plugin chain.
// Stealth removes obvious headless tells; it's the cheapest anti-bot lever
// we have (PLAN.md § "Anti-Bot Strategy").
import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CaptureError, type CaptureFn, type CaptureInput, type CaptureResult } from '@/types';
import { injectionCss } from './cookie-selectors';

// ────────────────────── tunables (PLAN + INTERFACES) ──────────────────────

const VIEWPORT = { width: 1280, height: 800 } as const;
const GOTO_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1_000;
const SCROLL_STEP_DELAY_MS = 100;
const SCROLL_STEP_PX = 800;
const MAX_SCREENSHOT_HEIGHT = 16_000;
const DEFAULT_CONTEXT_POOL_SIZE = 6;
const CONTEXT_RECYCLE_AFTER_JOBS = 20;

// Patterns that strongly indicate a bot-wall interstitial. If the page body
// HTML contains any of these, retrying won't help — fail fast.
const BOT_WALL_FINGERPRINTS: readonly RegExp[] = [
  /Just a moment\.\.\./i,                  // Cloudflare interstitial
  /Checking your browser before accessing/i, // Cloudflare classic
  /cf-browser-verification/i,              // Cloudflare class hook
  /captcha-delivery\.com/i,                // DataDome
  /perfdrive\.com/i,                       // PerimeterX
];

interface BrowserState {
  browser: Browser;
  contexts: ContextSlot[];
  // resolves the next free context (FIFO)
  acquire(): Promise<ContextSlot>;
  release(slot: ContextSlot): void;
}

interface ContextSlot {
  context: BrowserContext;
  jobsRun: number;
  // recycled = needs replacement on next acquire
  recycled: boolean;
}

let stealthApplied = false;
let browserPromise: Promise<BrowserState> | null = null;
let activeBrowserState: BrowserState | null = null;

// ────────────────────── public surface ──────────────────────

export const captureWebsite: CaptureFn = async (input: CaptureInput): Promise<CaptureResult> => {
  validateInput(input);
  await mkdir(path.dirname(input.outputPath), { recursive: true });

  const state = await ensureBrowser(input.contextPoolSize ?? DEFAULT_CONTEXT_POOL_SIZE);
  const slot = await state.acquire();

  const startedAt = Date.now();
  let page: Page | null = null;
  try {
    page = await slot.context.newPage();
    await page.setViewportSize(VIEWPORT);

    let response: Response | null;
    try {
      response = await page.goto(input.url, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });
    } catch (err) {
      throw classifyNavError(err);
    }

    // Treat 403 as bot-walled — most B2B sites that block automation respond
    // 403 from the edge, often with a Cloudflare/DataDome interstitial body.
    if (response && response.status() === 403) {
      throw new CaptureError('bot-blocked', `403 from ${input.url}`);
    }

    // Inspect the rendered HTML for known interstitial fingerprints. Cheap
    // (one evaluate) and short-circuits before we waste time scrolling.
    const html = await page.content();
    if (BOT_WALL_FINGERPRINTS.some((rx) => rx.test(html))) {
      throw new CaptureError('bot-blocked', `bot-wall fingerprint matched on ${input.url}`);
    }

    await page.addStyleTag({ content: injectionCss() });

    await autoScroll(page);
    await page.waitForTimeout(SETTLE_MS);

    // Cap fullPage at MAX_SCREENSHOT_HEIGHT by clipping when the document is
    // pathologically tall. Playwright's `clip` requires explicit dimensions,
    // so we measure first.
    // String-source eval — same `__name` workaround as autoScroll.
    const pageDims = (await page.evaluate(`
      ({
        width: Math.max(document.documentElement.scrollWidth,
                        document.body ? document.body.scrollWidth : 0),
        height: Math.max(document.documentElement.scrollHeight,
                         document.body ? document.body.scrollHeight : 0)
      })
    `)) as { width: number; height: number };
    const targetHeight = Math.min(pageDims.height, MAX_SCREENSHOT_HEIGHT);

    // Always take fullPage; if the document is taller than MAX_SCREENSHOT_HEIGHT,
    // crop with sharp. Playwright's `clip` only operates within the viewport
    // unless paired with fullPage, and the two aren't always co-permitted in
    // practice — post-cropping the buffer is simpler and equally fast.
    if (pageDims.height > MAX_SCREENSHOT_HEIGHT) {
      const buf = await page.screenshot({ type: 'png', fullPage: true });
      await sharp(buf)
        .extract({ left: 0, top: 0, width: pageDims.width, height: MAX_SCREENSHOT_HEIGHT })
        .png()
        .toFile(input.outputPath);
    } else {
      await page.screenshot({ path: input.outputPath, type: 'png', fullPage: true });
    }

    const durationMs = Date.now() - startedAt;
    const result: CaptureResult = {
      pngPath: input.outputPath,
      width: pageDims.width,
      height: targetHeight,
      capturedAtMs: Date.now(),
      durationMs,
    };

    slot.jobsRun += 1;
    if (slot.jobsRun >= CONTEXT_RECYCLE_AFTER_JOBS) slot.recycled = true;
    return result;
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    throw new CaptureError('unknown', err instanceof Error ? err.message : String(err), err);
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore — context may be torn down already
      }
    }
    state.release(slot);
  }
};

export async function shutdownCapturePool(): Promise<void> {
  const state = activeBrowserState;
  if (!state) return;
  activeBrowserState = null;
  browserPromise = null;
  try {
    await Promise.all(state.contexts.map((c) => c.context.close().catch(() => {})));
  } finally {
    await state.browser.close().catch(() => {});
  }
}

// Test-only hook — let tests force a re-init and call shutdown without races.
export function __resetForTests(): void {
  activeBrowserState = null;
  browserPromise = null;
}

// ────────────────────── internals ──────────────────────

function validateInput(input: CaptureInput): void {
  if (!input.url || typeof input.url !== 'string') {
    throw new CaptureError('invalid-url', 'CaptureInput.url must be a non-empty string');
  }
  try {
    // Constructor throws on malformed URLs.
    new URL(input.url);
  } catch {
    throw new CaptureError('invalid-url', `not a valid URL: ${input.url}`);
  }
}

function classifyNavError(err: unknown): CaptureError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Timeout|timeout/.test(msg)) return new CaptureError('timeout', msg, err);
  if (/net::|ENOTFOUND|ECONNREFUSED|ECONNRESET|ERR_/.test(msg)) return new CaptureError('network', msg, err);
  if (/crashed/.test(msg)) return new CaptureError('page-crashed', msg, err);
  return new CaptureError('unknown', msg, err);
}

async function autoScroll(page: Page): Promise<void> {
  // Pass the body as a string to bypass bundler transformations. tsx/esbuild
  // wraps named/const-assigned arrows with `__name(...)` helpers; those don't
  // exist in the browser context where Playwright serializes this function.
  // A plain string source survives the round trip cleanly.
  const stepPx = SCROLL_STEP_PX;
  const stepDelayMs = SCROLL_STEP_DELAY_MS;
  const src = `
    (async () => {
      function docHeight() {
        return Math.max(document.documentElement.scrollHeight,
                        document.body ? document.body.scrollHeight : 0);
      }
      let y = 0;
      let max = docHeight() - window.innerHeight;
      while (y < max) {
        y += ${stepPx};
        window.scrollTo(0, y);
        await new Promise(function(r){ setTimeout(r, ${stepDelayMs}); });
        max = docHeight() - window.innerHeight;
      }
      window.scrollTo(0, max);
      await new Promise(function(r){ setTimeout(r, ${stepDelayMs}); });
      window.scrollTo(0, 0);
    })()
  `;
  await page.evaluate(src);
}

async function ensureBrowser(poolSize: number): Promise<BrowserState> {
  if (activeBrowserState) return activeBrowserState;
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    if (!stealthApplied) {
      const chromium = playwrightExtra.chromium;
      chromium.use(StealthPlugin());
      stealthApplied = true;
    }
    const browser = (await playwrightExtra.chromium.launch({ headless: true })) as Browser;

    const slots: ContextSlot[] = [];
    for (let i = 0; i < poolSize; i++) {
      const ctx = await newContext(browser);
      slots.push({ context: ctx, jobsRun: 0, recycled: false });
    }

    const free: ContextSlot[] = [...slots];
    const waiters: Array<(slot: ContextSlot) => void> = [];

    const state: BrowserState = {
      browser,
      contexts: slots,
      async acquire() {
        const slot = free.shift();
        if (slot) return await refreshIfNeeded(slot, browser);
        return await new Promise<ContextSlot>((resolve) => waiters.push(resolve));
      },
      release(slot: ContextSlot) {
        const waiter = waiters.shift();
        if (waiter) {
          // Give the slot to the next waiter (will be refreshed on the next acquire).
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          refreshIfNeeded(slot, browser).then(waiter);
        } else {
          free.push(slot);
        }
      },
    };

    activeBrowserState = state;
    return state;
  })();

  return browserPromise;
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
}

async function refreshIfNeeded(slot: ContextSlot, browser: Browser): Promise<ContextSlot> {
  if (!slot.recycled) return slot;
  try {
    await slot.context.close();
  } catch {
    // ignore; we're about to replace it anyway
  }
  slot.context = await newContext(browser);
  slot.jobsRun = 0;
  slot.recycled = false;
  return slot;
}
