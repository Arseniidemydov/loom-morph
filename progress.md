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

### Next up
- Human review/merge of `chore/scaffolding` then `feature/orchestrator-state` (in that order).
- TASK-002 (capture) — unblocked once B-003 (Playwright Chromium install permission) confirmed.
- TASK-003 (render) — unblocked once B-002 (`ffmpeg` install) is resolved.
- TASK-005 (Phase 1 CLI spike) sequences after TASK-002 + TASK-003 merge; will wire those into a concrete `OrchestratorPaths` backed by `src/lib/storage.ts`.
