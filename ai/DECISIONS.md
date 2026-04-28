# Decisions

Architectural and product decisions that affect more than one module. Append-only — never delete an entry; supersede with a new entry that references the old one.

**When to add an entry:** any change to APIs, schema, auth, payments, shared types, business logic, UX patterns, dependency choices, deploy strategy, or anything an agent might assume by reading the code wrong.

**Format:**
```
## D-NNN — Title (YYYY-MM-DD)
Decision: …
Why: …
Tradeoff: …
Alternatives: …
Supersedes: D-XXX (if applicable)
```

---

## D-001 — Screenshot-pan, not real-time recording (2026-04-28)

**Decision:** Capture each website as a single full-page PNG via Playwright's `fullPage: true`, then animate a viewport panning over it via FFmpeg `crop` with a time-based expression.

**Why:** Real-time browser recording caps concurrency at ~5–8 on a single machine. Screenshot-pan scales to 100+ trivially, is fully deterministic, and is visually indistinguishable for the lead-gen use case (videos watched once, briefly).

**Tradeoff accepted:** Sites with hero animations or autoplay video backgrounds will appear frozen at their loaded-state frame. Acceptable for v1.

**Alternatives considered:** real-time screen capture; hybrid (record above-the-fold, pan the rest).

---

## D-002 — Single-process Next.js + SQLite + in-process Promise pools (2026-04-28)

**Decision:** Whole system runs as one Node process. No Redis, no separate worker service, no message broker. State in SQLite via `better-sqlite3`. Job queues are in-process Promise pools.

**Why:** v1 target is one machine, ~100 videos/batch. Simpler deploy, no IPC, easy local development.

**Tradeoff accepted:** Vertical scale only. Cannot survive a process restart mid-batch. Migration path to BullMQ + Redis stays straightforward — the orchestrator interface doesn't change.

---

## D-003 — Per-batch circle + audio, per-lead website only (2026-04-28)

**Decision:** Circle source and MP3 narration are uploaded once per batch and applied to every video. Personalization comes solely from the per-lead website.

**Why:** Matches user mental model ("record once, send to N"). CSV passthrough columns reserved for filename templating in v1, text overlays in v2.

---

## D-004 — Fixed video duration, variable pan speed (2026-04-28)

**Decision:** User configures duration (default 30s). Pan covers the full screenshot height in that fixed duration regardless of page length.

**Why:** Audio is fixed length; video must stay in sync.

**Tradeoff:** Very tall pages feel rushed. Mitigation: cap screenshot height at 16k px.

---

## D-005 — Output: 1080p, H.264/AAC, 30fps MP4 (2026-04-28)

**Decision:** Default 1920×1080, H.264 (`libx264`), AAC, 30fps, MP4 with `+faststart`. 720p as fast-mode toggle.

**Why:** Email/LinkedIn embed sweet spot, universal player compatibility.

---

## D-006 — Single FFmpeg invocation per video (2026-04-28)

**Decision:** Pan + circular crop + overlay + audio mux happen in one `-filter_complex`. Only intermediate file is the source PNG.

**Why:** Maximum throughput, single failure mode per render, simpler error attribution.

**Tradeoff:** Dense filter graph. Mitigation: `buildFilterGraph()` is a pure function with golden-snapshot tests.

---

## D-007 — Pre-generated circular masks (2026-04-28)

**Decision:** Generate three square mask PNGs at build time (200, 280, 360 px). Use `alphamerge` in the filter graph instead of `geq`.

**Why:** ~3-5× faster than per-pixel alpha math. Build artifact: `public/circle-mask-{200|280|360}.png` from `scripts/generate-mask.ts`.

---

## D-008 — Phased build order: spike → batch → UI → polish (2026-04-28)

**Decision:**
- Phase 1: CLI spike, single URL → MP4
- Phase 2: CSV batch + parallelism + SQLite
- Phase 3: Web UI + SSE
- Phase 4: Anti-bot, retry-failed, ZIP, polish

**Why:** Phase 1 validates the FFmpeg filter graph (the single hardest piece) end-to-end before any orchestration is built around it.

---

## D-009 — Multi-agent coordination model (2026-04-28)

**Decision:** Every implementation task gets its own branch/worktree, an explicit contract in `/ai/TASKS.md`, and Lead Agent approval before merge. Shared types and schema have a single owner per change-set.

**Enforced via:** `/ai/TASKS.md`, `/ai/INTERFACES.md`, `/ai/DECISIONS.md`, `/ai/MERGE_QUEUE.md`, `/ai/BLOCKERS.md`.

---

## D-010 — Dependency manifest is fixed at scaffolding time (2026-04-28)

**Decision:** TASK-001 installs the full v1 dependency set. Subsequent tasks may NOT add dependencies without Lead approval recorded here as a new D-NNN decision.

**Why:** Uncoordinated `npm install` across parallel branches produces conflicting `package-lock.json` files. Locking the manifest early prevents that class of merge conflict entirely.

**v1 manifest:** see `/ai/INTERFACES.md` § "Dependency manifest".

---

## D-011 — Git hygiene: local branches until human pushes (2026-04-28)

**Decision:** Implementation agents commit to local branches only. No `git push`, no PRs, no merging to `main`. Human is the merge authority. Lead Agent maintains `/ai/MERGE_QUEUE.md` as the staging area for review.

**Why:** Avoid pushing half-baked branches to a remote. Keep the human in the loop on every public action.
