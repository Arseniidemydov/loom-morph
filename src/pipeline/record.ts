import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CaptureError } from '@/types';
import {
  COOKIE_ACCEPT_SELECTORS,
  COOKIE_ACCEPT_TEXT_PATTERNS,
  injectionCss,
} from './cookie-selectors';
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
  // 'auto' (default) probes whether the page responds to programmatic
  // scroll and falls back to 'static' if not. 'pan' always drives the
  // human-ish scroll; 'static' always holds the page at scrollY=0.
  scrollMode?: 'auto' | 'pan' | 'static';
}

export interface RecordResult {
  videoPath: string;
  width: number;
  height: number;
  durationSec: number;
  capturedAtMs: number;
  durationMs: number;      // wall-clock time spent (≥ durationSec)
  // Wall-clock seconds elapsed between the recording start (context open)
  // and the moment driveScroll begins. The renderer skips this prefix via
  // ffmpeg `-ss` so the output never shows a blank/loading page.
  videoStartOffsetSec: number;
}

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
// Page renders 1:1 into the output viewport. We tried supersampling (1.25×)
// for a "show more content" effect, but it slowed layout and tripped
// conditional-render paths on some sites — net regression. If we revisit
// it, gate behind a per-batch opt-in setting.
const GOTO_TIMEOUT_MS = 45_000;
// `load` may not fire on chatty pages within this budget; we fall through
// to the bounded networkidle wait below so the capture proceeds anyway.
const GOTO_LOAD_BUDGET_MS = 25_000;
// Wait for the network to go idle after DCL — modern landing pages keep
// firing fetches for analytics, fonts, and hero images well past parse.
// This budget is bounded so chatty pages (long-poll sockets, marketing
// pixels) can't pin us forever, but it's big enough that heavy
// React/Next.js sites finish their hydration round.
//
// Trimmed 12s → 6s: marketing pages with persistent connections (chat
// widgets, analytics long-polls) almost never reach true networkidle, so
// the old budget was burned in full on most leads. 6s still covers the
// hydration round for heavy React/Next sites; the stability poll below is
// the real backstop for late-injected content. This is per-lead real-time
// in recording mode, so it directly reduces batch wall-clock.
const NETWORK_IDLE_BUDGET_MS = 6_000;
// Post-idle settle. Gives hydrated JS, lazy-loaded above-the-fold images,
// late-arriving web fonts, and any animation-on-load (hero fades, etc.)
// time to finish rendering before driveScroll starts capturing useful
// frames. The output trim drops this prefix entirely so a long settle
// only costs wall time, never seconds of output footage.
//
// Trimmed 5s → 2.5s: by the time we reach here we've already waited for
// networkidle + fonts-ready + layout stability, so most above-the-fold
// work is done. 2.5s covers residual hero fades without paying 5s of pure
// wall time on every lead.
const SETTLE_MS = 2_500;
// Cap on `document.fonts.ready` so a site with a broken font CDN can't
// stall the capture. Most pages resolve this in 100-500ms.
const FONTS_READY_BUDGET_MS = 4_000;
// "Wait until the page stops growing." Heavy sites keep injecting hero
// images, embeds, lazy components for several seconds after networkidle
// fires. We poll scrollHeight every 500ms and consider the layout stable
// once it hasn't changed for STABILITY_REQUIRED_MS. Capped at
// STABILITY_MAX_WAIT_MS so a site with infinite scroll / live-updating
// content can't pin us forever.
//
// Trimmed 15s → 8s: the cap only bites on pages that never stabilize
// (infinite scroll, live tickers), where waiting longer wouldn't help
// anyway — they hit STABILITY_REQUIRED_MS or the cap regardless. Pages
// that do settle exit early via STABILITY_REQUIRED_MS and are unaffected.
const STABILITY_MAX_WAIT_MS = 8_000;
const STABILITY_REQUIRED_MS = 2_500;
const STABILITY_POLL_MS = 500;
// Bounded budget for the cookie-banner click sweep — bounded per selector,
// not in total, so this is a rough upper bound for the worst case where
// every selector misses.
const COOKIE_CLICK_TIMEOUT_MS = 350;
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
    // Inject the heartbeat element BEFORE navigation so the video encoder
    // never sees a static page (see buildInitScript for why). Cookie banners
    // are dismissed by clicking AFTER navigation — we used to CSS-hide them
    // here too, but that hid the accept buttons via display:none inheritance
    // and made the click pass impossible.
    await context.addInitScript({ content: buildInitScript() });
    page = await context.newPage();

    try {
      // Prefer `load` so the page has had time to render its hero
      // content and we're not capturing a blank parsed-HTML document.
      // For pages where `load` never fires within the budget (chatty
      // long-poll sockets, persistent analytics requests), we fall
      // through to a hard navigation with no waitUntil and rely on the
      // bounded networkidle + visualReadiness + layoutStable waits
      // below to catch a usable state. Genuine network failures (DNS,
      // TLS, refused) still throw and bubble up as captureErrors.
      try {
        await page.goto(input.url, { waitUntil: 'load', timeout: GOTO_LOAD_BUDGET_MS });
      } catch (err) {
        if (!isPlaywrightTimeout(err)) throw err;
        // Already navigating to the URL — wait briefly for DCL so the
        // page has SOMETHING in the DOM, then proceed.
        await page
          .waitForLoadState('domcontentloaded', { timeout: GOTO_TIMEOUT_MS - GOTO_LOAD_BUDGET_MS })
          .catch(() => {});
      }
      await page
        .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_BUDGET_MS })
        .catch(() => {
          // Either timed out (chatty page) or a navigation interrupted the
          // wait; either way we have a painted page and proceed.
        });
    } catch (err) {
      throw classifyNavError(err);
    }

    // Two-pass cookie dismissal. Switching to `domcontentloaded` made our
    // first attempt happen before some CMP libraries (Cookiebot, custom
    // self-injected banners) have even mounted their DOM, so we'd return
    // empty-handed and fall back to the CSS hide — which only works for
    // banners whose wrapper selector we know.
    //
    //   - EARLY pass: catches fast-loading banners so any
    //     consent-gated content (hero videos, embeds) can start loading
    //     during the readiness/stability waits below.
    //   - LATE pass: catches slow-injecting banners. By the time
    //     waitForLayoutStable returns, the page has been done changing
    //     for 2.5s, so any banner that's going to appear is in the DOM.
    //
    // Both calls are cheap on banner-free pages (~50ms each).
    await dismissCookieBanner(page);

    // Wait for visible content to actually be ready before recording. Web
    // fonts and above-the-fold images are what the user sees mid-load
    // ("FOUT" text restyling, hero images popping in after the fade);
    // these waits target those signals directly rather than relying on
    // generic settle time.
    await waitForVisualReadiness(page);
    // Heavy sites keep injecting content for several seconds after
    // networkidle fires. This polls scrollHeight until it stops changing
    // — a much stronger signal than any fixed sleep, because it exits
    // fast on light sites and waits as long as needed on heavy ones.
    await waitForLayoutStable(page);

    // Late dismiss + CSS hide as the final safety net. Anything still on
    // screen at this point either gets clicked away or hidden by the
    // injectionCss tag below.
    await dismissCookieBanner(page);
    await page
      .addStyleTag({ content: injectionCss() })
      .catch(() => {
        // ignore — page might be in a transitional state; not load-blocking.
      });

    await page.waitForTimeout(SETTLE_MS);

    // Anchor the "useful content begins here" timestamp. Everything before
    // this point — navigation, hydration, cookie clicks, settle — gets
    // skipped by the renderer via ffmpeg `-ss`, so the output never shows
    // a blank/loading page even on heavy sites.
    const videoStartOffsetSec = Math.max(0, (Date.now() - startedAt) / 1000);

    let scrollMode: 'pan' | 'static' = input.scrollMode === 'static' ? 'static' : 'pan';
    if ((input.scrollMode ?? 'auto') === 'auto') {
      // Probe whether programmatic scroll actually moves the page. Catches
      // scroll-locked sites (overflow:hidden), scroll-jacked sites that
      // intercept and cancel wheel/scroll events (sirmary-style), and
      // short pages that fit in one viewport with nothing to pan over.
      const locked = await detectScrollLocked(page, viewport.height);
      scrollMode = locked ? 'static' : 'pan';
    }

    if (scrollMode === 'static') {
      // Hold the page at the top for the full duration. Hero videos and
      // on-page animations still play (the heartbeat keeps the encoder
      // active), but we don't trigger any scroll-linked motion. Useful
      // for sites whose hero shifts/scales beyond viewport on scroll.
      await page.evaluate(`window.scrollTo(0, 0)`);
      await page.waitForTimeout(input.durationSec * 1000);
    } else {
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
    }

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
      videoStartOffsetSec,
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

function isPlaywrightTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Playwright signals timeouts with `TimeoutError` and a "Timeout NNNNms
  // exceeded" message body. Match both so we catch the variants.
  return err.name === 'TimeoutError' || /Timeout\s+\d+ms\s+exceeded/i.test(err.message);
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
    const launchArgs = [
      // Pin the device pixel ratio to 1 so a page never renders at the
      // host monitor's DPR (intermittent on macOS where Chromium will
      // pick up the laptop's 2× by default and the recording comes out
      // looking "zoomed in").
      '--force-device-scale-factor=1',
      // Hero videos should play immediately — most pages mark them
      // `<video autoplay muted>` but Chromium's autoplay heuristics
      // sometimes still block until a user gesture. Allow autoplay
      // everywhere; we're not browsing real user content.
      '--autoplay-policy=no-user-gesture-required',
      // Headless tabs are treated as "backgrounded" by default and
      // Chromium throttles timers + rAF. Disabling stops the page
      // animations from running at single-digit fps during the
      // recording.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // Some pages intersection-observer their hero video and only
      // hydrate it when scrolled into view. Disabling lazy loading
      // makes the above-the-fold video start playing during the
      // settle window instead of mid-recording.
      '--disable-features=LazyImageLoading,LazyFrameLoading',
    ];
    // Container-only hardening (set LOOM_CONTAINER=1 in the Docker image).
    // Headless Chrome in a Linux container needs --no-sandbox (no user
    // namespace) and --disable-dev-shm-usage (the default 64MB /dev/shm
    // OOM-crashes the renderer on heavy pages). Left off on macOS dev where
    // the sandbox works and shm is ample.
    if (process.env.LOOM_CONTAINER === '1') {
      launchArgs.push('--no-sandbox', '--disable-dev-shm-usage');
    }
    // Prefer system Chrome over Playwright's bundled Chromium for one
    // critical reason: Chromium ships without the proprietary codec set
    // (H.264 / HEVC / AAC) that real Chrome includes. The vast majority
    // of landing-page hero videos are H.264 MP4, so the bundled binary
    // decodes them to a black frame and the recording sits on a poster.
    // Falls back to bundled Chromium if Chrome isn't installed (CI,
    // production containers without Google Chrome) — we log once so the
    // operator knows quality may degrade.
    let browser: Browser;
    try {
      browser = (await playwrightExtra.chromium.launch({
        headless: true,
        channel: 'chrome',
        args: launchArgs,
      })) as Browser;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[record] system Chrome not available, falling back to bundled Chromium. ' +
          'Hero videos using H.264/HEVC codecs will appear frozen. ' +
          'Install Chrome (or run `npx playwright install chrome`) to fix.',
        err instanceof Error ? err.message : err,
      );
      browser = (await playwrightExtra.chromium.launch({
        headless: true,
        args: launchArgs,
      })) as Browser;
    }
    activeBrowser = browser;
    return browser;
  })();
  return browserPromise;
}

