# Loom Morph — Implementation Plan & Architecture

## What We're Building

A web tool that turns a CSV of leads into a batch of personalized "Loom-style" outreach videos. For each row, the tool captures the lead's website, animates a smooth scroll through it, overlays a Loom-style circular bubble (your image or a recorded talking-head video) in the corner, optionally mixes in a shared MP3 narration, and outputs a downloadable MP4. Up to ~100 videos per batch, processed in parallel on a single machine.

### Why this exists

SDRs and founders today record outreach Looms one prospect at a time — a 30-second video × 100 leads = hours of repetitive recording, and most of those videos look nearly identical aside from the website on screen. This tool collapses that workflow to: **record yourself once, drop in a CSV, get 100 personalized videos in ~10 minutes**.

### What this is NOT

- Not a creative video editor (no timeline, no clips, no transitions library).
- Not a Loom replacement — Looms are recorded interactively; these are generated.
- Not a CRM. CSV in, MP4s out. Sending the videos is the user's problem.

The product is a **pipeline**, not an editor. Personalization comes from the per-lead website; the user gets minimal creative controls (circle position/size, video duration, resolution).

---

## User Flow

1. **Upload CSV.** `website` (or `url`) column required. Any other columns (`name`, `company`, etc.) are passed through and usable in filename templates.
2. **Upload circle source.** Image (PNG/JPG) or video (MP4/MOV/WebM). This is your "face bubble."
3. **Optionally upload MP3.** Shared narration applied to every video in the batch.
4. **Configure:**
   - Duration (default 30s)
   - Resolution (720p or 1080p)
   - Circle position (4 corners) and size (S/M/L → 200/280/360 px)
   - Filename template (e.g. `{company}.mp4`, falls back to `lead-{i}.mp4`)
5. **Start batch.** Backend kicks off the pipeline.
6. **Watch live progress.** Per-lead status: `pending → capturing → rendering → done | failed`. Failed leads show a reason.
7. **Download.** Individual MP4s, or a ZIP of all videos + a `report.csv` with status per row.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Next.js app (single Node process)                              │
│                                                                │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────┐    │
│  │ React UI │───▶│ API routes   │───▶│ Job orchestrator   │    │
│  └──────────┘    └──────────────┘    └─────┬──────────────┘    │
│       ▲                                    │                   │
│       │ SSE (progress)                     ▼                   │
│       │                          ┌──────────────────────┐      │
│       └──────────────────────────│ SQLite (batch state) │      │
│                                  └──────────────────────┘      │
│                                                                │
│  Worker pools (in-process Promise queues):                     │
│   • Capture pool (Playwright) ─▶ /tmp/{batch}/{lead}.png       │
│   • Render pool (FFmpeg)     ─▶  /output/{batch}/{lead}.mp4    │
│                                                                │
│  Shared inputs per batch (uploaded once):                      │
│   /uploads/{batch}/circle.{ext}, audio.mp3, leads.csv          │
└────────────────────────────────────────────────────────────────┘
```

### Why single-process

No separate worker service, no Redis, no message broker. Reasoning:

- v1 target is one machine, ~100 videos/batch. In-process Promise pools with concurrency caps are sufficient.
- One process means simpler deploy, no IPC, no queue serialization, easy local dev.
- SQLite (via `better-sqlite3`) is synchronous and zero-config — handles all the state we need.
- Migration path to BullMQ + Redis is trivial if we ever need it (the orchestrator interface stays the same).

This is a deliberate "boring tech, ship in a week" choice. We can complicate it later when there's a reason.

---

## The Core Pipeline (per lead)

```
website URL
    │
    ▼
┌─────────────────────────────────────────┐
│ Capture stage (Playwright)              │
│  • New browser context from pool        │
│  • goto(url, { waitUntil: 'networkidle'})│
│  • Inject CSS to hide cookie banners    │
│  • Auto-scroll top→bottom→top to        │
│    trigger lazy loading                 │
│  • page.screenshot({ fullPage: true })  │
│  • Return PNG + dimensions              │
└─────────────────────────────────────────┘
    │
    ▼  /tmp/{batch}/{lead}.png  (e.g., 1920 × 8000)
    │
    ▼
