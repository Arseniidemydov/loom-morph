# Blockers

Unresolved questions, broken assumptions, missing credentials, failing tests, dependency issues, anything that should stop work until clarified.

**When to add an entry:** the moment an agent encounters something it cannot resolve from the existing docs and code. Don't guess; raise it here and stop on the affected task.

**Status values:** `open | resolved | wont-fix`

---

## B-002 — `ffmpeg` not installed on dev machine (CONFIRMED blocking)

**Raised by:** Lead Agent
**Date:** 2026-04-28
**Status:** open — confirmed missing (`ffmpeg -version` → command not found)
**Affected tasks:** TASK-003 (render worker), TASK-005 (CLI spike)
**Does NOT block:** TASK-001 (scaffolding), TASK-002 (capture), TASK-004 (orchestrator — uses mocks)

**Problem:** The render worker shells out to the system `ffmpeg` binary. Verified missing via `command -v ffmpeg`.

**Needed action (human):** install ffmpeg before TASK-003 can start.

```bash
brew install ffmpeg
```

Then verify with `ffmpeg -version`. Lead Agent will not run install commands automatically.

**Resolution criteria:** `ffmpeg -version` runs cleanly on the dev machine; B-002 moves to resolved.

**Workaround in the meantime:** TASK-001, TASK-002, and TASK-004 can run in parallel; TASK-003 starts as soon as ffmpeg lands; TASK-005 sequences after TASK-002 + TASK-003.

---

## B-003 — Confirm Playwright browser install permission (open)

**Raised by:** Lead Agent
**Date:** 2026-04-28
**Status:** open
**Affected tasks:** TASK-001, TASK-002

**Problem:** Playwright's first-time install pulls ~200MB of Chromium binaries into `~/Library/Caches/ms-playwright/` (macOS). Some sandboxed environments block this.

**Needed action (human):** confirm the dev machine can run `npx playwright install chromium`. If not, raise it before TASK-001 starts.

---

## Resolved / wont-fix archive

## B-001 — Repository is not yet a git repo (resolved 2026-04-28)

**Resolution:** Repo was initialized; current branch is `chore/scaffolding` with the initial coordination commit `93bafbb`. TASK-001 work commits onto this branch.
**Notes:** Going forward, downstream tasks should create branches from `main` once TASK-001 merges.

<!-- Template:

## B-NNN — Title (resolved YYYY-MM-DD)

**Resolution:** what was done.
**Notes:** any followups.

-->