async function waitForLayoutStable(page: Page): Promise<void> {
  // Poll the page's scrollHeight. As long as it keeps changing, the page
  // is still injecting content (lazy images, embeds, hydrated panels).
  // Once it's been stable for STABILITY_REQUIRED_MS continuously we
  // assume the layout has settled. Falls through after STABILITY_MAX_WAIT_MS
  // so sites with infinite-scroll or live-tickers can't trap us.
  const start = Date.now();
  let lastHeight = -1;
  let stableSince = Date.now();
  while (Date.now() - start < STABILITY_MAX_WAIT_MS) {
    let height = 0;
    try {
      height = (await page.evaluate(
        `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`,
      )) as number;
    } catch {
      // page closed / detached — return immediately, the outer settle is
      // the safety net.
      return;
    }
    if (height !== lastHeight) {
      lastHeight = height;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= STABILITY_REQUIRED_MS) {
      return;
    }
    await page.waitForTimeout(STABILITY_POLL_MS);
  }
}

async function waitForVisualReadiness(page: Page): Promise<void> {
  // Two concrete signals that the page is visually stable:
  //
  //   1. `document.fonts.ready` resolves once every @font-face declaration
  //      has finished loading. Without this, the first second of the
  //      recording often shows the fallback system font that swaps to the
  //      brand font mid-scroll — particularly bad for landing pages with
  //      large hero typography.
  //
  //   2. All `<img>` elements with `loading="eager"` (i.e. above-the-fold,
  //      including the hero) finish loading. Lazy-loaded images further
  //      down the page are intentionally not waited for; driveScroll's
  //      scrolling will trigger their loading naturally during the
  //      recording.
  //
  // Both are bounded so a busted CDN can't stall the entire capture.
  await page
    .evaluate(
      `(async () => {
        try {
          if (document.fonts && typeof document.fonts.ready?.then === 'function') {
            await Promise.race([
              document.fonts.ready,
              new Promise((r) => setTimeout(r, ${FONTS_READY_BUDGET_MS})),
            ]);
          }
        } catch (e) {}
        try {
          const eager = Array.from(document.images).filter(
            (img) => img.getAttribute('loading') !== 'lazy' && !img.complete,
          );
          if (eager.length > 0) {
            await Promise.race([
              Promise.all(eager.map((img) => new Promise((r) => {
                img.addEventListener('load', r, { once: true });
                img.addEventListener('error', r, { once: true });
              }))),
              new Promise((r) => setTimeout(r, ${FONTS_READY_BUDGET_MS})),
            ]);
          }
        } catch (e) {}
      })()`,
    )
    .catch(() => {
      // ignore — the SETTLE_MS pause is the safety net for any path that
      // throws (page closed, evaluate timeout, etc).
    });
}

