# Loom Morph

<img width="1024" height="1024" alt="loommorph_logo" src="https://github.com/user-attachments/assets/ba48d640-3ea7-4d13-91ee-fb73090bfc6d" />

🥷🥷 Personalised outreach at scale

## Documentation

- **[PLAN.md](PLAN.md)** — full architecture, FFmpeg filter graph, concurrency
  model, failure handling, and phased build plan.
- **[progress.md](progress.md)** — running log of work in flight.
- **[`ai/`](ai/)** — multi-agent coordination layer.
  - [`ai/TASKS.md`](ai/TASKS.md) — active task contracts.
  - [`ai/INTERFACES.md`](ai/INTERFACES.md) — locked module boundaries and
    shared types. Source of truth for the type surface in `src/types/index.ts`.
  - [`ai/DECISIONS.md`](ai/DECISIONS.md) — append-only architectural decisions.
  - [`ai/MERGE_QUEUE.md`](ai/MERGE_QUEUE.md) — branches awaiting review/merge.
  - [`ai/BLOCKERS.md`](ai/BLOCKERS.md) — open questions and unblock-needed items.

Implementation agents: read your task in `ai/TASKS.md`, the relevant section
of `ai/INTERFACES.md`, and the cited decisions in `ai/DECISIONS.md` before
writing any code. If a contract is wrong, file a blocker — do not deviate
silently.

## Development

Requires Node 20+ (see [`.nvmrc`](.nvmrc)) and a working `ffmpeg` on `PATH`.

```bash
npm install
npx playwright install chromium       # one-time, ~200 MB
npm run generate-mask                  # produces public/circle-mask-{200,280,360}.png
npm run typecheck
npm run test
```

Phase 1 (CLI spike), Phase 2 (batch core), and Phase 3 (web UI) land in that
order. The current branch state and what's next live in `progress.md`.

## System dependencies

- `ffmpeg` on `PATH` — `brew install ffmpeg` on macOS, package manager on Linux.
- Chromium for Playwright — installed via `npx playwright install chromium`.


