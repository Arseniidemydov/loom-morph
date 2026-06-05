# CLAUDE.md

Guidance for working in this repo. Keep it accurate — update it when the
architecture changes.

## What this is

**Loom Morph** turns a CSV of leads into personalized videos. For each lead it
captures that lead's website, composites a circular "talking-head" overlay
(image or video, with optional narration audio) on top, and renders an MP4.
It's a Next.js 14 (App Router) app with an in-process batch orchestrator —
single process, SQLite state, local-disk output. No external DB/queue/cloud
storage.

## Capture modes (this drives most behavior + performance)

- **`screenshot`** (default): Playwright screenshots the page, ffmpeg pans over
  the still. Fast, parallel-friendly. CPU-bound on the ffmpeg render.
- **`recording`**: Playwright records the live page as WebM in near real-time
  (hero videos, animations play). Much slower — per-lead wall time is dominated
  by real-time capture + bounded readiness waits. Needs **real Google Chrome**
  (bundled Chromium lacks H.264 → frozen hero videos). Parallelizes across
  browser contexts (each `recordWebsite` call gets its own `recordVideo`
  context), so throughput scales with concurrency until RAM/CPU saturate.

## Architecture / where things live

- **UI**: [src/app](src/app) (App Router). Main components:
  [batch-workbench.tsx](src/components/batch-workbench.tsx) (config + run),
  [batch-history-panel.tsx](src/components/batch-history-panel.tsx) (past batches).
- **API**: [src/app/api/batches](src/app/api/batches) — `GET/POST /api/batches`,
  `[batchId]` (snapshot/rename/delete), `[batchId]/events` (SSE live progress),
  `/report` (CSV), `/archive` (ZIP), `/videos/[leadId]` (ranged MP4 stream).
- **Engine**: [src/lib/engine.ts](src/lib/engine.ts) — `runBatch()` is the entry
  point. Probes audio/duration ONCE per batch, wires capture/render fns by mode,
  constructs the orchestrator.
- **Orchestrator**: [src/orchestrator/orchestrator.ts](src/orchestrator/orchestrator.ts)
  — two `p-limit` pools (capture, render; [pool.ts](src/orchestrator/pool.ts)),
  per-lead state transitions, events. Calls the extracted pipeline core.
- **Per-lead pipeline core**: [src/worker/process-lead.ts](src/worker/process-lead.ts)
  — capture → render with in-process retries, dependency-injected (no pools/DB/
  events baked in). Reusable outside the orchestrator.
- **Pipeline stages**: [capture.ts](src/pipeline/capture.ts) (screenshot mode),
  [record.ts](src/pipeline/record.ts) (recording mode + readiness/wait budgets),
  [render.ts](src/pipeline/render.ts) (spawns ffmpeg),
  [filter-graph.ts](src/pipeline/filter-graph.ts) (builds the ffmpeg filter graph
  + encoder args: libx264, preset medium, crf 23).
- **Filename templating**: [src/lib/render-filename.ts](src/lib/render-filename.ts).
- **State (SQLite)**: [src/db/client.ts](src/db/client.ts) (`DbClient` interface +
  better-sqlite3 impl), [schema.sql](src/db/schema.sql),
  [migrations.ts](src/db/migrations.ts). DB lives at `{root}/data/loom-morph.sqlite`.
- **Paths/storage**: [src/lib/storage.ts](src/lib/storage.ts) — `createPaths()`,
  root = `LOOM_DATA_ROOT` env or `process.cwd()`. Outputs in `{root}/output`.
- **Read-only snapshots**: [src/lib/snapshot.ts](src/lib/snapshot.ts) (used by
  read API routes). **Live events**: [src/lib/batch-registry.ts](src/lib/batch-registry.ts)
  (in-memory, feeds SSE; dies with the process).
- **Auth**: [src/middleware.ts](src/middleware.ts) — Basic Auth over UI + API,
  active only when `BASIC_AUTH_USER` + `BASIC_AUTH_PASSWORD` are both set.
- **Types**: [src/types/index.ts](src/types/index.ts) (start here for data shapes).
- **CLI**: [src/cli/run.ts](src/cli/run.ts) (`npm run batch`),
  [src/cli/spike.ts](src/cli/spike.ts) (single-URL smoke test).

## Commands

```bash
npm run dev         # Next dev server
npm run build       # production build (runs next lint — lint errors FAIL the build)
npm run start       # production server (used for local + Docker)
npm run typecheck   # tsc --noEmit
npm run test        # vitest; many tests are REAL integration (Chromium + ffmpeg), slow
npm run batch -- ... # CLI batch runner
```

Note: `src/pipeline/__tests__/record.test.ts` has a pre-existing flaky
afterAll/teardown hook timeout — the tests themselves pass; the suite is marked
failed only on teardown. Not a regression signal.

## External dependencies (must be on the host)

- **ffmpeg** on `PATH` (render).
- **Google Chrome** (recording mode H.264 hero videos). Falls back to bundled
  Chromium with a logged warning if absent.
- Native node modules: `better-sqlite3`, `sharp` — recompile after a Node
  version change (`npm rebuild better-sqlite3`).

## Environment variables

| Var | Purpose |
|---|---|
| `LOOM_CAPTURE_CONCURRENCY` | concurrent captures/recordings (default 5) |
| `LOOM_RENDER_CONCURRENCY` | concurrent ffmpeg encodes (default `min(cpus-1,5)`) |
| `LOOM_DATA_ROOT` | relocate ALL state (SQLite/uploads/tmp/output) under one dir |
| `LOOM_CONTAINER` | `1` adds container Chrome flags (`--no-sandbox`, `--disable-dev-shm-usage`) — set by the Dockerfile, not on macOS |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | enable Basic Auth (both required) |

Concurrency is RAM-bound on capture (~1.5–2 GB per recording) and CPU-bound on
render. Tune to the machine. Local dev defaults live in `.env.local` (gitignored).

## Deployment

This is a stateful, long-running, CPU-heavy app — **not** serverless/Vercel.
Run it as one persistent process on a machine with a real disk:
- **Local** (Mac/Linux): `npm run build && npm run start`. Best for solo use.
- **Container / VM**: [Dockerfile](Dockerfile) (Linux + Chrome + ffmpeg + fonts)
  + [DEPLOY.md](DEPLOY.md) (sizing, Render one-disk model, env).
- A distributed worker-fleet design exists but is deferred (see the plan file
  referenced in DEPLOY.md / project memory).

## Conventions

- TypeScript strict. Path alias `@/` → `src/`.
- Keep filesystem/DB/concurrency assumptions OUT of the pipeline stages and
  `process-lead.ts` — inject them (the orchestrator and any future worker pass
  their own). This is the seam that keeps the core reusable.