┌─────────────────────────────────────────┐
│ Render stage (single FFmpeg invocation) │
│ Inputs:                                 │
│   [0] screenshot.png                    │
│   [1] circle source (image or video)    │
│   [2] circle-mask.png (pre-generated)   │
│   [3] audio.mp3 (optional)              │
│ Filter graph: pan + circular crop +     │
│   overlay + audio mix (see below)       │
│ Output: MP4 H.264 + AAC, 30fps          │
└─────────────────────────────────────────┘
    │
    ▼  /output/{batch}/{filename}.mp4
```

### The FFmpeg filter graph (the only genuinely tricky engineering)

For a 1920×1080 output, 30s duration, screenshot of height H, circle at bottom-right:

```
[0:v] crop=1920:1080:0:'(H-1080)*(t/30)*(t/30)*(3-2*(t/30))',
      scale=1920:1080,
      setsar=1,
      fps=30 [bg];

[1:v] scale=280:280:force_original_aspect_ratio=increase,
      crop=280:280 [circle_raw];

[circle_raw][2:v] alphamerge [circle];

[bg][circle] overlay=W-w-40:H-h-40:shortest=0 [v];

[1:a][3:a] amix=inputs=2:duration=first:dropout_transition=0 [a]
```

Notes:

- **Pan expression** uses `smoothstep` easing: `(t/D) * (t/D) * (3 - 2*(t/D))`. Constant pan looks robotic; this gives a subtle ease-in/ease-out over the full duration. `H` and `D` are baked in per-job.
- **Pan distance scales to page height.** Tall page = the camera moves further in the same time, so it pans faster. Short page = slow gentle pan. Both finish at the same duration, which is the only way the audio stays in sync.
- **Circle mask** is a pre-generated PNG (one-time build artifact): a square with a transparent outside and opaque inside circle. `alphamerge` punches the circle shape out of the resized circle source. This is faster than computing the mask per-frame with `geq`.
- **Circle audio + MP3 mix.** If the circle is a talking-head video with audio AND there's a background MP3, `amix` blends them. If only one is present, drop the other input. If neither, output silent.
- **`shortest=0`** on overlay means the circle video, if shorter than the scroll, will hold on its last frame (we'll add `loop` filter if user wants it to loop).
- Single FFmpeg process per video — no intermediate files. Enables maximum parallelism.

### What runs in parallel, and what doesn't

Per-lead jobs are independent — no shared state during processing, only at write-back time (status update in SQLite).

**Capture pool: 6 concurrent Playwright contexts.** Browser launch is expensive (~500ms); contexts are cheap. Launch one Chromium with 6 contexts, reuse across jobs, recycle every 20 jobs to bound memory.

**Render pool: `min(cpuCount, 8)` concurrent FFmpeg processes.** H.264 encode of a 30s 1080p clip takes ~5–15s on a modern core. FFmpeg is CPU-pinned per process so there's no benefit beyond core count.

**Pipeline staging.** Capture and render run as independent pools. A lead can be rendering while another is still capturing — the orchestrator hands off each lead to the render pool as soon as its screenshot is on disk. Slow-loading sites don't starve the encoder.

### Realistic batch timing (100 leads, 16-core machine)

| Stage | Per-lead | 100 leads at concurrency |
|---|---|---|
| Capture | 5–15s (network-bound) | 1.5–4 min @ 6-wide |
| Render | 5–15s (CPU-bound) | 1–3 min @ 8-wide |
| Total wall time | — | **~5–10 min**, stages overlap |

This is well within "kick it off, grab coffee" territory. No need for distribution.

---

## Components in Detail

### 1. CSV ingestion
- Parse with `papaparse`. Trim whitespace, lowercase header keys.
- Validate that `website` or `url` exists. Coerce to a column named `website`.
- Normalize URLs: prepend `https://` if missing scheme. Reject obviously invalid (no TLD).
- Skip blank rows. Record reason in report.
- Cap at 100 leads per batch (configurable; protects from accidental 10k uploads).

