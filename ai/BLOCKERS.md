# Blockers

Unresolved questions, broken assumptions, missing credentials, failing tests, dependency issues, anything that should stop work until clarified.

**When to add an entry:** the moment an agent encounters something it cannot resolve from the existing docs and code. Don't guess; raise it here and stop on the affected task.

**Status values:** `open | resolved | wont-fix`

---

_(no open blockers)_

---

## Resolved / wont-fix archive

## B-001 — Repository is not yet a git repo (resolved 2026-04-28)

**Resolution:** Repo was initialized; current branch is `chore/scaffolding` with the initial coordination commit `93bafbb`. TASK-001 work commits onto this branch.
**Notes:** Going forward, downstream tasks should create branches from `main` once TASK-001 merges.

## B-002 — `ffmpeg` not installed on dev machine (resolved 2026-04-28)

**Resolution:** `brew install ffmpeg` completed; `ffmpeg 8.1` available on PATH at `/opt/homebrew/bin/ffmpeg`. Render integration tests now run real ffmpeg and pass (4/4).
**Notes:** Output is H.264 + AAC + yuv420p with `+faststart` per D-005.

## B-003 — Confirm Playwright browser install permission (resolved 2026-04-28)

**Resolution:** `npx playwright install chromium` completed successfully (~200 MB into `~/Library/Caches/ms-playwright/`). Capture worker (TASK-002) is unblocked.
**Notes:** No sandboxing issues encountered.

<!-- Template:

## B-NNN — Title (resolved YYYY-MM-DD)

**Resolution:** what was done.
**Notes:** any followups.

-->
