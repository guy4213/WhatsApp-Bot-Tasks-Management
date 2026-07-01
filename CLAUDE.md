# Project instructions

## 1. TASKS.md is the source of truth

`TASKS.md` in the repo root is the source of truth for the current build plan.

It tracks:

* blockers
* decisions
* D1–D5 domain tasks
* X dismantle / cleanup tasks
* what is done
* what is in progress
* what is blocked
* what should be done next

Before starting any task, read the relevant entry in `TASKS.md`.

After finishing any task in `TASKS.md`, update that task entry in the same turn.
Do not postpone this update.

Add a `**Status:** DONE ...` line immediately under the task heading:

`#### <ID> — <title>`

Use the same shape as the existing DONE entries.

The status line must include:

* `DONE (commit <sha>)` if the work is already committed.
* `DONE (local, uncommitted)` if the work is staged or unstaged.
* File paths changed.
* Tests run and results.
* Migration verification, if relevant.
* Any deviation from the task spec and the reason for it.

Do not remove or rewrite the original:

* `- **What to do:** ...`
* `- **Definition of Done:** ...`

Leave those intact so reviewers can compare the original plan against what actually shipped.

---

## 2. TASKS.md must be corrected when reality differs from the document

While working, if you discover that `TASKS.md` does not match the actual repository state, update `TASKS.md` immediately in the same turn.

This applies even if you did not directly implement the original task.

Examples:

* A task is marked blocked, but the blocker has been resolved.
* A task is marked open, but the code already implements it.
* A task is marked DONE, but the code no longer satisfies the Definition of Done.
* A task description still references an old design decision.
* A task depends on fields, tables, or flows that were renamed or removed.
* A subtask was completed as part of another task.
* Runtime code changed in a way that affects a task’s status.
* A migration changed the meaning of an existing task.
* A task should be marked `PARTIAL`, `OBSOLETE`, `REWRITTEN`, or `NEEDS FOLLOW-UP`.

When correcting a mismatch, add a clear `**Status:** ...` note under the relevant task entry.

Use these status forms when appropriate:

* `**Status:** DONE ...`
* `**Status:** PARTIAL ...`
* `**Status:** OBSOLETE ...`
* `**Status:** REWRITTEN ...`
* `**Status:** NEEDS FOLLOW-UP ...`
* `**Status:** BLOCKED ...`

The note must explain:

* what was found
* what the actual repo state is
* what changed in the task status
* what still remains, if anything

Do not silently rely on memory, git log, or chat history.
If the repo state and `TASKS.md` disagree, `TASKS.md` must be reconciled.

## 3. Parallel work and conflict safety

Multiple agents or sessions may run in parallel.

Before editing any file:

1. Run `git status`.
2. Check whether another agent appears to be working in the same file.
3. Prefer creating new files or working in files that are not currently being edited.
4. Avoid unnecessary edits to shared high-conflict files.

High-conflict files include:

* `TASKS.md`
* `SPEC_FIELD_V2.md`
* `GAP_ANALYSIS.md`
* `src/ai/router.ts`
* `src/whatsapp/digestContent.ts`
* migration files

If `TASKS.md` has unrelated in-flight edits, still update it when required.
Status updates are additive and should be placed directly under the relevant task heading.

If a conflict risk exists, state it clearly before proceeding.

---

## 4. Model selection: Sonnet vs Opus

Choose the model based on task complexity.

Use **Sonnet** for normal implementation work, small fixes, straightforward tests, documentation updates, refactors, and isolated features.

Use **Opus** for complex reasoning or high-risk changes, including:

* architecture decisions
* database schema design
* migrations with production impact
* multi-file refactors
* changes touching `router.ts` and scheduler logic together
* ambiguous product behavior
* security, permissions, or RLS questions
* debugging failures that require deep reasoning
* tasks where the spec, code, and `TASKS.md` disagree
* any work that may affect multiple agents or parallel branches

If unsure, choose **Opus** for planning and reasoning, then use **Sonnet** for straightforward implementation.

### Model recommendation before execution

BEFORE starting any implementation work — before the first Edit / Write / Bash — recommend a model in ONE line and STOP for the user to switch if needed.

The assistant cannot change models mid-session. The `/model` command is user-controlled. So the recommendation must arrive early enough that the user can act on it.

Format:

`Model recommendation: <Sonnet|Opus> — <one-line reason>. Switch with /model <name> before I proceed, or say "go" to continue on the current model.`

Rules:

* Emit the recommendation once per task or wave, right after reading the task and before any code edits.
* Do NOT emit a recommendation for read-only investigation, questions, or tiny one-liners where switching cost > work cost.
* If the user says "go" / "continue" / "proceed" without switching, run on the current model without further prompting.
* If the current model already matches the recommendation, still state it once (so the user sees the reasoning) but proceed without waiting.
* Never claim you "executed with Sonnet" or "switched to Opus" — you did not. State the model the session is actually on if it matters.

Example:

`Model recommendation: Sonnet — isolated formatter + tests, no cross-file reasoning. Switch with /model sonnet before I proceed, or say "go".`

or:

`Model choice: Opus — migration and workflow semantics affect multiple domains.`

---

## 5. Before starting a task

Before implementing:

1. Read the relevant task in `TASKS.md`.
2. Check `SPEC_FIELD_V2.md` if product behavior is involved.
3. Check `GAP_ANALYSIS.md` if the reasoning or original tradeoff matters.
4. Run `git status`.
5. Identify whether the task is already done, partially done, blocked, or stale.
6. If the task status is stale, update `TASKS.md` before or during the same turn.

Do not start coding from memory alone.

---

## 6. During implementation

Keep changes focused.

Prefer:

* small commits
* clear file boundaries
* new helper files when they reduce collisions
* tests close to the changed logic
* no unnecessary rewrites
* no broad formatting changes

Do not change old behavior unless the task explicitly requires it.

Do not write to `Task.status`.
The CRM owns `Task.status`.

---

## 7. After finishing a task

After finishing:

1. Run relevant tests.
2. Run type-checking if TypeScript changed.
3. Run migration verification if migrations changed.
4. Update `TASKS.md` in the same turn.
5. Record deviations from the task spec.
6. Commit the work if instructed or if this session’s workflow expects commits.
7. Report clearly what was done, what was tested, and what remains.

The final response should include:

* task IDs completed
* commit SHA, if committed
* files changed
* tests run
* known follow-ups
* whether anything remains uncommitted

---

## 8. Do not recreate retired or obsolete flows

Do not recreate old CRM-task functionality unless explicitly requested.

Do not reintroduce:

* `Task.isFieldTask`
* strict 1:1 `Task` ↔ `TaskField`
* `TaskField.taskId UNIQUE`
* bot-written `Task.status`
* `HANDOFF.md`
* old CRM worker menu as the active worker flow

The current model is:

* `Task` = office / CRM customer task
* `TaskField` = scheduled field visit / inspection appointment
* CRM scheduling form creates `TaskField` using an existing `Task ID`
* one `Task` may have multiple `TaskField` rows
* `Task.ownerId` is the assigned field worker
* the bot works against `TaskField`

---

## 9. When uncertain

If there is uncertainty, do not guess silently.

First check:

1. `TASKS.md`
2. `SPEC_FIELD_V2.md`
3. `GAP_ANALYSIS.md`
4. existing code
5. git log

If the answer is still unclear, write the uncertainty clearly and propose the safest next step.

Never mark a task DONE unless the Definition of Done is actually satisfied or the deviation is explicitly documented in the task’s `Status:` note.