### 2. Capture worker (Playwright)
- One persistent `chromium.launch()` per process.
- Context pool of 6, each created with `viewport: { width: 1280, height: 800 }`, realistic UA, `deviceScaleFactor: 1` (we'll upscale at render).
- `playwright-extra` + stealth plugin to handle basic bot detection.
- Per-job sequence:
  1. `context.newPage()`
  2. `page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })`
  3. Inject CSS: `display: none !important` on a known list of cookie banner selectors (OneTrust, CookieYes, Cookiebot, generic `[id*="cookie"]`, `[class*="consent"]`)
  4. Auto-scroll: `window.scrollTo(0, document.body.scrollHeight)` in 200ms steps with 100ms waits, then back to 0. This triggers lazy loaders, image loads, intersection observers.
  5. Wait 1s for settle.
  6. `page.screenshot({ fullPage: true, type: 'png' })`
  7. Return PNG buffer + dimensions
  8. `page.close()` (keep context for reuse)
- Retries: 1 retry on timeout/network error. 0 retries on `ERR_BLOCKED_BY_CLIENT` (bot wall — won't help).
- Recycle context every 20 successful jobs to bound memory.

### 3. Render worker (FFmpeg)
- Spawn `ffmpeg` as a child process per job, no fluent-ffmpeg wrapper — just construct the arg array.
- Filter graph as above, parameters injected per job (page height, duration, circle position).
- Stream stderr for progress (FFmpeg emits `frame=N` lines), update SQLite every ~1s.
- On non-zero exit, capture last 50 lines of stderr for the failure report.

### 4. Job orchestrator
- A simple class with two `Promise` pools (capture, render) using `p-limit` or hand-rolled.
- Reads pending leads from SQLite, dispatches to capture pool.
- On capture success → enqueue to render pool.
- On any stage failure → mark lead failed with reason, continue with rest.
- Emits events to an EventEmitter; SSE handler subscribes.

### 5. Web UI
- Next.js App Router, server components for the batch list, client components for upload + live progress.
- Shadcn/ui for the basic primitives (form, button, table, progress bar) — fast to ship, no design debt.
- Live progress via SSE (`/api/batches/:id/events`). Simpler than WebSocket, and we only need one-way server→client.
- Per-batch page shows a table: row, website, status, duration, download button. ZIP button at top once batch is done.

### 6. Storage layout
```
/uploads/{batchId}/
  leads.csv
  circle.{ext}
  audio.mp3
/tmp/{batchId}/
  {leadId}.png         (intermediate, deleted after render)
/output/{batchId}/
  {filename}.mp4       (the deliverable)
  report.csv           (status per lead, generated on batch finish)
```

`/tmp` is cleared after each batch (or kept for debugging via a setting). `/output` is retained until the user deletes the batch.

### 7. State (SQLite)
Three tables. Schema sketch:

```sql
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  status TEXT,            -- pending | running | done | failed
  config_json TEXT,       -- duration, resolution, circle pos, etc.
  created_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  row_index INTEGER,
  website TEXT,
  csv_data_json TEXT,     -- all other CSV columns for filename templating
  status TEXT,            -- pending | capturing | rendering | done | failed
  error TEXT,
  output_path TEXT,
  capture_ms INTEGER,
  render_ms INTEGER
);

CREATE INDEX idx_leads_batch ON leads(batch_id);
```

No need for migrations tooling at this scale — just a single `init.sql` run on startup.

---

## Failure Handling

Per-lead failures are isolated. The batch never fails as a whole; it just produces a report with a mix of completed and failed leads.

| Failure | Action |
|---|---|
| URL malformed | Skip at CSV parse, mark failed with reason |
| `goto` timeout | 1 retry, then fail with "site too slow" |
| Network error | 1 retry, then fail with original error |
| Bot wall (Cloudflare interstitial detected) | Fail immediately with "bot-blocked"; retry won't help |
| Page crash | Recreate context, retry once |
| Screenshot too tall (e.g. >32k pixels — pathological infinite-scroll page) | Cap height at 16k, log warning |
| FFmpeg non-zero exit | Capture stderr tail, fail with that as reason |
| Disk full | Halt batch, surface error to UI |

The `report.csv` includes status, duration per stage, and error reason — enough for the user to manually retry or skip rows.

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20+ | Single language across UI, API, workers |
| Web framework | Next.js (App Router) | UI + API in one process, good DX, easy deploy |
| UI | React + Tailwind + shadcn/ui | Ship-fast primitives without design debt |
| Browser automation | Playwright + playwright-extra (stealth) | Best-in-class for headless capture |
| Video processing | FFmpeg (system binary, called via `child_process`) | One filter graph does the whole job |
| State | SQLite via `better-sqlite3` | Zero-config, synchronous, sufficient |
| File storage | Local filesystem | One machine, no need for object storage in v1 |
| CSV | `papaparse` | Robust, handles weird CSVs |
| ZIP streaming | `archiver` | Stream-based, no memory blow-up on big ZIPs |
| Progress channel | SSE | Simpler than WebSocket; one-way is all we need |

System dependencies: `ffmpeg`, Chromium (auto-installed by Playwright). Both available on macOS via Homebrew, on Linux via package manager.

---

## Anti-Bot Strategy

This will be the #1 source of real-world capture failures. Plan, in priority order:

1. **`playwright-extra` + stealth plugin.** Removes the obvious headless tells. Free, gets us most of the way.
2. **Realistic browser config.** Default Chrome UA, 1280×800 viewport, `deviceScaleFactor: 1`, en-US locale.
3. **Cookie banner CSS injection.** A static list of selectors to hide, refreshed periodically.
4. **Hard fail fast on bot walls.** If we detect Cloudflare's "Checking your browser" or DataDome challenge, mark failed immediately — retries won't help and waste time.
5. **NOT IN v1: residential proxies.** They'd cut failure rate further but add cost and complexity. Ship without, measure real failure rate, decide.

Realistic expectation: **5–15% capture failure rate** in v1 on a typical B2B lead list. The user can re-run failed rows manually or upload a cleaner list.

---

## Phased Implementation Plan

### Phase 1 — End-to-end spike (CLI, hardcoded inputs)
**Goal:** prove the FFmpeg filter graph and capture flow work for one URL.
- Single Node script: takes a URL, circle image, optional MP3 → produces an MP4.
- No CSV, no UI, no concurrency.
- Validate output looks right at 720p and 1080p.
- Tune the easing and circle position defaults until the result actually looks like a Loom.

**Done when:** one URL → one acceptable-looking MP4. ~1-2 days.

### Phase 2 — Batch core
**Goal:** scale phase 1 to a CSV, with parallelism.
- CSV parser, lead normalization.
- Job orchestrator with capture and render pools.
- SQLite state, status tracking.
- CLI driver: `loom-morph run leads.csv --circle face.mp4 --audio narration.mp3`.
- Output directory + `report.csv`.

**Done when:** 100 leads end-to-end in <15 min on a dev machine, with per-lead failure isolation. ~2-3 days.

### Phase 3 — Web UI
**Goal:** make it usable without a terminal.
- Upload form (CSV, circle, MP3, settings).
- Batch list page.
- Batch detail page with live SSE progress.
- Download endpoints (single file + streaming ZIP).

**Done when:** non-technical user can drive a batch start to finish in a browser. ~3-4 days.

### Phase 4 — Polish & robustness
- Stealth plugin integration, cookie-banner injection.
- Retry-failed-only action.
- Better filename templating UI (preview before run).
- Optional: basic auth if hosted publicly.
- Optional: text overlays from CSV columns (`{name}` drawn over the video).

**Cumulative timeline:** ~1.5-2 weeks of focused work to a usable v1.

---

## Open Considerations & Future Work

- **Text overlays from CSV.** Personalizing with `Hi {name}` text that fades in/out is high-leverage and easy with FFmpeg `drawtext`. Defer to v2 because it complicates the UI.
- **Per-lead audio/circle.** Today's spec is per-batch. If users start asking for per-lead, the schema already supports it (CSV could reference asset paths).
- **Hosted multi-user.** v1 is single-user. Adding accounts means: auth, isolated storage per user, quota limits, billing. That's a separate product decision, not engineering scope.
- **Larger batches (1000+).** Single machine starts hurting beyond ~500. At that point: BullMQ + Redis + a worker fleet, S3 for storage. The orchestrator interface stays the same.
- **Output formats.** Right now MP4/H.264. Some platforms (e.g. LinkedIn) prefer specific specs — could add presets.
- **Detection of "good" rest points in the page.** Instead of a constant pan, pause briefly at section breaks. Requires analyzing the screenshot for visual rhythm. Cool but not a v1 problem.

---

## Definition of Done for v1

A user can:
1. Drop a 100-row CSV into a web form.
2. Upload a 30-second talking-head video and an MP3.
3. Click start, watch progress, and 10 minutes later download a ZIP of 100 personalized MP4s.
4. See which rows failed and why, in a `report.csv`.

Everything else is v2.
