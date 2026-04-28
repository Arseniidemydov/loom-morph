# Interfaces

Contracts between modules. **Any change requires Lead Agent approval and a corresponding entry in `/ai/DECISIONS.md`.**

This file is the source of truth for module boundaries. Implementation agents implement these contracts exactly — naming, signatures, semantics. If a contract is wrong, raise it in `/ai/BLOCKERS.md`; do not deviate silently.

---

## Directory layout (LOCKED)

```
loom-morph/
├── ai/                            # coordination (this folder)
├── PLAN.md                        # architecture & implementation plan
├── progress.md                    # work log
├── package.json
├── package-lock.json
├── tsconfig.json
├── next.config.mjs
├── .gitignore
├── .nvmrc
├── README.md
├── public/
│   └── circle-mask-{200|280|360}.png   # build artifacts (D-007)
├── scripts/
│   └── generate-mask.ts                # mask generator (one-time + on demand)
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── api/                   # API Agent (Phase 3)
│   │   └── (pages)/               # Frontend Agent (Phase 3)
│   ├── components/                # Frontend Agent (Phase 3)
│   ├── pipeline/
│   │   ├── capture.ts             # Capture Agent (TASK-002)
│   │   ├── cookie-selectors.ts    # Capture Agent
│   │   ├── render.ts              # Render Agent (TASK-003)
│   │   └── filter-graph.ts        # Render Agent (TASK-003)
│   ├── orchestrator/
│   │   ├── orchestrator.ts        # Orchestrator Agent (TASK-004)
│   │   ├── pool.ts
│   │   └── events.ts
│   ├── db/
│   │   ├── schema.sql             # Orchestrator Agent (TASK-004) — single writer
│   │   ├── client.ts
│   │   └── migrations.ts
│   ├── types/
│   │   └── index.ts               # SHARED — Lead Agent owns changes
│   ├── lib/                       # shared utilities (no business logic)
│   │   ├── csv.ts
│   │   ├── url.ts
│   │   └── storage.ts
│   └── cli/
│       └── spike.ts               # Phase 1 driver (TASK-005)
└── tests/
    └── fixtures/
        ├── capture/               # local HTML for capture tests
        └── render/                # PNG + circle media + MP3 for render tests
```

---

## Dependency manifest (LOCKED — see D-010)

Production:
- `next` (~14.x) — installed but no routes used until Phase 3
- `react`, `react-dom`
- `playwright` — browser automation
- `playwright-extra`, `puppeteer-extra-plugin-stealth` — anti-bot
- `better-sqlite3` — synchronous SQLite client
- `papaparse` — CSV parsing
- `archiver` — streaming ZIP (used in Phase 3)
- `p-limit` — concurrency-capped Promise pool
- `sharp` — image generation for the build-time circle mask script (D-012; not imported by runtime workers)

Dev:
- `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/papaparse`, `@types/archiver`, `@types/better-sqlite3` (D-013)
- `vitest` — test runner
- `@vitest/ui` (optional)
- `eslint`, `eslint-config-next`
- `prettier`

System:
- `ffmpeg` on PATH — not installed via npm. Document install in README (`brew install ffmpeg` on macOS, package manager on Linux).

**Adding anything else requires a new D-NNN decision in `/ai/DECISIONS.md` first.**

---

## Shared types (`src/types/index.ts`)

These types are the contract between pipeline workers and the orchestrator. Implementation agents must implement against these signatures exactly.

