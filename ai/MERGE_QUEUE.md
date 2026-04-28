# Merge Queue

Branches awaiting review and merge to `main`. The Lead Agent maintains this file. The human is the merge authority — branches stay on this list until the human merges.

**Workflow:** Implementation agent finishes → adds entry to "Ready for review" → Reviewer agent reviews → Lead Agent confirms architecture consistency → human merges → entry moves to "Merged".

---

## Ready for review

### Branch: chore/scaffolding
- Owner: scaffolding-agent (Lead Agent acting in role)
- Task: TASK-001
- Status: ready for review
- Tests run:
  - `npm install` — pass (497 packages, 54s)
  - `npm run typecheck` — pass
  - `npm run generate-mask` — pass; produces `public/circle-mask-{200,280,360}.png` (RGBA, correct dimensions, transparent outside inscribed circle, opaque white inside)
- Risks:
  - low
  - Two minor mid-flight corrections vs. the original task spec, both already reflected in INTERFACES.md / DECISIONS.md:
    1. **D-012** added `sharp` to the dependency manifest. The original manifest in INTERFACES.md silently omitted it even though `scripts/generate-mask.ts` (a TASK-001 deliverable) depends on it.
    2. `CaptureError.cause` needed `override` because `tsconfig.json` enables `noImplicitOverride`. INTERFACES.md updated to match (one-character change to the contract; not a semantic change).
  - `scripts/generate-mask.ts` had a path bug (resolved repo root from `scripts/` instead of repo root after compilation to `scripts/.dist/`). Fixed; verified outputs land in `public/`.
- Depends on: —
- Recommended merge order: 1 (unblocks TASK-002, TASK-003, TASK-004 to run in parallel)
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

_(empty)_

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
