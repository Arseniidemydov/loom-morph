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

---

## D-012 — Add `sharp` to the dependency manifest (2026-04-28)

**Decision:** Add `sharp` to the production dependency manifest. Used solely by `scripts/generate-mask.ts` to produce the three pre-generated circle masks under `public/`.

**Why:** D-007 mandates pre-generated PNG masks (square, transparent outside, opaque inside the inscribed circle). `sharp` is the standard Node-side image generator and produces correct alpha channels in one short script. The original v1 manifest in INTERFACES.md was authored before `generate-mask.ts` was written and silently omitted it.

**Tradeoff:** `sharp` ships native binaries (libvips). Adds ~30 MB to `node_modules`. Acceptable: it is dev/build-time only; runtime workers (capture, render) do not import it.

**Alternatives considered:** Hand-write a PNG via raw zlib + CRC (zero deps, ~200 LOC of fiddly chunk encoding); use `pngjs` (pure JS, slower but smaller). Both rejected — `sharp` is one line and the mask is a build artifact, not a hot path.

**Action:** Update `/ai/INTERFACES.md` § "Dependency manifest" to list `sharp`. No code change required (already in `package.json`).

---

## D-013 — Add `@types/better-sqlite3` to dev dependencies (2026-04-28)

**Decision:** Add `@types/better-sqlite3` to dev deps. Required for `src/db/client.ts` and `src/db/migrations.ts` to typecheck under strict mode.

**Why:** `better-sqlite3` ships no built-in types. The original v1 manifest in INTERFACES.md listed the runtime dep but omitted the types package — same class of oversight as D-012.

**Tradeoff:** None worth noting. Dev-only.

**Action:** Update `/ai/INTERFACES.md` § "Dependency manifest" to list `@types/better-sqlite3`.

---

## D-014 — Inject `paths` resolver into the orchestrator (2026-04-28)

**Decision:** Extend `OrchestratorDeps` with a required `paths: OrchestratorPaths` field. `OrchestratorPaths` is a two-method interface — `screenshotFor(batchId, leadId)` and `outputFor(batchId, leadId, lead, filename)` — that returns absolute paths the orchestrator hands to capture/render.

**Why:** The original orchestrator contract in INTERFACES.md said the runtime needs to know the on-disk layout but never showed how it learns about it. Hard-coding `src/lib/storage.ts` paths inside the orchestrator would couple it to the filesystem layout (and to a module that doesn't yet exist), and would force tests to do real I/O. Injecting a thin resolver keeps the orchestrator pure and lets tests pass `(/tmp/.../x.png, /output/.../y.mp4)` strings without touching disk.

**Tradeoff:** The CLI spike (TASK-005) and the Phase 3 API both have to construct an `OrchestratorPaths` from `src/lib/storage.ts`. Tiny boilerplate, well-contained.

**Alternatives considered:** Hard-code paths inside the orchestrator (rejected — couples orchestration to FS layout); attach paths to each `LeadInput` (rejected — pollutes the user-facing CSV-row type with internal plumbing).

**Action:** Update `/ai/INTERFACES.md` § "Orchestrator contract" to show `paths` in the deps. The orchestrator now treats `paths` as a required dep.

---

## D-015 — Replace `RenderConfig.hasAudioTrack` with `audioMp3Present` (2026-04-28)

**Decision:** In `RenderConfig`, replace the single `hasAudioTrack: boolean` field with `audioMp3Present: boolean`. The pure filter-graph builder now decides the audio path from `(circleHasAudio, audioMp3Present)`.

**Why:** The four audio paths in the filter graph are: both → `amix`; circle-only → circle audio passes through; mp3-only → mp3 passes through; neither → silent (`-an`). With only `circleHasAudio` and `hasAudioTrack`, the case "both present" can't be distinguished from "circle present, mp3 absent" — both have `circleHasAudio=true && hasAudioTrack=true`. Adding a separate `audioMp3Present` makes all four paths decidable.

**Tradeoff:** Tiny contract surface change. Caller must set both booleans explicitly; no implicit derivation.

**Alternatives considered:** Keep `hasAudioTrack` and treat any ambiguity as "both" (rejected — silently picks the wrong filter graph for circle-only inputs); add `audioMp3Present` as an additional field alongside `hasAudioTrack` (rejected — redundant, two flags describe the same axis).

---

## D-016 — Add `tsx` to dev deps for the CLI spike (2026-04-28)

**Decision:** Add `tsx` as a devDependency. Used by the `spike` npm script to run TypeScript directly without a separate compile step. Required because the pipeline modules use the `@/*` path alias, which Node's bare `--experimental-transform-types` loader does not resolve.

**Why:** TASK-005's contract said "no new deps". That clause was authored to protect runtime stability across parallel branches (D-010). `tsx` is a dev tool that runs `node` as a subprocess with a TS loader — it doesn't ship with the runtime, isn't imported by app code, and doesn't enter `dependencies`. The original rule's intent is preserved.

**Tradeoff:** ~25 MB more in `node_modules`. Acceptable for a dev tool used by a single script.

**Alternatives considered:** Rewriting every pipeline module to use relative imports (rejected — large diff, churn for no real gain); writing a custom Node loader hook for `@/*` (rejected — reinvents `tsx` worse); compiling the spike like `generate-mask` (rejected — would need to compile the entire transitive dep tree of pipeline modules).
