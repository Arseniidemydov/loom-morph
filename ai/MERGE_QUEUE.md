# Merge Queue

Branches awaiting review and merge to `main`. The Lead Agent maintains this file. The human is the merge authority — branches stay on this list until the human merges.

**Workflow:** Implementation agent finishes → adds entry to "Ready for review" → Reviewer agent reviews → Lead Agent confirms architecture consistency → human merges → entry moves to "Merged".

---

## Ready for review

### Branch: feature/cli-spike
- Owner: integration-agent (Lead Agent acting in role)
- Task: TASK-005
- Status: ready for review
- Branched from: `main` (TASK-001/002/003/004 all merged).
- Tests run:
  - `npm run typecheck` — pass
  - `npm run test` — pass (46/46 across 8 suites)
  - `npm run spike -- --help` — prints usage cleanly
  - End-to-end against a local fixture HTTP server: captures 1280×1200 PNG, renders 720p H.264 MP4 (2 s) in ~3 s total
- Files:
  - `src/cli/spike.ts` — `parseArgs`-driven CLI; calls `captureWebsite()` then `render()`; structured error reporting; `shutdownCapturePool()` in `finally`
  - `src/cli/__tests__/spike.test.ts` — 3 tests (--help, missing-flag exit code, real-Chromium+ffmpeg integration)
  - `package.json` — `spike` script switched to `tsx src/cli/spike.ts`
- Risks:
  - low
  - **D-016** added `tsx` as a devDep. TASK-005's contract said "no new deps"; the rule's intent (D-010, runtime stability) is preserved — `tsx` is dev-only and isn't imported by app code. Alternatives (rewriting every pipeline import to be relative, custom `@/*` loader) would have produced churn for no gain.
- Phase 1 acceptance: ✅ — one URL → one acceptable MP4 in ~3 s.
- Depends on: TASK-002 (merged), TASK-003 (merged)
- Recommended merge order: 5
- Reviewer status: pending

### Branch: feature/pipeline-capture
- Owner: capture-agent (Lead Agent acting in role)
- Task: TASK-002
- Status: ready for review
- Tests run:
  - `npm run typecheck` — pass
  - `npm run test` — pass (43/43, including 5 real-Chromium integration tests)
- Files:
  - `src/pipeline/capture.ts` — `captureWebsite` (CaptureFn) + `shutdownCapturePool` + `__resetForTests`
  - `src/pipeline/cookie-selectors.ts` — static cookie/consent banner selector list + `injectionCss()`
  - `src/pipeline/__tests__/capture.test.ts` — 7 tests (input validation + 5 real-Chromium against a local fixture HTTP server)
- Behavior:
  - Lazy chromium (playwright-extra + stealth), context pool default 6, recycle every 20 jobs.
  - Per call: viewport 1280×800, networkidle goto (30 s timeout), bot-wall short-circuit (403 OR known interstitial fingerprint), cookie-CSS inject, top→bottom→top auto-scroll, 1 s settle, fullPage screenshot.
  - 16,000 px height cap via `sharp.extract` post-crop on pathologically tall pages.
  - Structured CaptureError on every failure path; never throws raw Playwright errors past the boundary.
- Risks:
  - low–medium
  - Two debug-cycle bugs surfaced during integration that are worth flagging:
    1. Bundlers (tsx/esbuild + vite) wrap named/const-assigned arrows with `__name(...)` helpers when transpiling. Those don't exist when Playwright serializes the function for `page.evaluate`. Fixed by passing the body as a string to `page.evaluate` for both `autoScroll` and the dimension probe.
    2. Playwright's `clip` option clips within the viewport (1280×800) unless paired with `fullPage:true`, and the two aren't reliably co-permitted. Switched to "fullPage screenshot, then `sharp.extract` if the page exceeds 16k". Equally fast and unambiguous.
  - Anti-bot is best-effort by design (PLAN.md). v1 expects 5–15% capture failure rate on real B2B lists.
- Depends on: TASK-001 (merged)
- Recommended merge order: 4 (independent of TASK-003)
- Reviewer status: pending

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
