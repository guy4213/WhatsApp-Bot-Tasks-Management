# Project instructions

## TASKS.md is the source of truth

`TASKS.md` in the repo root tracks the current build plan (blockers, decisions, D1–D5 domain tasks, X dismantle tasks). It is the source of truth for what is done vs. in-flight vs. blocked.

**After finishing any task in `TASKS.md`, update its entry in the same turn.** Not "later", not "when I remember" — same turn.

Add a `**Status:** DONE ...` line at the top of the task's entry (immediately under the `#### <ID> — <title>` heading), matching the shape used by existing DONE entries (D1-T1, D1-T2, D1-T3, D1-T5, D1-T6, D3-T5). Include:

- `DONE (commit <sha>)` if already committed, or `DONE (local, uncommitted)` if changes are staged/unstaged.
- File paths that landed (services, tests, migrations).
- Any deviation from the task spec + rationale — record it here, not just in the commit message. Reviewers read TASKS.md first.
- Test / migration verification result (e.g. `7/7 tests passing`, `migration idempotent on re-run`).

Do NOT alter the original `- **What to do:** ...` / `- **Definition of Done:** ...` lines — leave them intact so the spec is auditable next to what actually shipped.

## HANDOFF.md is retired

There is no `HANDOFF.md` any more. Do not recreate it. Session-to-session continuity comes from:
1. `TASKS.md` (what's done, what's next per §6 milestones)
2. `SPEC_FIELD_V2.md` (the product spec)
3. `GAP_ANALYSIS.md` (the reasoning behind the plan)
4. Git log

If you would previously have written to HANDOFF, put the equivalent as a `Status:` note on the relevant TASKS.md entry instead.

## Parallel work

Multiple agents / sessions may be running at once. Before editing a file, check `git status` to see if another agent is mid-flight in it, and prefer creating new files or working in files nobody else has open. If TASKS.md itself has an unrelated in-flight edit, still make your Status update — it's an additive line at the top of a task entry and rarely collides.
