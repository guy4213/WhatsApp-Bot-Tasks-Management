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

### 1.1 Capabilities map (BOT_CAPABILITIES.md)

`BOT_CAPABILITIES.md` is the CEO-facing map of what the bot can do — written in
plain Hebrew, business-friendly, no code.

**Update rule:** after every task that adds a NEW user-facing feature or
capability, append/update the relevant section in `BOT_CAPABILITIES.md` in the
same turn. Update:

- **NEW features only** — new intents, new menu items, new automated flows, new
  data the bot can read/write, new user-facing behaviors, new AI understandings.
- Do NOT log: bug fixes, refactors, test-only changes, internal wording tweaks,
  TypeScript-only changes, or infra-level changes that the CEO would not care
  about.

Format of the update:

- Add one short bullet in plain Hebrew under the relevant section (e.g. "יכולות
  של בודק שטח", "יכולות של מנהל", "תהליכים אוטומטיים").
- If the feature is a new category, add a new bullet or sub-section.
- Update the "מעודכן לתאריך" line at the top to today's date.
- Keep the language simple, product-level. No filenames, no task IDs, no code.

Example of a good update line: "העובד יכול לבקש תזמון בדיקה חדשה בטקסט חופשי — 'לתזמן ביקור מחר ב-10'."

Example of a bad update line: "D2-T11 added `schedule_task_field` intent to `intentParser.ts`."

If a change removes or narrows a documented capability, also update
`BOT_CAPABILITIES.md` to reflect the new truth.

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

When multiple agents are used:
- keep each sub-agent scope narrow
- avoid assigning the same file to multiple agents unless explicitly necessary
- if the same file must be touched, the orchestrator must control the final integration
- do not merge sub-agent work blindly
- review the actual diffs before accepting the work

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
- final QA ownership after sub-agents
- high-risk changes in `router.ts`, scheduler jobs, database writes, or permission logic

For read-only investigation or tiny fixes, no model recommendation is needed.

Never claim you switched models yourself.  
The user controls `/model`.

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

### 4.1 Opus orchestrator

Opus acts as the project lead.

It must:
- read `TASKS.md`
- understand dependencies/blockers
- understand the relevant product/spec context
- split the work into focused sub-tasks
- assign sub-agents with narrow scopes
- avoid file conflicts
- review all sub-agent outputs
- read the actual diffs/code changed by sub-agents
- verify behavior independently instead of trusting summaries
- perform scenario-level QA for user-facing flows
- inspect test quality, not only test count
- run QA
- send fixes back when needed
- update `TASKS.md`
- produce the final summary

The orchestrator owns final quality.

Sub-agent work is considered unverified until Opus has:
- reviewed the actual diff
- checked the relevant behavior
- inspected the tests
- confirmed spec/TASKS compliance
- produced a QA report

Sub-agents are helpers, not final decision-makers.

### 4.2 Sub-agent roles

Use **Sonnet** for implementation sub-tasks:
- services
- routes
- tests
- scheduler jobs
- formatters
- TypeScript fixes
- isolated features
- focused refactors

Use **Haiku** only for lightweight support:
- grep/search
- file inventory
- stale wording checks
- simple summaries
- narrow review
- test-output summaries
- locating old references

Do not use Haiku for:
- architecture
- migrations
- webhook logic
- polling/dedup logic
- status-changing flows
- permission logic
- database schema decisions
- router/scheduler changes
- final QA ownership

### 4.3 Sub-agent prompts must include

Every sub-agent prompt must include:
- task ID
- exact goal
- allowed files
- files to avoid
- tests to run
- project constraints
- known risks
- expected output
- reminder to report any `TASKS.md` impact

Sub-agents should report:
- what they changed or found
- files touched
- tests run
- remaining risks
- deviations from the assigned scope
- any `TASKS.md` / spec impact

### 4.4 File conflict rules for sub-agents

Sub-agents should avoid editing the same files in parallel unless Opus explicitly allows it.

For high-conflict files, Opus should usually either:
1. assign the file to only one sub-agent, or
2. ask sub-agents to produce notes/proposed patches only, then integrate manually.

High-conflict files often include:
- `TASKS.md`
- `SPEC_FIELD_V2.md`
- `GAP_ANALYSIS.md`
- `src/ai/router.ts`
- `src/ai/menu.ts`
- scheduler files
- digest files
- migration files

---

## 5. QA after sub-agents

After sub-agents finish, the Opus orchestrator owns final quality.

The orchestrator must not blindly trust sub-agent summaries, green tests, or TypeScript compilation.

Technical QA is required, but it is not enough.

### 5.1 Mandatory technical QA

After every sub-agent implementation, the orchestrator must verify:

- scope was completed
- no wrong files were edited
- no conflicts were created
- implementation matches `TASKS.md`
- implementation matches the spec
- old flows were not reintroduced
- tests were added or updated
- relevant tests pass
- `npx tsc --noEmit` passes when TypeScript changed
- migrations are idempotent when migrations changed
- `TASKS.md` was updated when required
- `git status` is understood before and after the work

### 5.2 Mandatory qualitative QA

The orchestrator must also perform behavioral and product-level QA.

This means the orchestrator must read and verify the actual code changed by the sub-agent, not only the sub-agent summary.

For every sub-agent result, the orchestrator must:

1. Read the changed files or relevant diffs.
2. Verify that the implementation actually does what the user requested.
3. Verify that the behavior matches `TASKS.md`, `SPEC_FIELD_V2.md`, `GAP_ANALYSIS.md`, and any user-approved product decision.
4. Verify that permissions and role gates are correct.
5. Verify that state transitions are correct.
6. Verify that context is set, cleared, and reused correctly.
7. Verify that menu flows return the expected user-facing output.
8. Verify that error states and empty states are handled.
9. Verify that old or retired behavior was not accidentally reintroduced.
10. Verify that no forbidden CRM writes were added.
11. Verify that tests are meaningful, not only happy-path or weak assertion tests.

A sub-agent saying “implemented and tests pass” is not sufficient.

The orchestrator must independently inspect the implementation.

### 5.3 Scenario QA

For any user-facing flow, router flow, menu flow, scheduler flow, status flow, or permission-sensitive flow, the orchestrator must verify the main scenarios manually or through focused tests.

At minimum, check:

- happy path
- empty state
- invalid input
- permission denied
- back/cancel/menu behavior
- state/context after each step
- whether the next user reply is routed to the correct handler
- whether free text escapes to AI only where intended
- whether numeric replies are handled correctly
- whether old menu flows are not accidentally revived

For manager/worker WhatsApp menus, QA must include at least one full navigation path from menu entry to final action or detail view.

Examples:
- manager menu → today inspections → pick inspection → detail view → action list
- manager menu → exceptions → pick category → pick exception → detail view
- manager menu → leads → assign lead → pick lead → pick worker → confirm
- manager menu → workers/day summaries → pick worker → verify worker details
- manager menu → search → search by customer/worker/product → pick result → detail view
- worker menu → today inspections → pick task → update status

### 5.4 Test quality review

The orchestrator must inspect tests added by sub-agents.

Check that tests:

- assert behavior, not just that a function returns something
- cover negative/permission cases when relevant
- cover state/context changes when relevant
- cover empty states when relevant
- cover invalid input when relevant
- cover back/cancel/menu behavior when relevant
- cover at least one realistic end-to-end or integration-like flow for router/menu changes
- would fail if the implementation was wired to the wrong handler
- would fail if the old behavior was accidentally restored

Adding many weak tests is not considered sufficient QA.

Test count is not proof of quality.

### 5.5 Diff review requirement

Before accepting sub-agent work, the orchestrator must review the actual diff.

The review must answer:

- What files changed?
- Why did each file need to change?
- Are any high-conflict files touched?
- Are there unintended edits?
- Are there duplicated flows or stale handlers?
- Are there inline hacks that should be moved to a service/helper?
- Is the implementation consistent with existing architecture?
- Are names, statuses, DB fields, and permissions consistent with the current model?
- Did the change accidentally modify unrelated behavior?

If the diff touches `router.ts`, scheduler jobs, digest logic, permissions, status transitions, or database writes, the orchestrator must do an extra careful review.

### 5.6 Forbidden QA shortcuts

The orchestrator must not consider the work done only because:

- the sub-agent summary sounds correct
- tests pass
- TypeScript compiles
- many tests were added
- the diff looks small
- the user-facing text appears correct in one path
- there were no merge conflicts
- the implementation “looks reasonable”

These are useful signals, but they do not replace behavioral verification.

### 5.7 If QA finds a problem

If QA finds a problem:

- send normal implementation fixes to Sonnet
- send search/check tasks to Haiku
- keep architecture, migration, workflow, and spec corrections in Opus
- QA again after the fix
- do not commit until the fix has been rechecked

### 5.8 Required QA report before commit

Before any commit or final handoff, the orchestrator must report a QA summary.

The QA report must include:

- files reviewed manually
- flows/scenarios manually checked
- tests reviewed
- tests run
- TypeScript result
- permission checks verified
- state/context checks verified
- spec/TASKS compliance confirmed
- remaining risks or known weak spots

The report must distinguish between:

- “tests passed”
- “I manually reviewed the implementation”
- “I verified the actual behavior/scenario”

Do not merge, commit, or final-handoff sub-agent work without this QA report.

---

## 6. Core project constraints

Do not write to `Task.status`.

The CRM owns `Task.status`.

The bot may update `TaskField.fieldStatus` for field operations.

The bot may perform only explicitly documented writes to CRM-owned tables.

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
- the worker updates field-operational statuses on `TaskField`
- the office / CRM owns the final CRM task status

### 6.1 TaskField daily-date rule

For any TaskField daily view, “today” means:

`TaskField.scheduledStartAt` within the local Asia/Jerusalem day.

This applies to:
- worker today list
- worker tomorrow list
- worker morning reminder
- worker equipment reminder
- worker day summary
- manager snapshot daily field counts
- manager today inspections
- manager worker/day summaries
- manager daily exceptions
- Yoram morning/evening daily field digest
- not confirmed today
- not closed today
- waiting for info today
- has problem today
- finished today in the daily operational view

Do not use `assignedAt` or `finishedAt` to decide whether a `TaskField` belongs to a daily operational view.

`assignedAt` is row creation / assignment time only.

`finishedAt` is actual completion timestamp only.

Leads are separate and continue to use `IncomingLead.receivedAt`.

### 6.2 Leads constraints

Leads source table:
- `IncomingLead`

Lead assignment field:
- `IncomingLead.ownerId`

The bot may assign a lead only through the documented lead-assignment flow.

The bot does not close leads.

Lead closure remains in the CRM.

Lead filtering uses:
- `IncomingLead.receivedAt`
- `IncomingLead.ownerId`

Do not apply TaskField date rules to leads.

### 6.3 Worker flow constraints

The active worker flow is the V2 field-worker flow.

Worker menu:

```text
שלום דני, מה תרצה לעשות?

1. הבדיקות שלי להיום
2. הבדיקות שלי למחר
3. עדכון סטטוס בדיקה
4. דיווח על בעיה
5. חסר ציוד
6. חסר מידע לדוח
7. סיכום יום

Worker status flow:

ASSIGNED
CONFIRMED
DECLINED
NEEDS_MORE_INFO
EN_ROUTE
ARRIVED
FINISHED_FIELD
WAITING_FOR_INFO
HAS_PROBLEM
CANCELED

Do not reintroduce STARTED.

Arrival = start of inspection.

Finished is unconditional.

FINISHED_FIELD does not change Task.status.

6.4 Unified manager menu

Manager-level users receive one unified topic-based WhatsApp menu.

Manager menu:

שלום, מה תרצה לעשות?

1. תמונת מצב ניהולית
2. בדיקות שטח להיום
3. חריגים ודיווחים
4. לידים ממתינים לטיפול
5. עובדים וסיכומי יום
6. חיפוש משימה / בדיקה

The menu is broad and topic-based.

Specific actions such as:

assign lead
schedule visit
correct visit details
correct inspection type
reassign field task

should happen inside the relevant contextual flow, not as top-level menu items.

Power users may still use free-text triggers directly, such as:

“לשייך ליד”
“לתזמן ביקור”
“הכתובת שגויה”
“סוג בדיקה שגוי”
“לשייך משימה מחדש”

All actions remain permission-checked behind the scenes.

A unified menu does not mean unified permissions.

6.5 Permission constraints

Field worker:

may view and update their own assigned field tasks
may correct site metadata only for their own assigned TaskField
may correct inspection type only for their own assigned task
may schedule follow-up only where allowed by the spec
may not assign leads
may not reassign tasks to other workers

MANAGER / ADMIN:

may perform manager-level TaskField actions according to spec
may reassign field tasks where allowed
may correct TaskField site details
may correct inspection type
may schedule visits under existing Tasks
may not assign leads unless explicitly included in the lead-assignment allowlist

Sasha / lead assigners:

may view lead digests
may assign leads from WhatsApp where allowed
may not close leads from the bot

Yoram:

receives management summaries and exceptions
may view management data
permissions must follow the current spec and allowlists

Dev observers:

may receive observer summaries according to the current allowlists
may perform only the actions explicitly allowed by current code/spec
6.6 CRM write constraints

Forbidden unless explicitly documented:

changing Task.status
changing customer commercial fields
changing price/payment fields
general CRM task editing
creating a new Customer
creating a new full CRM Task from the bot

Allowed only where explicitly documented:

creating TaskField under an existing Task
updating TaskField.fieldStatus
updating TaskField site metadata override fields
updating IncomingLead.ownerId in the lead-assignment flow
updating Task.ownerId only for documented manager reassignment flow
updating Task.productName only for documented inspection-type correction flow

All sensitive writes must have:

permission check
confirmation where required
audit/logging where required
clear user-facing message
7. Finish checklist

Before final response:

run relevant tests
run npx tsc --noEmit if TypeScript changed
run lint if available and relevant
verify migrations if migrations changed
update TASKS.md
run git status
review actual diffs/code changed by sub-agents
verify the main user-facing scenarios manually or through focused tests
inspect test quality, not only test count
verify permission gates
verify state/context transitions
verify the implementation matches TASKS.md and the spec
verify no old flows were reintroduced
commit if instructed / expected

Final response must report clearly:

task IDs completed
files changed
files manually reviewed
scenarios checked
tests run
TypeScript result
lint result if run
commit SHA or local/uncommitted status
remaining follow-ups or risks

If sub-agents were used, the final response must also include:

which model roles/sub-agents were used
what each sub-agent did
what the orchestrator independently verified
any fixes sent back after QA
final QA result

Never present sub-agent output as final until the orchestrator has completed QA.