async function dismissCookieBanner(page: Page): Promise<boolean> {
  // Some banners inject AFTER networkidle (e.g. via deferred JS or a
  // microtask after consent SDK init). One immediate attempt + a second
  // attempt after a short wait catches both fast and slow-loading
  // banners without paying the cost when there's nothing to dismiss.
  if (await dismissCookieBannerOnce(page)) return true;
  await page.waitForTimeout(700);
  return dismissCookieBannerOnce(page);
}

async function dismissCookieBannerOnce(page: Page): Promise<boolean> {
  // Iterate every frame — many CMPs (TrustArc, SourcePoint, some Quantcast
  // deployments) render the consent UI inside an iframe so the main-frame
  // locator returns nothing. `page.frames()` includes the main frame.
  for (const frame of page.frames()) {
    if (await tryDismissInFrame(frame)) return true;
  }
  return false;
}

async function tryDismissInFrame(frame: import('playwright').Frame): Promise<boolean> {
  // First-pass: a SINGLE combined CSS selector spanning every known CMP
  // library. One round-trip to the frame either finds an accept button
  // or doesn't — much faster than polling each selector individually.
  const combinedSelector = COOKIE_ACCEPT_SELECTORS.join(', ');
  try {
    const locator = frame.locator(combinedSelector).first();
    if ((await locator.count()) > 0) {
      await locator.waitFor({ state: 'visible', timeout: COOKIE_CLICK_TIMEOUT_MS });
      await locator.click({ timeout: COOKIE_CLICK_TIMEOUT_MS, force: true });
      return true;
    }
  } catch {
    // Element disappeared between count and click, frame detached, or
    // click intercepted — fall through to the text fallback.
  }

  // Fallback: query every visible button-like element and regex-match
  // its accessible text against COOKIE_ACCEPT_TEXT_PATTERNS. Catches
  // bespoke banners — common on B2B/agency sites — and non-English
  // sites where the button is labelled "Akzeptieren", "Accepter", etc.
  try {
    // `:visible` is a Playwright pseudo. We also include role="button" and
    // <a> elements that some banners use instead of <button>.
    const candidates = await frame
      .locator('button:visible, [role="button"]:visible, a[href]:visible')
      .all();
    for (const handle of candidates) {
      const text = (await handle.textContent())?.trim() ?? '';
      if (!text || text.length > 40) continue;
      if (COOKIE_ACCEPT_TEXT_PATTERNS.some((re) => re.test(text))) {
        await handle.click({ timeout: COOKIE_CLICK_TIMEOUT_MS, force: true });
        return true;
      }
    }
  } catch {
    // ignore — caller's CSS hide is the safety net.
  }
  return false;
}

