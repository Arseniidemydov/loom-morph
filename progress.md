# Progress Log

A running log of work on Loom Morph. Each entry: what was started, what was finished, and any notable decisions or blockers. Most recent at the top.

Format:
- **[YYYY-MM-DD] STARTED: <thing>** — context, scope
- **[YYYY-MM-DD] FINISHED: <thing>** — outcome, follow-ups

---

## 2026-04-28

- **STARTED: Project planning & architecture.** Greenfield directory, scoping the build.
- **FINISHED: Architecture & implementation plan.** Wrote [PLAN.md](PLAN.md) covering: final goal, user flow, single-process Next.js architecture, FFmpeg filter graph (pan + circular overlay + audio mix), concurrency model (6-wide capture pool, 8-wide render pool), failure handling, anti-bot strategy, and a four-phase build plan (~1.5-2 weeks to v1).
- **FINISHED: Set up progress log.** This file. Updated each time work starts/finishes.
- **STARTED: Multi-agent coordination layer (Lead Agent role).** Setting up `/ai/` to enforce branch-per-task isolation, locked interfaces, and a merge queue.
- **FINISHED: `/ai/` coordination scaffold.** Created [TASKS.md](ai/TASKS.md) (5 task contracts: scaffolding → capture/render/orchestrator → CLI spike), [DECISIONS.md](ai/DECISIONS.md) (D-001 through D-011, locking the architecture from PLAN.md), [INTERFACES.md](ai/INTERFACES.md) (directory layout, full shared-type surface, capture/render/orchestrator contracts, SQLite schema, dependency manifest), [MERGE_QUEUE.md](ai/MERGE_QUEUE.md) (empty), [BLOCKERS.md](ai/BLOCKERS.md) (B-001 git not initialized, B-002 ffmpeg confirm, B-003 Playwright install confirm).

- **STARTED: TASK-001 — project scaffolding & shared types.** Branch `chore/scaffolding`.
- **FINISHED: TASK-001.** `package.json` (deps installed), `tsconfig.json` (strict + `noImplicitOverride` + `@/*` paths), `next.config.mjs` placeholder, `.gitignore` / `.editorconfig` / `.nvmrc`, `src/types/index.ts` (full shared surface from INTERFACES.md), `src/lib/{csv,url,storage}.ts` stubs, `scripts/generate-mask.ts` + `scripts/tsconfig.json`, `tests/fixtures/{capture,render}/.gitkeep`, `README.md`. Acceptance: `npm run typecheck` green; `npm run generate-mask` produces three RGBA PNGs in `public/` with correct alpha. Two mid-flight corrections recorded in coordination docs:
  - **D-012** added `sharp` to the dependency manifest (was missing despite `generate-mask.ts` requiring it).
  - `CaptureError.cause` carries `override` to satisfy `noImplicitOverride`; INTERFACES.md updated to match.
- **RESOLVED B-001:** repo was initialized; on branch `chore/scaffolding` with the coordination scaffold commit. Moved to the resolved archive in `ai/BLOCKERS.md`.

- **STARTED: TASK-004 — orchestrator + SQLite state.** Branch `feature/orchestrator-state` (off `chore/scaffolding`).
- **FINISHED: TASK-004.** `src/db/{schema.sql,migrations.ts,client.ts}` (better-sqlite3 wrapper, in-memory tests / WAL on disk), `src/orchestrator/{pool.ts,events.ts,orchestrator.ts}` (p-limit-backed pool, async event channel, `BatchOrchestrator` with capture+render pools, retry policy, per-lead failure isolation), `vitest.config.ts`. 22/22 tests green: db CRUD, pool concurrency caps, event ordering & emit-after-close, orchestrator happy path / partial failure / all-fail / capture retry on timeout / no retry on bot-blocked / capture-pool cap honored / filename template + fallback. Two contract extensions vs. the original INTERFACES.md, both recorded:
  - **D-013** — added `@types/better-sqlite3` to dev deps.
  - **D-014** — `OrchestratorDeps.paths` is required; orchestrator stays decoupled from `src/lib/storage.ts`.

- **MERGED:** `chore/scaffolding` → `main` (`5385699`), `feature/orchestrator-state` → `main` (`0e97f85`). Both fast-forward.
- **RESOLVED B-002:** `ffmpeg` 8.1 installed via Homebrew (`/opt/homebrew/bin/ffmpeg`).
- **RESOLVED B-003:** `npx playwright install chromium` succeeded.
- **STARTED: TASK-003 — render worker.** Branch `feature/pipeline-render`.
- **FINISHED: TASK-003.** `src/pipeline/filter-graph.ts` (pure `buildFilterGraph` + `buildFfmpegArgs`; smoothstep pan, four corner overlays, four audio paths, circle alpha via pre-generated mask), `src/pipeline/render.ts` (spawns ffmpeg, streams stderr, last-50 tail on non-zero exit, optional kill timer). 36/36 vitest green including real-ffmpeg integration: produces 1280×720 H.264 yuv420p MP4 with valid AAC stream when MP3 is supplied. **D-015** recorded: `RenderConfig.hasAudioTrack` → `audioMp3Present` so the four audio paths are decidable.

- **MERGED:** `feature/pipeline-render` → `main` (`e412c03`).
- **STARTED: TASK-002 — capture worker.** Branch `feature/pipeline-capture`.
- **FINISHED: TASK-002.** `src/pipeline/capture.ts` (lazy Chromium via playwright-extra + stealth, FIFO context pool default 6 with 20-job recycling, viewport 1280×800, networkidle goto with 30s timeout, bot-wall short-circuit on 403 or interstitial fingerprints, cookie-CSS injection, top→bottom→top auto-scroll, fullPage screenshot, 16k height cap via `sharp.extract` post-crop). `src/pipeline/cookie-selectors.ts` static selector list. 7/7 capture tests green (incl. 5 real-Chromium integration tests against a local fixture HTTP server). 43/43 across the full suite. Two debug findings worth recording:
  - tsx/vite/esbuild wrap named/const-assigned arrows with `__name(...)` calls — those don't exist when Playwright serializes the body for `page.evaluate`. Worked around by passing string-form bodies to `page.evaluate` for the two browser-side scripts.
  - Playwright's `clip` clips within the viewport unless paired with `fullPage:true`, and the two aren't reliably co-permitted. Switched to "fullPage screenshot, then `sharp.extract` post-crop" when the page exceeds 16k px.

### Next up
- Human review/merge of `feature/pipeline-capture` (entry in [`ai/MERGE_QUEUE.md`](ai/MERGE_QUEUE.md)).
- TASK-005 (Phase 1 CLI spike) — wires capture + render via `src/cli/spike.ts` and a concrete `OrchestratorPaths` backed by `src/lib/storage.ts`. Smoke-test against ≥3 real websites.