```ts
// ────────────────────── batch/lead config ──────────────────────

export type Resolution = '720p' | '1080p';

export interface VideoDimensions {
  width: number;
  height: number;
}

export const RESOLUTIONS: Record<Resolution, VideoDimensions> = {
  '720p':  { width: 1280, height: 720  },
  '1080p': { width: 1920, height: 1080 },
};

export type CirclePosition =
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type CircleSize = 'S' | 'M' | 'L';   // → 200 | 280 | 360 px

export const CIRCLE_PIXELS: Record<CircleSize, number> = {
  S: 200, M: 280, L: 360,
};

export interface BatchConfig {
  durationSec: number;          // default 30
  resolution: Resolution;       // default '1080p'
  circlePosition: CirclePosition;
  circleSize: CircleSize;
  circleMargin: number;         // px from edge, default 40
  filenameTemplate: string;     // e.g. "{company}.mp4", fallback "lead-{i}.mp4"
}

// ────────────────────── capture worker ──────────────────────

export interface CaptureInput {
  url: string;                  // pre-normalized to https://...
  outputPath: string;           // absolute path to write PNG
  contextPoolSize?: number;     // default 6
}

export interface CaptureResult {
  pngPath: string;
  width: number;                // px
  height: number;               // px (capped at 16000)
  capturedAtMs: number;         // Date.now()
  durationMs: number;
}

export type CaptureFailureReason =
  | 'timeout'
  | 'network'
  | 'bot-blocked'
  | 'page-crashed'
  | 'invalid-url'
  | 'unknown';

export class CaptureError extends Error {
  constructor(
    public reason: CaptureFailureReason,
    message: string,
    public override cause?: unknown,    // `override` required by tsconfig's noImplicitOverride
  ) { super(message); this.name = 'CaptureError'; }
}

export type CaptureFn = (input: CaptureInput) => Promise<CaptureResult>;

// ────────────────────── render worker ──────────────────────

export interface RenderJob {
  screenshotPath: string;
  screenshotHeight: number;     // for pan distance calculation
  circleSourcePath: string;     // image or video
  circleHasAudio: boolean;      // determines amix path
  audioPath?: string;           // optional MP3
  outputPath: string;
  config: BatchConfig;
}

export interface RenderConfig {
  // Subset of RenderJob used by the pure filter-graph builder.
  screenshotHeight: number;
  durationSec: number;
  resolution: Resolution;
  circlePosition: CirclePosition;
  circleSize: CircleSize;
  circleMargin: number;
  circleHasAudio: boolean;
  audioMp3Present: boolean;     // D-015 — separate flag so the four audio paths are decidable
}

export interface RenderResult {
  outputPath: string;
  durationMs: number;
}

export type RenderFailureReason =
  | 'ffmpeg-error'
  | 'missing-input'
  | 'timeout'
  | 'unknown';

export class RenderError extends Error {
  constructor(
    public reason: RenderFailureReason,
    message: string,
    public stderrTail?: string,
  ) { super(message); this.name = 'RenderError'; }
}

export type RenderFn = (job: RenderJob) => Promise<RenderResult>;

// ────────────────────── orchestrator ──────────────────────

export type LeadStatus =
  | 'pending'
  | 'capturing'
  | 'rendering'
  | 'done'
  | 'failed';

export interface LeadInput {
  rowIndex: number;
  website: string;              // pre-normalized
  csvData: Record<string, string>;
}

export interface LeadRecord extends LeadInput {
  id: string;
  batchId: string;
  status: LeadStatus;
  error?: string;
  outputPath?: string;
  captureMs?: number;
  renderMs?: number;
}

export interface BatchInput {
  id: string;
  config: BatchConfig;
  leads: LeadInput[];
  circleSourcePath: string;
  circleHasAudio: boolean;
  audioPath?: string;
}

export type BatchEvent =
  | { type: 'batch-started';  batchId: string; total: number }
  | { type: 'lead-status';    leadId: string; status: LeadStatus; error?: string }
  | { type: 'lead-completed'; leadId: string; outputPath: string }
  | { type: 'batch-completed'; batchId: string;
      summary: { done: number; failed: number; totalMs: number } };
```

---

## Capture worker contract

`src/pipeline/capture.ts` exports:

```ts
export const captureWebsite: CaptureFn;
export function shutdownCapturePool(): Promise<void>;
```

**Behavior:**
1. Lazy-init a single Chromium instance shared across calls.
2. Maintain a context pool of size `contextPoolSize` (default 6). Reuse contexts across calls; recycle each context after 20 successful captures.
3. Per call:
   - Acquire a context, open a new page.
   - `page.setViewportSize({ width: 1280, height: 800 })`.
   - `page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })`.
   - Inject CSS hiding cookie-banner selectors (list in `cookie-selectors.ts`).
   - Auto-scroll: `(0, scrollHeight)` in 200ms steps with 100ms waits, then back to `(0, 0)`.
   - Wait 1000ms for settle.
   - Screenshot full-page PNG to `outputPath`.
   - Close page (keep context).
4. Cap screenshot height at 16,000 px (truncate the captured page if taller).
5. Bot-wall detection: if response status 403 or page contains a known interstitial fingerprint, throw `CaptureError('bot-blocked', …)` immediately (no retry).
6. Retry policy (caller-side via orchestrator): 1 retry on `timeout` and `network`; 0 on `bot-blocked`.

---

## Render worker contract

`src/pipeline/render.ts` exports:

```ts
export const render: RenderFn;
```

`src/pipeline/filter-graph.ts` exports:

```ts
export function buildFilterGraph(config: RenderConfig): {
  filterComplex: string;        // value for -filter_complex
  videoMap: string;             // e.g. '[v]'
  audioMap?: string;            // e.g. '[a]', undefined if no audio
};

export function buildFfmpegArgs(job: RenderJob): string[];
```

**Filter graph spec (per D-006, D-007):**

For inputs `[0:v]` = screenshot, `[1:v|a]` = circle source, `[2:v]` = mask PNG, `[3:a]` = optional MP3:

