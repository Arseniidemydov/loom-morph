# Tasks

Active task contracts for the Loom Morph build. The Lead Agent owns this file. Implementation agents read it before coding and update only their own task's status.

**Status values:** `proposed | ready | in-progress | review | merged | blocked`

**Format:** Each task is a contract — agent name, branch, allowed/forbidden files, acceptance criteria, etc. Don't shortcut. If a task contract is wrong, raise it to Lead before starting.

---

## Backlog overview

| ID       | Title                                  | Owner               | Status    | Branch                               | Depends on |
|----------|----------------------------------------|---------------------|-----------|--------------------------------------|------------|
| TASK-001 | Project scaffolding & shared types     | scaffolding-agent   | review    | `chore/scaffolding`                  | —          |
| TASK-002 | Capture worker (Playwright)            | capture-agent       | review    | `feature/pipeline-capture`           | TASK-001   |
| TASK-003 | Render worker (FFmpeg filter graph)    | render-agent        | review    | `feature/pipeline-render`            | TASK-001   |
| TASK-004 | Orchestrator + SQLite state            | orchestrator-agent  | review    | `feature/orchestrator-state`         | TASK-001   |
| TASK-005 | Phase 1 CLI spike (integration)        | integration-agent   | proposed  | `feature/cli-spike`                  | TASK-002, TASK-003 |

TASK-002, TASK-003, TASK-004 may run in parallel after TASK-001 merges. TASK-005 sequences after 002 + 003 land.

Phase 3 (UI) tasks will be authored once Phase 1 spike is green.

---

## TASK-001 — Project scaffolding & shared types

**Agent name:** scaffolding-agent
**Branch/worktree:** `chore/scaffolding`
**Status:** review (awaiting human merge to `main`)

**Task:** Initialize the Node/TypeScript project, install foundational dependencies, lay down the agreed directory layout, and define the shared type surface that downstream agents will program against.

**Goal:** A repo where TASK-002, TASK-003, TASK-004 can each clone a worktree and start coding against stable interfaces without redesigning anything.

**Allowed files/folders:**
- `package.json`, `package-lock.json`
- `tsconfig.json`
- `.gitignore`, `.editorconfig`, `.nvmrc`
- `next.config.mjs` (placeholder, no routes yet)
- `src/types/index.ts` (full shared type surface — see INTERFACES.md)
- `src/lib/` (empty stubs OK: `csv.ts`, `url.ts`, `storage.ts`)
- `scripts/generate-mask.ts` (script, not an exported module)
- `public/` (output target for circle masks; empty until script runs)
- `README.md` (one-pager pointing at PLAN.md and /ai/)

**Forbidden files/folders:**
- Anything under `src/pipeline/`, `src/orchestrator/`, `src/db/`, `src/app/`, `src/cli/`, `src/components/`
- `/ai/DECISIONS.md` (Lead-owned)
- `/ai/INTERFACES.md` — you may PROPOSE additions in your final summary, but do not commit edits without Lead approval
- `PLAN.md`, `progress.md`

**Required reading:**
- `/PLAN.md` (architecture, tech stack)
- `/ai/DECISIONS.md` (locked decisions)
- `/ai/INTERFACES.md` (directory layout, shared type signatures — implement these exactly)

**Acceptance criteria:**
1. `git init` run; `.gitignore` excludes `node_modules/`, `output/`, `tmp/`, `uploads/`, `.next/`, `.env*`.
2. `package.json` has the dependencies listed in INTERFACES.md "Dependency manifest" section, no extras.
3. `tsconfig.json` strict mode on, `paths` configured for `@/*` → `./src/*`.
4. `src/types/index.ts` exports every type listed in INTERFACES.md. No `any`, no `unknown` outside type guards.
5. `npm run typecheck` passes.
6. `npm run generate-mask` produces `public/circle-mask-{200,280,360}.png` (square PNG, transparent outside, opaque white inside the inscribed circle).
7. Directory layout matches INTERFACES.md exactly. Empty folders may have a `.gitkeep`.

**Tests to run:**
- `npm run typecheck`
- `npm run generate-mask` and visually inspect the three PNGs (open them; confirm circular alpha)