async function detectScrollLocked(page: Page, viewportHeight: number): Promise<boolean> {
  // Behavioral probe: tell the page to scroll, wait for it to settle, and
  // see whether scrollY actually moved. Sites that fall through to "true"
  // (locked) are:
  //   - scroll-jacked (Locomotive/Lenis/custom wheel handlers that cancel
  //     programmatic scrolls)
  //   - overflow:hidden on body/html
  //   - shorter than the viewport (nothing to scroll past)
  //
  // We restore scrollY=0 before returning so driveScroll starts cleanly.
  // On any error (page closed, evaluate failed), default to NOT locked so
  // the caller proceeds with the user's original mode preference.
  try {
    const probe = (await page.evaluate(
      `(async () => {
        const target = 200;
        const before = window.scrollY || document.documentElement.scrollTop || 0;
        window.scrollTo(0, target);
        await new Promise((r) => setTimeout(r, 200));
        const after = window.scrollY || document.documentElement.scrollTop || 0;
        const scrollHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0
        );
        window.scrollTo(0, before);
        return { delta: after - before, scrollHeight, innerHeight: window.innerHeight };
      })()`,
    )) as { delta: number; scrollHeight: number; innerHeight: number };
    // Scroll didn't move (within 50 px tolerance for partial scrolls)?
    if (probe.delta < 150) return true;
    // Page is no taller than the viewport plus a small margin? Nothing
    // useful to pan over.
    if (probe.scrollHeight <= viewportHeight + 100) return true;
    return false;
  } catch {
    return false;
  }
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

function buildInitScript(): string {
  // Two responsibilities, both wired before any page script runs:
  //
  //  1. Heartbeat element. Pin a 1×1 transparent element to the top-left
  //     and animate it via CSS keyframes. Playwright's video encoder
  //     skips frames on visually-static pages — driveScroll's initial
  //     pause holds scrollY=0, which the browser deduplicates, so the
  //     encoder can drop the entire first ~second of recording on a
  //     fresh browser context. A continuous compositor-level animation
  //     guarantees a frame change every refresh and keeps the video
  //     timeline aligned with wall-clock.
  //
  //  2. Force-play every <video>. Many pages don't use the `autoplay`
  //     attribute — they invoke `.play()` from JS conditioned on
  //     `document.visibilityState`, a user-interaction flag, or an
  //     IntersectionObserver "in view" trigger. In headless those
  //     conditions often come back "no" and the hero video sits on its
  //     poster for the entire recording. We call `.play()` on every
  //     <video> at mount time (and on every DOM mutation, for late-
  //     hydrated SPA frames). Errors are swallowed — calling `.play()`
  //     on an already-playing video is a cheap no-op.
  //
  // Body is a string to dodge the bundler __name() wrapper that breaks
  // page.evaluate-style serialization.
  const cssLiteral = JSON.stringify(
    `@keyframes __loom_morph_heartbeat__ { 0% { transform: translate3d(0,0,0) } 50% { transform: translate3d(0.5px,0,0) } 100% { transform: translate3d(0,0,0) } }\n` +
      `[data-loom-morph="heartbeat"] { position: fixed; top: 0; left: 0; width: 2px; height: 2px; pointer-events: none; z-index: 2147483647; background: rgba(0,0,0,0.01); will-change: transform; animation: __loom_morph_heartbeat__ 32ms linear infinite; }`,
  );
  return `
    (() => {
      const css = ${cssLiteral};
      // Track videos we've already kicked. Calling .play() repeatedly on
      // the same element spawns orphan promises and can stall the
      // compositor on busy pages.
      const kicked = new WeakSet();
      const playAllVideos = () => {
        try {
          const videos = document.querySelectorAll('video');
          for (let i = 0; i < videos.length; i++) {
            const v = videos[i];
            if (kicked.has(v)) continue;
            kicked.add(v);
            try {
              // Mark muted/playsinline so autoplay restrictions can't
              // block us even on browsers that ignore the launch flag.
              v.muted = true;
              v.setAttribute('muted', '');
              v.setAttribute('playsinline', '');
              const p = v.play();
              if (p && typeof p.catch === 'function') {
                p.catch(() => {
                  // Retry once: some videos reject on the first call
                  // because metadata hasn't loaded, then accept on the
                  // 'loadedmetadata' event.
                  v.addEventListener('loadedmetadata', () => {
                    const retry = v.play();
                    if (retry && typeof retry.catch === 'function') retry.catch(() => {});
                  }, { once: true });
                });
              }
            } catch (e) {}
          }
        } catch (e) {}
      };
      const inject = () => {
        const target = document.head || document.documentElement;
        if (!target) return false;
        const style = document.createElement('style');
        style.setAttribute('data-loom-morph', 'heartbeat-style');
        style.textContent = css;
        target.appendChild(style);
        const ensureHeartbeat = () => {
          if (!document.body) return false;
          if (document.querySelector('[data-loom-morph="heartbeat"]')) return true;
          const beat = document.createElement('div');
          beat.setAttribute('data-loom-morph', 'heartbeat');
          document.body.appendChild(beat);
          return true;
        };
        if (!ensureHeartbeat()) {
          const bodyObs = new MutationObserver(() => {
            if (ensureHeartbeat()) bodyObs.disconnect();
          });
          bodyObs.observe(document.documentElement, { childList: true, subtree: true });
        }
        return true;
      };
      if (!inject()) {
        const obs = new MutationObserver(() => { if (inject()) obs.disconnect(); });
        obs.observe(document, { childList: true, subtree: true });
      }
      // Video kicker. Fire on initial mount + on every DOM mutation so
      // SPA route changes and lazy-mounted videos also get force-played.
      // Also fires when visibility changes — some pages pause on
      // visibilitychange and our flag tells them we're always visible.
      const startVideoObserver = () => {
        playAllVideos();
        const videoObs = new MutationObserver(playAllVideos);
        videoObs.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
        });
        document.addEventListener('visibilitychange', playAllVideos);
      };
      if (document.body) {
        startVideoObserver();
      } else {
        const bodyWait = new MutationObserver(() => {
          if (document.body) {
            bodyWait.disconnect();
            startVideoObserver();
          }
        });
        bodyWait.observe(document.documentElement, { childList: true, subtree: true });
      }
    })();
  `;
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
