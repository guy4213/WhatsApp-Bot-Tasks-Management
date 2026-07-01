# Project instructions

## 1. Source of truth

`TASKS.md` is the source of truth for the build plan.

Before starting work:
- read the relevant task in `TASKS.md`
- check `SPEC_FIELD_V2.md` / `GAP_ANALYSIS.md` when product/spec reasoning is needed
- run `git status`

After finishing any task, update its entry in `TASKS.md` in the same turn.

Add a `**Status:** ...` line directly under the task heading.

Use:
- `DONE (commit <sha>)`
- `DONE (local, uncommitted)`
- `PARTIAL`
- `OBSOLETE`
- `REWRITTEN`
- `NEEDS FOLLOW-UP`
- `BLOCKED`

Include briefly:
- files changed
- tests run
- commit/local status
- deviations from the task spec
- what remains, if anything

Do not delete or rewrite the original `What to do` / `Definition of Done` lines.

If repo reality and `TASKS.md` disagree, update `TASKS.md` immediately.

---

## 2. Parallel work safety

Multiple agents may work in parallel.

Before editing:
- run `git status`
- avoid files already being edited by another agent
- prefer new helper files when possible

High-conflict files:
- `TASKS.md`
- `SPEC_FIELD_V2.md`
- `GAP_ANALYSIS.md`
- `src/ai/router.ts`
- `src/ai/menu.ts`
- `src/scheduler/jobs/digestDispatcher.ts`
- `src/whatsapp/digestContent.ts`
- migration files

If conflict risk exists, state it before editing.

---

## 3. Model recommendation

Before meaningful implementation work, recommend a model once and stop for user approval/switch.

Format:

`Model recommendation: <Sonnet|Opus> — <one-line reason>. Switch with /model <name>, or say "go".`

Use **Sonnet** for:
- normal implementation
- isolated services
- tests
- formatters
- small refactors
- documentation updates

Use **Opus** for:
- architecture
- migrations
- workflow decisions
- router + scheduler changes together
- polling/dedup logic
- webhook/status flows
- unclear spec/code/TASKS conflicts
- multi-agent orchestration

For read-only investigation or tiny fixes, no model recommendation is needed.

Never claim you switched models yourself. The user controls `/model`.

---

## 4. Opus orchestrator + sub-agents

Use the full orchestrator workflow whenever the user explicitly or implicitly asks to use agents, sub-agents, parallel agents, multiple agents, or to split work between agents.

This includes exact phrases like:
- “create subagents”
- “run subagents”
- “split this between agents”
- “use agents”
- “parallel agents”
- “תיצור סאבאייגנטס”
- “תפעיל סוכנים”
- “תחלק את זה בין סוכנים”
- “תן לכמה אייג׳נטים לעבוד על זה”
- “תפצל את העבודה”
- “תריץ כמה במקביל”

Also use this workflow when the user says something approximate with the same meaning, even if the exact phrase is different.

If the user’s intent is clearly to delegate parts of the work to multiple agents, treat it as an explicit command to use the full orchestrator workflow, not merely a suggestion.

### Opus orchestrator

Opus acts as the project lead.

It must:
- read `TASKS.md`
- understand dependencies/blockers
- split the work into focused sub-tasks
- assign sub-agents with narrow scopes
- avoid file conflicts
- review all sub-agent outputs
- run QA
- send fixes back when needed
- update `TASKS.md`
- produce the final summary

The orchestrator owns final quality.

### Sub-agent roles

Use **Sonnet** for implementation sub-tasks:
- services
- routes
- tests
- scheduler jobs
- formatters
- TypeScript fixes

Use **Haiku** only for lightweight support:
- grep/search
- file inventory
- stale wording checks
- simple summaries
- narrow review

Do not use Haiku for architecture, migrations, webhook logic, polling/dedup, or status-changing flows.

### Sub-agent prompts must include

- task ID
- exact goal
- allowed files
- files to avoid
- tests to run
- project constraints
- expected output
- reminder to report any `TASKS.md` impact

Sub-agents are helpers, not final decision-makers.

---

## 5. QA after sub-agents

After sub-agents finish, the Opus orchestrator must verify:

- scope was completed
- no wrong files were edited
- no conflicts were created
- implementation matches `TASKS.md`
- implementation matches the spec
- old flows were not reintroduced
- tests were added/updated
- relevant tests pass
- `npx tsc --noEmit` passes when TypeScript changed
- migrations are idempotent when migrations changed
- `TASKS.md` was updated

Do not blindly trust sub-agent summaries.

If QA finds a problem:
- send normal code fixes to Sonnet
- send search/check tasks to Haiku
- keep architecture/migration corrections in Opus
- QA again after the fix

---

## 6. Core project constraints

Do not write to `Task.status`.
The CRM owns `Task.status`.

Do not recreate:
- `Task.isFieldTask`
- strict 1:1 `Task` ↔ `TaskField`
- `TaskField.taskId UNIQUE`
- old CRM worker menu as the active worker flow
- `HANDOFF.md`

Current model:
- `Task` = office / CRM customer task
- `TaskField` = scheduled field visit / inspection appointment
- CRM scheduling form creates `TaskField` using an existing `Task ID`
- one `Task` may have multiple `TaskField` rows
- `Task.ownerId` is the assigned field worker
- the bot works against `TaskField`

---

## 7. Finish checklist

Before final response:

- run relevant tests
- run `npx tsc --noEmit` if TypeScript changed
- verify migrations if migrations changed
- update `TASKS.md`
- commit if instructed / expected
- report clearly:
  - task IDs completed
  - files changed
  - tests run
  - commit SHA or local/uncommitted status
  - remaining follow-ups