**Risks:**
- Adding more deps than listed (forbidden — get Lead approval).
- "Helpful" extra abstractions in `src/lib/` — keep stubs empty or one-liners.
- Drifting from the directory layout in INTERFACES.md — downstream tasks depend on exact paths.

**Dependencies:** none. This task unblocks everything else.

**Final summary must include:**
- Files changed (full list)
- Decisions made (anything beyond INTERFACES.md → propose to Lead, do not commit)
- Tests run + outputs
- Risks remaining
- Suggested next step (which downstream tasks are now unblocked)

---

## TASK-002 — Capture worker (Playwright)

**Agent name:** capture-agent
**Branch/worktree:** `feature/pipeline-capture`
**Status:** proposed (blocked on TASK-001)

**Task:** Implement the Playwright-based website capture worker per the contract in INTERFACES.md "Capture worker contract."

**Goal:** Given a URL, produce a full-page PNG screenshot at a known path, with cookie banners hidden and lazy-loaded content forced to render. Returns a `CaptureResult`.

**Allowed files/folders:**
- `src/pipeline/capture.ts`
- `src/pipeline/__tests__/capture.test.ts`
- `src/pipeline/cookie-selectors.ts` (the static CSS selector list)
- `tests/fixtures/capture/` (fixture HTML pages for tests)

**Forbidden files/folders:**
- `src/pipeline/render.ts`, `src/pipeline/filter-graph.ts` (TASK-003 owns)
- `src/types/index.ts` (Lead-owned; if a type needs adding, raise in BLOCKERS)
- `package.json` (no new deps without Lead approval — Playwright + stealth are already in TASK-001)
- All other `src/` subtrees

**Required reading:**
- `/PLAN.md` § "Capture worker (Playwright)" and § "Anti-Bot Strategy"
- `/ai/INTERFACES.md` § "Capture worker contract"
- `/ai/DECISIONS.md` D-001

**Acceptance criteria:**
1. Exports `async function captureWebsite(input: CaptureInput): Promise<CaptureResult>` matching INTERFACES.md exactly.
2. Implements: `goto` with `networkidle`, cookie-banner CSS injection, top→bottom→top auto-scroll for lazy loading, 1s settle, full-page screenshot.
3. Browser pool: one `chromium` instance, configurable context-pool size (default 6), context recycling every 20 jobs.
4. Retries: 1 retry on timeout; 0 retries on bot-wall detection (Cloudflare/DataDome interstitial).
5. Returns structured errors (`CaptureError` with `reason`) for the orchestrator to consume — never throws raw Playwright errors past the boundary.
6. Caps screenshot height at 16,000 px (per PLAN.md failure-handling table).
7. Tests pass against a local fixture HTML server; do not test against real internet in CI.

**Tests to run:**
- `npm run test -- capture`
- `npm run typecheck`
- `npm run lint`

**Risks:**
- Playwright stealth plugin compatibility — if it conflicts with the version pinned by TASK-001, raise in BLOCKERS, do not bump the version unilaterally.
- Memory growth across long runs — context recycling is the mitigation. Verify with a 50-iteration test.

**Dependencies:** TASK-001 merged.

**Final summary:** files changed, tests run + results, decisions made (none expected), risks remaining, suggested next step.

---

## TASK-003 — Render worker (FFmpeg filter graph)

**Agent name:** render-agent
**Branch/worktree:** `feature/pipeline-render`
**Status:** proposed (blocked on TASK-001)

**Task:** Implement the FFmpeg-based render worker per INTERFACES.md "Render worker contract." This is the riskiest piece of engineering in the project — the filter graph must be correct on the first integration run.

**Goal:** Given a screenshot PNG, a circle source (image or video), an optional MP3, and a `RenderConfig`, produce an MP4 with: smooth ease-in-out pan over the screenshot, circular overlay in the chosen corner, audio muxed correctly.

**Allowed files/folders:**
- `src/pipeline/render.ts`
- `src/pipeline/filter-graph.ts` (the filter-graph builder — pure function, heavily tested)
- `src/pipeline/__tests__/render.test.ts`
- `src/pipeline/__tests__/filter-graph.test.ts`
- `tests/fixtures/render/` (fixture PNG + circle media + MP3 for end-to-end render tests)