```
[0:v] crop={W}:{H}:0:'({SH}-{H})*(t/{D})*(t/{D})*(3-2*(t/{D}))',
      scale={W}:{H}, setsar=1, fps=30 [bg];
[1:v] scale={C}:{C}:force_original_aspect_ratio=increase, crop={C}:{C} [c_raw];
[c_raw][2:v] alphamerge [circle];
[bg][circle] overlay={X}:{Y}:shortest=0 [v];
{audio mix path — see below}
```

Where:
- `W`, `H` = output width/height from `RESOLUTIONS[resolution]`
- `SH` = `screenshotHeight` (capped 16000)
- `D` = `durationSec`
- `C` = `CIRCLE_PIXELS[circleSize]`
- `X`, `Y` = corner-derived overlay coords using `circleMargin`

**Audio paths:**
- Circle has audio + MP3 → `[1:a][3:a] amix=inputs=2:duration=first:dropout_transition=0 [a]`
- Circle has audio only → `[1:a] anull [a]`
- MP3 only → `[3:a] anull [a]`
- Neither → no `[a]` map; pass `-an` to ffmpeg

**Output args:** `-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart -t {D}` plus the appropriate `-map` flags.

---

## Orchestrator contract

`src/orchestrator/orchestrator.ts` exports:

```ts
// Path resolver injected by the caller (D-014). The orchestrator stays free
// of filesystem-layout assumptions; CLI / API construct paths from src/lib/storage.ts.
export interface OrchestratorPaths {
  screenshotFor(batchId: string, leadId: string): string;
  outputFor(batchId: string, leadId: string, lead: LeadInput, filename: string): string;
}

export interface OrchestratorDeps {
  capture: CaptureFn;
  render: RenderFn;
  db: DbClient;
  paths: OrchestratorPaths;     // required (D-014)
  clock?: () => number;
  capturePoolSize?: number;     // default 6
  renderPoolSize?: number;      // default min(cpus, 8)
  retries?: { capture: number };// default { capture: 1 }
  uuid?: () => string;          // override for deterministic tests
}

export class BatchOrchestrator {
  constructor(deps: OrchestratorDeps);
  runBatch(batch: BatchInput): AsyncIterable<BatchEvent>;
}
```

**Semantics:**
- Per-lead failures never abort the batch.
- Capture and render run in independent pools — a lead transitions to render as soon as its capture completes; slow captures don't starve the render pool.
- Status writes to SQLite happen on every transition; the SSE/CLI consumer reads from events, not the DB.
- `runBatch` always emits `batch-started` first and `batch-completed` last, even if all leads fail.

---

## SQLite schema (`src/db/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,                -- pending | running | done | failed
  config_json TEXT NOT NULL,                -- BatchConfig serialized
  total       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  row_index     INTEGER NOT NULL,
  website       TEXT NOT NULL,
  csv_data_json TEXT NOT NULL,              -- Record<string,string>
  status        TEXT NOT NULL,
  error         TEXT,
  output_path   TEXT,
  capture_ms    INTEGER,
  render_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_leads_batch ON leads(batch_id);
```

`src/db/client.ts` exports a thin wrapper:

```ts
export interface DbClient {
  insertBatch(b: BatchInput): void;
  insertLeads(leads: LeadRecord[]): void;
  updateLeadStatus(leadId: string, status: LeadStatus, error?: string): void;
  updateLeadResult(leadId: string, output: string, captureMs: number, renderMs: number): void;
  finishBatch(batchId: string, status: 'done' | 'failed'): void;
  getBatch(batchId: string): BatchRecord | null;
  getLeads(batchId: string): LeadRecord[];
  close(): void;
}
```

---

## Storage layout (filesystem)

```
{repoRoot}/
  uploads/{batchId}/leads.csv | circle.{ext} | audio.mp3
  tmp/{batchId}/{leadId}.png        # cleared after batch
  output/{batchId}/{filename}.mp4   # retained
  output/{batchId}/report.csv       # generated on batch finish
  data/loom-morph.sqlite            # the SQLite DB
```

`src/lib/storage.ts` provides `pathFor.upload`, `pathFor.tmp`, `pathFor.output`, etc. — never hard-code paths in workers.

---

## Environment variables

Phase 1: none required.

Phase 3 (TBD, will be added before that phase starts):
- `LOOM_MORPH_DATA_DIR` — override default storage root
- `LOOM_MORPH_FFMPEG_PATH` — override `ffmpeg` discovery
- `LOOM_MORPH_BASIC_AUTH` — `user:pass` for Phase 4 hosted mode

---

## Versioning

This file has no version number; changes are tracked by `git log`. Substantive changes must reference a `D-NNN` decision in their commit message.
