# Merge Queue

Branches awaiting review and merge to `main`. The Lead Agent maintains this file. The human is the merge authority — branches stay on this list until the human merges.

**Workflow:** Implementation agent finishes → adds entry to "Ready for review" → Reviewer agent reviews → Lead Agent confirms architecture consistency → human merges → entry moves to "Merged".

---

## Ready for review

### Branch: feature/pipeline-render
- Owner: render-agent (Lead Agent acting in role)
- Task: TASK-003
- Status: ready for review
- Tests run:
  - `npm run typecheck` — pass
  - `npm run test` — pass (36/36 across all suites; including real-ffmpeg renders)
  - Manual: `ffprobe` on `tests/fixtures/render/.out/silent.mp4` → 1280×720 H.264 yuv420p, 60 frames over 2s (30 fps), 55 KB.
- Files:
  - `src/pipeline/filter-graph.ts` — pure builders (`buildFilterGraph`, `buildFfmpegArgs`)
  - `src/pipeline/render.ts` — `createRender(opts)` and default `render`; spawns ffmpeg, streams stderr, captures last 50 lines on failure (RenderError)
  - `src/pipeline/__tests__/filter-graph.test.ts` — 10 tests (golden snapshots, audio paths, corner coords, large circle)
  - `src/pipeline/__tests__/render.test.ts` — 4 tests (real ffmpeg integration; auto-skips if ffmpeg missing)
  - `.gitignore` — ignore generated fixture artifacts under `tests/fixtures/{capture,render}/`
- Risks:
  - low–medium
  - Filter-graph string composition is the riskiest piece in the project; covered by inline-snapshot tests for both 30s/1080p/bottom-right and 60s/720p/top-left, all four corners, all four audio paths.
  - Real-ffmpeg integration tests now part of the suite. They run quickly (~1.6 s per render at 720p, 2 s duration) but skip gracefully if `ffmpeg` is missing.
  - **D-015** — `RenderConfig.hasAudioTrack` replaced with `audioMp3Present`. Without this, the four audio paths weren't decidable from the type alone.
- Depends on: TASK-001 (merged)
- Recommended merge order: 3 (parallel-safe with TASK-002)
- Reviewer status: pending

<!-- Template:

### Branch: feature/example
- Owner: example-agent
- Task: TASK-XXX
- Status: ready for review
- Tests run:
  - npm run typecheck — pass
  - npm run test — pass (12/12)
  - manual: ...
- Risks:
  - low | medium | high
  - notes...
- Depends on: TASK-YYY (merged), TASK-ZZZ (in queue)
- Recommended merge order: N
- Reviewer status: pending | approve | request-changes | block

-->

---

## Blocked

_(empty)_

<!-- Template:

### Branch: feature/example
- Owner: example-agent
- Task: TASK-XXX
- Reason blocked: missing API key, dependency conflict, etc.
- Needed action: who needs to do what

-->

---

## Merged

### Branch: chore/scaffolding
- Task: TASK-001
- Merged date: 2026-04-28
- Merge commit: `5385699` (fast-forward into `main`)
- Notes: Three contract-affecting decisions landed alongside (D-012 sharp, plus the `override` keyword tightening on `CaptureError.cause`). No conflicts; no remote pushed.

### Branch: feature/orchestrator-state
- Task: TASK-004
- Merged date: 2026-04-28
- Merge commit: `0e97f85` (fast-forward into `main` after `chore/scaffolding`)
- Notes: D-013 (`@types/better-sqlite3`) and D-014 (`OrchestratorDeps.paths` required) both authored and applied to `INTERFACES.md` before merge. 22/22 tests green.

<!-- Template:

### Branch: feature/example
- Task: TASK-XXX
- Merged date: YYYY-MM-DD
- Notes: anything notable about the merge — squash commits, manual conflict resolution, etc.

-->

---

## Notes

- Branches must be merged in dependency order. If TASK-002 depends on TASK-001, TASK-001 merges first.
- A branch with `risk: high` requires Lead Agent sign-off in addition to reviewer approval.
- Do not skip the queue. If something is "just a typo fix," it still goes through review.
- After merge, the human (or Lead Agent on the human's behalf) should also delete the local branch to keep the repo tidy.
