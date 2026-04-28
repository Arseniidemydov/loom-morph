# Merge Queue

Branches awaiting review and merge to `main`. The Lead Agent maintains this file. The human is the merge authority — branches stay on this list until the human merges.

**Workflow:** Implementation agent finishes → adds entry to "Ready for review" → Reviewer agent reviews → Lead Agent confirms architecture consistency → human merges → entry moves to "Merged".

---

## Ready for review

_(empty — no branches in flight yet)_

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