**Forbidden files/folders:**
- `src/pipeline/capture.ts` (TASK-002 owns)
- `src/types/index.ts` (Lead-owned)
- `package.json`
- All other `src/` subtrees

**Required reading:**
- `/PLAN.md` § "The FFmpeg filter graph" — the draft is the spec
- `/ai/INTERFACES.md` § "Render worker contract"
- `/ai/DECISIONS.md` D-004, D-005, D-006, D-007

**Acceptance criteria:**
1. `buildFilterGraph(config: RenderConfig): string` is a pure function returning the full FFmpeg `-filter_complex` argument as a string. Unit-tested with golden snapshots for: 30s/1080p/bottom-right + 60s/720p/top-left + circle-image-no-audio + circle-video-with-audio.
2. `async function render(job: RenderJob): Promise<RenderResult>` spawns `ffmpeg`, streams stderr to a logger, parses progress, and resolves with output path + timing. Rejects with `RenderError` containing the last 50 lines of stderr on non-zero exit.
3. Pan uses smoothstep easing exactly as in PLAN.md: `(H - viewportH) * (t/D)^2 * (3 - 2*(t/D))`.
4. Circle uses `alphamerge` with the appropriate pre-generated mask from `public/circle-mask-{200|280|360}.png`. Do not compute alpha per-frame.
5. Audio behavior:
   - Circle has audio + MP3 present → `amix` both, `duration=first` (the scroll duration governs).
   - Only one audio source → use it directly.
   - No audio → output silent (`-an`).
6. Output: H.264 (`libx264`, `-preset medium`, `-crf 23`), AAC audio (`-c:a aac -b:a 192k`), 30fps, `-movflags +faststart`.
7. Renders pass smoke-test: open the produced MP4, confirm pan + circle + audio behave as expected at all four corner positions.

**Tests to run:**
- `npm run test -- filter-graph` (pure unit tests, snapshots)
- `npm run test -- render` (spawns real ffmpeg against fixtures — must complete in <30s per render)
- `npm run typecheck`
- Manual: open output MP4s in a player.

**Risks:**
- FFmpeg expression escaping — single quotes vs double quotes inside the filter graph string. Cover with a unit test.
- Filter graph ordering — `[bg][circle] overlay` ordering is sensitive; test all four corner positions.
- Video circle source shorter than scroll duration — confirm last-frame hold behavior matches spec (do not loop unless config asks for it).
- `-shortest` interaction with `amix` — test explicitly.

**Dependencies:** TASK-001 merged. `ffmpeg` binary on PATH (document in README).

**Final summary:** files changed, golden snapshots committed, tests run + results, manual MP4 inspection notes, risks remaining, suggested next step.

---

## TASK-004 — Orchestrator + SQLite state

**Agent name:** orchestrator-agent
**Branch/worktree:** `feature/orchestrator-state`
**Status:** proposed (blocked on TASK-001)

**Task:** Implement the in-process job orchestrator with two Promise pools (capture, render), SQLite-backed state, and an EventEmitter-based progress channel. Does NOT call into capture/render workers directly — use injected dependencies so this can be unit-tested with mocks before TASK-002/003 land.

**Goal:** A `BatchOrchestrator` class that, given `(captureFn, renderFn)`, takes a batch config + leads, drives them through the pipeline, persists state, and emits progress events.

**Allowed files/folders:**
- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/pool.ts` (concurrency-limited promise pool)
- `src/orchestrator/events.ts` (event types + EventEmitter wrapper)
- `src/db/schema.sql`
- `src/db/client.ts`
- `src/db/migrations.ts` (single-step "ensure schema" runner)
- `src/orchestrator/__tests__/*.test.ts`
- `src/db/__tests__/*.test.ts`

**Forbidden files/folders:**
- `src/pipeline/*` (consume only via injected functions)
- `src/types/index.ts`
- `package.json`
- `src/app/*`, `src/cli/*`

**Required reading:**
- `/PLAN.md` § "Concurrency model", § "State (SQLite)", § "Failure handling"
- `/ai/INTERFACES.md` § "Orchestrator contract", § "SQLite schema", § "Capture worker contract", § "Render worker contract"
- `/ai/DECISIONS.md` D-002

**Acceptance criteria:**
1. `class BatchOrchestrator` with constructor `(deps: { capture: CaptureFn; render: RenderFn; db: DbClient; clock?: () => number })`. Inject everything that touches I/O.
2. `runBatch(batch: BatchInput): AsyncIterable<BatchEvent>` streams events as leads progress.
3. Capture pool concurrency 6, render pool concurrency `min(os.cpus().length, 8)`. Configurable via constructor.
4. Per-lead failure isolation: one lead failing never aborts the batch.
5. Retry policy per PLAN.md: 1 retry on capture timeout/network, 0 retries on bot-wall.
6. SQLite schema matches INTERFACES.md exactly. `db/schema.sql` is the source of truth; `migrations.ts` is idempotent (`CREATE TABLE IF NOT EXISTS`).
7. Unit tests cover: success path, partial failure, all-fail, concurrency cap honored, status transitions, event ordering.
8. No real Playwright/FFmpeg invocations in tests — use injected mocks.

**Tests to run:**
- `npm run test -- orchestrator`
- `npm run test -- db`
- `npm run typecheck`

**Risks:**
- Race conditions in SQLite writes from concurrent workers — `better-sqlite3` is synchronous, so prefer single-writer patterns; document in code.
- Event ordering guarantees — define explicitly in events.ts; tests must verify.
- Pool cancellation on shutdown — out of scope for v1; document as known limitation.

**Dependencies:** TASK-001 merged.

**Final summary:** files changed, tests run + results, decisions made (any race-condition strategy → propose to DECISIONS.md), risks remaining, suggested next step.

---

## TASK-005 — Phase 1 CLI spike (integration)

**Agent name:** integration-agent
**Branch/worktree:** `feature/cli-spike`
**Status:** proposed (blocked on TASK-002 + TASK-003)

**Task:** Wire the capture and render workers into a single CLI command that takes a URL + circle media + optional MP3 and produces an MP4. Validates Phase 1 of PLAN.md.

**Goal:** `npm run spike -- --url https://example.com --circle face.mp4 --audio narration.mp3 --duration 30 --resolution 1080p` produces a watchable MP4. No CSV, no orchestrator, no UI — just the smallest possible end-to-end harness.

**Allowed files/folders:**
- `src/cli/spike.ts`
- `src/cli/__tests__/spike.test.ts`
- `package.json` (ONLY to add the `spike` npm script — no new deps)

**Forbidden files/folders:**
- Everything not listed above. This task is integration glue, not new functionality.

**Required reading:**
- `/PLAN.md` § "Phase 1 — End-to-end spike"
- `/ai/INTERFACES.md` (capture + render contracts)
- TASK-002 and TASK-003 final summaries

**Acceptance criteria:**
1. CLI parses args (any minimal arg parser is fine; `node:util.parseArgs` is available — do not add a dep).
2. Calls `captureWebsite()` then `render()` from the merged pipeline modules.
3. On success: prints output path. On failure: prints structured error and exits non-zero.
4. Manual smoke test against ≥3 real websites of varying length (short landing page, medium marketing site, long blog post). Output MP4s reviewed and look like Looms.
5. Update `progress.md` and `/PLAN.md` § "Phase 1" with a "DONE" note + any tweaks discovered (escalate as DECISIONS if architectural).

**Tests to run:**
- `npm run typecheck`
- `npm run spike` against fixtures
- Manual: 3 real-website renders

**Risks:**
- This is where filter-graph + capture incompatibilities will surface. Treat unexpected output as a TASK-003 issue, not a TASK-005 issue — escalate via BLOCKERS.

**Dependencies:** TASK-002 + TASK-003 merged.

**Final summary:** files changed, real-website test results (URLs + observations), risks remaining, suggested next step (= author Phase 2 task contracts).

---

## Notes for all agents

- Do not run `git push` to remote unless explicitly asked. Branches stay local.
- Do not merge to `main` yourself — the human is the merge authority.
- If you discover a missing decision or interface, write to BLOCKERS, do not assume.
- Update your task's status field in this file when you start (`in-progress`) and finish (`review`).
