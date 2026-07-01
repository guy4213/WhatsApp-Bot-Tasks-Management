# TASKS — current bot to Galit v2 (dependency-ordered plan)

Source of truth: `GAP_ANALYSIS.md` (30 gaps across 5 domains, 12 existing capabilities reviewed). Spec references: `SPEC_FIELD_V2.md`.

Conventions:
- Task IDs: `<section>-T<n>`. `B` = blocker / external input, `K` = decision-task, `D1..D5` = domain (per GAP_ANALYSIS Part 1), `X` = dismantle/replace (per GAP_ANALYSIS Part 2).
- "Blocked" means cannot be started until the named blocker resolves (external input received, or decision-task closed).
- Constraints in force throughout: ONE bot (role-routed display); additive-only DB except the single approved `Task` flag; the CRM owns `Task.status` and the bot NEVER writes it; no PG enums (text + CHECK); UUID PKs with `gen_random_uuid()`; RLS deny-all on every new table; migration conventions identical to `001`-`008`.

---

## 0. Decisions log (locked 2026-06-30)

The 7 K-tasks from §2 are closed. Resolutions:

- **K1 — Inspector identification:** rule is `user.role !== 'ADMIN'`. No schema change, no new role value, no per-user flag column. Simpler than any of the 3 surfaced options. `D5-T1` collapses to a one-liner branch in the menu router; `D2-T1` is unblocked from the K1 axis.
- **K2 — `Task` → inspection mechanism:** TBD. Leaning towards "some kind of trigger" (DB trigger or CRM-side hook) — to be finalized when more context is available. Does NOT block `D1-T1 / T2 / T3 / T5 / T6` (the DDL scaffolding + checklist seed). DOES block `D1-T4` (the `Task.isFieldTask` column wiring), `D2-T2` (card emitter), `D5-T6` (assignment-detection pattern).
- **K3 — Yoram vs Sasha dispatcher routing:** option (a) — per-user routing inside `src/scheduler/jobs/digestDispatcher.ts`, keyed on a tiny bot-side mapping (env-var phone allow-list, or a 2-row lookup table). One scheduled job, two code paths inside. Two-cron-jobs rejected as over-engineered for ~2 users.
- **K4 — Old CRM manager digest:** option (c) — gate behind an env flag, default off. Precedent: `LEGACY_DAILY_SUMMARY_ENABLED` at `src/scheduler/index.ts:76`. Delete entirely once v2 has run cleanly in production for ~2 weeks.
- **K5 — Digest-preference sub-menu:** option (b) — hidden capability. Keep `UserDigestPreference` table + service as infrastructure. No menu entry. Accessible only via a free-text trigger. Worker menu stays at exactly 7 items per spec.
- **K6 — Daily greeting:** option (a) — keep AND auto-open the v2 inspections menu after it. Matches the §5 spec example "שלום דני, מה תרצה לעשות?".
- **K7 — STT provider:** OpenAI Whisper API. Hebrew supported. ~$0.006/min. Single env var (`OPENAI_API_KEY` or a dedicated `WHISPER_API_KEY`).

Downstream effect on task blockers: `D5-T1, D2-T1, D2-T4, D3-T5, D4-T1, D4-T2, D5-T2, D5-T6, X-T5, X-T6` are no longer blocked on K-decisions (only K2-gated tasks `D1-T4 / D2-T2` remain decision-blocked, plus the original external-input blockers `B1 / B2`).

---

## 1. Blockers / external dependencies

These are inputs the bot team cannot produce internally. Work that depends on them is marked `Blocked: YES (B<n>)` throughout this document.

### B1 — InspectionType catalog (~150 מק"טים) sign-off
- **What's needed:** the full, signed-off list of inspection מק"טים used to seed `InspectionType` — code (מק"ט), Hebrew label, family (one of the 13 CHECK values), `isActive`, `sortOrder`, and the `isFieldInspection` boolean per row.
- **Status:** a substantial draft is embedded in `SPEC_FIELD_V2.md` lines 416-571, but the spec author flagged borderline shielding rows as still needing human review. Until that pass is signed off, the seed cannot be declared final.
- **Who likely owns it:** Galit + the spec author (office / domain expert). Bot team consumes; does not produce.
- **What it unblocks downstream:**
  - Seeding migration 009 with `InspectionType` rows (catalog seed only — the DDL itself is not blocked).
  - Any end-to-end test that requires a real `productName -> InspectionType.code` lookup (matching a `Task` to a family).
- **Tasks gated on B1:** `D1-T6` (catalog seed), and downstream verification of `D2-T2` (inspection card uses the family label).

### B2 — `lead incoming` table column names
- **What's needed:** the exact column names of the existing `lead incoming` table — at minimum: lead name, phone, message text, created-at, and `assignedTo`. Also confirmation of whether `assignedTo` is a `User.id` FK or a free-text name.
- **Status:** unspecified anywhere in the spec or the codebase. The spec is explicit that this is NOT the CRM's `Lead` table (which is used by `src/services/tasks.ts findLeadsByName` for relink purposes only).
- **Who likely owns it:** whoever owns the CRM/back-office DB where `lead incoming` lives.
- **What it unblocks downstream:** the entire Domain 3 leads stream — the 09:30 digest, the worker-assignment alert, the 1-hour escalation, and the leads portion of Yoram's exceptions digest (Domain 4).
- **Tasks gated on B2:** `D3-T1`, `D3-T2`, `D3-T3`, `D3-T4`, `D3-T5`, and the leads-counts portion of `D4-T1`.

---

## 2. Decision-tasks (do BEFORE the code they gate)

Each of these resolves an ambiguity in the spec. They must close before any task that depends on them starts. The bot team owns the decision — but a stakeholder sign-off (Galit / spec author) should accompany each, since these affect product-visible behavior.

### K1 — How is an inspector identified?
- **Question:** how does the bot know a given `User` is a field inspector (so it shows the inspections menu)?
- **Options surfaced by the gap analysis** (GAP Domain 5 row 1):
  - (a) Reuse an existing `UserRole` value (e.g. `TECHNICIAN` becomes "inspector"). Fewest changes — but reuses a CRM name that may already mean something else.
  - (b) Introduce a new role value (`INSPECTOR` / `FIELD_WORKER`) on `User.role`. Additive but touches a CRM column.
  - (c) Add a per-user boolean (e.g. `isFieldInspector`) on a bot-side table. Strictly additive — does NOT touch the CRM. Most aligned with §1 ("additive-only on CRM").
- **What's blocked until decided:** `D5-T1` (role-based menu routing), `D2-T1` (the worker menu can be rendered, but it has no "right people" without this).
- **Recommended default per gap analysis lean:** option (c). Confirm with stakeholders.

### K2 — Mechanism for "Task becomes inspection"
- **Question:** when the office flips the "field task = yes" dropdown in the CRM, what mechanism creates the corresponding `TaskField` row and triggers the inspection card (§6)?
- **Options surfaced by the gap analysis** (GAP Domain 1 row 4, GAP Domain 2 row 2):
  - (a) DB trigger on `Task` UPDATE/INSERT that inserts into `TaskField`. Atomic — but invisible to the bot until polled.
  - (b) Bot-side polling job (mirroring `completionNotifier.ts`) on the new `Task` flag column with a dedup mechanism.
  - (c) CRM-side hook (HTTP call from the CRM into the bot's `/internal` routes) that posts the new field-task event.
- **What's blocked until decided:** `D1-T4` (the `Task` flag migration), `D2-T2` (the inspection card emitter), `D5-T6` (assignment-detection polling pattern is the same shape).
- **Note:** the same mechanism decision is reusable for the lead-assignment alert (`D3-T3`) — if (b) is chosen, both share a polling-job template.

### K3 — Routing Yoram vs. Sasha to two different digests
- **Question:** how does the dispatcher decide Yoram gets the field+leads exceptions digest and Sasha gets the leads-only digest, when both look like elevated users today?
- **Options surfaced by the gap analysis** (GAP Domain 4 row 2):
  - (a) Per-user routing inside `digestDispatcher.ts`, keyed by a phone allow-list or a new role attribute.
  - (b) Split into two scheduled jobs with disjoint user sets.
- **What's blocked until decided:** `D4-T1` (Yoram exceptions digest content), `D3-T2` (Sasha 09:30 leads digest), `D4-T2` (Sasha-vs-Yoram dispatcher branch).

### K4 — Fate of the old CRM manager digest
- **Question:** once Yoram's v2 digest is in place, does the old CRM manager digest stay as a fallback, get deleted, or get gated behind an env flag?
- **Options surfaced by the gap analysis** (GAP Domain 4 row 4):
  - (a) Keep as fallback for unrecognized elevated users.
  - (b) Delete entirely — the bot is being repurposed and the old CRM digest no longer matches the product.
  - (c) Gate behind an env flag (precedent: `LEGACY_DAILY_SUMMARY_ENABLED` in `src/scheduler/index.ts` line 76).
- **What's blocked until decided:** `X-T5` (removing or gating the old manager digest formatters).

### K5 — Digest preference sub-menu exposure
- **Question:** is item 6/7 ("הגדרות סיכום בוקר/דוח סוף יום") removed from the v2 inspector menu, or kept as a hidden capability, or surfaced?
- **Options surfaced by the gap analysis** (GAP Part 2, "Digest settings sub-menu" row):
  - (a) Remove from menu entirely; keep `UserDigestPreference` table + service as infrastructure.
  - (b) Keep as a hidden capability (no menu entry; only accessible via a free-text trigger).
  - (c) Keep visible in the v2 worker menu (would require an 8th item).
- **What's blocked until decided:** `D2-T1` (the v2 worker menu items). The spec lists exactly 7 items, so default leans (a) or (b).
- **Recommended default per gap analysis:** option (b) — keep as a hidden capability for now; surface only if asked.

### K6 — Daily greeting in the v2 flow
- **Question:** does the per-user daily greeting (`src/services/greetings.ts`) stay, and if so does it open the v2 inspections menu automatically?
- **Options surfaced by the gap analysis** (GAP Part 2, "Per-user daily greeting" row):
  - (a) Keep + auto-open the v2 menu after the greeting (consistent with §5 example "שלום דני, מה תרצה לעשות?").
  - (b) Keep but do not auto-open.
  - (c) Remove entirely.
- **What's blocked until decided:** the menu wiring in `D2-T1` (whether the greeting triggers `renderMenu` automatically).
- **Recommended default per gap analysis:** option (a).

### K7 — Voice STT provider selection
- **Question:** which STT provider transcribes inbound voice messages? Whisper API? Another provider?
- **Options:** Whisper API (OpenAI), other commercial STT. The provider choice is the bot team's; the spec doesn't constrain it.
- **What's blocked until decided:** `D5-T2` (voice-handler implementation cannot be completed without an STT credential / provider client).

---

## 3. Tasks grouped by the 5 domains, in dependency order

### Domain 1 — DB schema (additive only)

#### D1-T1 — Migration 009 file scaffold (idempotent + conventions)
- **Status:** DONE (commit f7aeaa0)
- **What to do:** new file `src/db/migrations/009_field_inspections.sql`. Header + DO block envelope mirroring `008_digests.sql`. No DDL yet — this task is just the file shell + `BEGIN ... COMMIT` and the migration runner registration check. Confirm the file is detected by `src/db/migrate.ts` and `schema_migrations` tracks it.
- **Definition of Done:** running `npm run migrate` on a fresh DB applies migration 009 (currently a no-op) and records it in `schema_migrations`; running again is idempotent.
- **Reference:** GAP Domain 1 (all rows reference `009_*.sql`). Spec migration block lines 258-356.
- **Dependencies:** none.
- **Blocked:** no.

#### D1-T2 — `InspectionType` table DDL
- **Status:** DONE (commit f7aeaa0). Note: `isFieldInspection` column was OMITTED — it is not in the authoritative spec migration block (lines 258–356), which is the source of truth for column names per the build brief. Only the deferred, B1-blocked `D1-T7` references it; add it via an additive `ALTER TABLE` in that PR.
- **What to do:** extend `009_field_inspections.sql` with the `InspectionType` table. Columns per spec §3 + migration block lines 258-356: UUID PK `gen_random_uuid()`, `code` UNIQUE (= `Task.productName`), `labelHe`, `family` text + CHECK across the 13 declared values, `isActive` bool default true, `sortOrder` int, `isFieldInspection` bool, `createdAt`/`updatedAt` timestamps. Index on `family`. RLS enabled deny-all (pattern from `008_digests.sql`).
- **Definition of Done:** migration creates the table; the CHECK constraint rejects an unknown `family`; the unique constraint on `code` rejects a duplicate insert; RLS deny-all is verified via a non-service-role connection.
- **Reference:** GAP Domain 1 row 1. Spec §3, §14, lines 258-356, 408-413.
- **Dependencies:** D1-T1.
- **Blocked:** no (DDL not blocked — the seed is).

#### D1-T3 — `InspectionChecklist` table DDL
- **Status:** DONE (commit f7aeaa0)
- **What to do:** extend `009_field_inspections.sql` with `InspectionChecklist`. Columns per spec migration block lines 282-294: UUID PK, `family` text + CHECK (same 13 values), `code`, `labelHe`, `isRequired` bool, `sortOrder` int, `UNIQUE(family, code)`, index on `family`, RLS deny-all. NO `kind` column (dropped per spec).
- **Definition of Done:** table created; unique constraint on `(family, code)` rejects duplicates; CHECK on `family` rejects unknown values; RLS deny-all verified.
- **Reference:** GAP Domain 1 row 2. Spec §3, lines 282-294.
- **Dependencies:** D1-T1.
- **Blocked:** no.

#### D1-T4 — `Task` flag column (the one approved CRM exception)
- **What to do:** extend `009_field_inspections.sql` with a single `ALTER TABLE "Task" ADD COLUMN <name> BOOLEAN ...` per spec §1 + §3. Column name is the bot team's choice (suggest `isFieldTask`). Default `false`. Document the mechanism (per K2 decision) that flips this flag and triggers `TaskField` creation.
- **Definition of Done:** column exists on `Task`; default is `false` on existing rows; mechanism documented in a comment block at the top of the migration referencing the K2 decision.
- **Reference:** GAP Domain 1 row 4. Spec §1, §3.
- **Dependencies:** D1-T1, K2.
- **Blocked:** YES (K2).

#### D1-T5 — `TaskField` table DDL (operational spine)
- **Status:** DONE (commit f7aeaa0). Note: a 13-value `CHECK` was added to `TaskField.family` (the snapshot column) to match `InspectionType`/`InspectionChecklist` — the raw spec block left it bare, but the build brief's hard constraints and this task spec both require it.
- **What to do:** extend `009_field_inspections.sql` with `TaskField`. Columns per spec §3, §4, migration block lines 297-336: UUID PK, `taskId` UUID UNIQUE FK to `Task`, `inspectionTypeId` UUID FK to `InspectionType`, snapshot `family` text + CHECK (same 13 values), static metadata (`siteAddress`, `siteCity`, `fieldContactName`, `fieldContactPhone`, `navigationUrl`, `specialInstructions`), live `fieldStatus` text + CHECK over **exactly the 10 values** (`ASSIGNED, CONFIRMED, DECLINED, NEEDS_MORE_INFO, EN_ROUTE, ARRIVED, FINISHED_FIELD, WAITING_FOR_INFO, HAS_PROBLEM, CANCELED` — NO `STARTED`), per-status timestamps (`assignedAt, confirmedAt, declinedAt, departedAt, arrivedAt, finishedAt`), `declinedReason` text, inline problem (`problemType` text + CHECK over the 7 declared values, `problemNote` text, `hasOpenProblem` bool), missing-info (`missingReportInfo` bool, `missingReportInfoNote` text), `managerNotifiedAt` timestamp, `updatedByUserId` UUID FK to `User`, `createdAt/updatedAt` timestamps. Index on `fieldStatus`; partial index `WHERE hasOpenProblem = true`. RLS deny-all.
- **Definition of Done:** table created; the 10-value CHECK rejects any other `fieldStatus`; the 7-value CHECK rejects any other `problemType`; the unique constraint on `taskId` enforces 1:1; both indexes present; RLS deny-all verified.
- **Reference:** GAP Domain 1 row 3. Spec §3, §4, lines 297-336.
- **Dependencies:** D1-T1, D1-T2.
- **Blocked:** no.

#### D1-T6 — Seed `InspectionChecklist` for the 4 declared families
- **Status:** DONE (commit f7aeaa0)
- **What to do:** idempotent `INSERT ... ON CONFLICT (family, code) DO NOTHING` block for the 4 families (radiation / noise / asbestos / radon) — 17 rows total — fully specified in spec migration block lines 360-381.
- **Definition of Done:** running migration 009 twice leaves exactly 17 rows in `InspectionChecklist`; rows match the spec's family/code/labelHe/isRequired/sortOrder.
- **Reference:** GAP Domain 1 row 6. Spec lines 360-381, 580-598.
- **Dependencies:** D1-T3.
- **Blocked:** no.

#### D1-T7 — Seed `InspectionType` catalog (~150 rows)
- **What to do:** idempotent `INSERT ... ON CONFLICT (code) DO NOTHING` block for the full מק"ט catalog. Set `isFieldInspection = true` for the relevant subset.
- **Definition of Done:** catalog seed runs idempotently; row count matches the signed-off list from B1; every row's `family` passes the CHECK.
- **Reference:** GAP Domain 1 row 1 (seed). Spec lines 416-571 (draft).
- **Dependencies:** D1-T2, B1.
- **Blocked:** YES (B1).

### Cross-cutting infra prerequisites (interleaved here — needed before D2 menus and D3 reads)

#### D5-T1 — Inspector role detection + role-based menu routing
- **What to do:** extend `src/auth/userResolver.ts` and `src/ai/menu.ts` to recognize a field inspector per the K1 decision. The current `menuItemsFor` two-way branch (`isElevated` vs. not) becomes three-way: inspector → inspections menu (Domain 2); Sasha → leads-only display; Yoram → exceptions-only display; remaining elevated → fallback per K4.
- **Definition of Done:** an inspector calling the menu trigger sees the v2 inspections menu items only; a non-inspector elevated user sees no inspector menu; resolved role is logged in the audit trail.
- **Reference:** GAP Domain 5 row 1. Spec §1, §2.
- **Dependencies:** K1, K3, K4.
- **Blocked:** YES (until K1, K3, K4 close).

#### D5-T2 — Voice (`audio`) inbound: download + transcribe + route as text
- **Status:** DONE (commit a628b10). New `src/whatsapp/voice.ts` (Meta 2-step download + Whisper `/v1/audio/transcriptions`, `whisper-1`, `language=he`, K7) + `src/__tests__/voice.test.ts` (11 tests, all pass). `webhook.ts` audio branch seeds `WhatsappAuditLog` with `mediaId`, transcribes, feeds transcript through the existing `handleIncomingMessage` text path; fallback text `לא הצלחתי להבין את ההודעה הקולית…` on null. `utils/auditLog.ts`: `writeAuditLog` now returns the inserted id + new `updateTranscribedMessage(id, text)` helper (never throws) — 3 unrelated callers (`routes/tasks.ts`, `scheduler/jobs/digestDispatcher.ts`, `ai/router.ts`) got 1-line `await` conversions to preserve `Promise<void>` contracts. Deviations: raw `https.request` (mirrors `sender.ts`) instead of fetch, no new dep; audit-log helper lives in `utils/auditLog.ts` (no `whatsappAuditLog.ts` service exists in this repo). `OPENAI_API_KEY` already recognized by preflight — missing key logs a warn and no-ops.
- **What to do:** new file `src/whatsapp/voice.ts` (or similar). Extend `src/routes/webhook.ts processInbound` to handle `m.type === 'audio'`. Pipeline: download the Meta audio asset → call the STT provider chosen in K7 → write the transcript into the existing `WhatsappAuditLog.transcribedMessage` column (slot already exists from migration 001 line 54) → feed the transcript into the existing `handleIncomingMessage` text path. New env var for the STT credential.
- **Definition of Done:** sending a Hebrew voice message via WhatsApp results in: (a) the transcript stored in `WhatsappAuditLog.transcribedMessage`, (b) the same downstream routing as if the transcript had been typed.
- **Reference:** GAP Domain 5 row 2. Spec §5, §8, §9, §11, §14.
- **Dependencies:** K7.
- **Blocked:** YES (K7).

#### D5-T3 — AI intent set rewrite for field statuses
- **Status:** DONE (commit a628b10). `ai/schema.ts` adds 3 new `AI_INTENTS` (`set_field_status`, `report_problem`, `report_missing_info`) + `FIELD_STATUS_TRANSITIONS` (5 values) + `FIELD_PROBLEM_TYPES` (7 values); JSON tool-call schema + Zod validator extended with strict `z.enum` (out-of-set values rejected per DoD). `types/index.ts`: `AIIntent` union extended, `FieldStatusTransition` + `FieldProblemType` exported. `intentParser.ts`: Hebrew few-shot mappings for all 5 transitions (יצאתי / הגעתי / סיימתי / מחכה למידע / יש בעיה), mapped + unmapped `problem_type` cases, missing-info notes, inline customer-ref ("יצאתי ללקוח כהן"). Legacy CRM intents preserved (X-T2 removes them). 20 new tests in `aiSchema.test.ts` across 8 describe blocks — all pass; existing 5 tests unchanged. Deviation: `transition` + `problem_type` land as top-level `AIIntentResult` fields (mirrors `field` / `new_value`) rather than inside `params` — required for strict `z.enum` rejection. Router untouched (`executeIntent` has a `default: helpText()` branch, no exhaustiveness fix needed) — the 3 new intents fall to `helpText()` until D2-T5 / T7 / T8 wire them.
- **What to do:** extend `src/ai/intentParser.ts` and `src/ai/schema.ts` with a new intent `set_field_status` and sub-types `DEPARTED / ARRIVED / FINISHED / WAITING_FOR_INFO / HAS_PROBLEM`. Also add `report_problem`, `report_missing_info`. Keep `help` and `unknown`. The drop of the old CRM intents (`list_tasks`, `create_task`, `edit_field`, `edit_duedate`, `reassign_task`, `relink_task`, `team_workload`, `confirm_pending_action`, `decline_pending_action`) is `X-T2` — keep them temporarily here for the transitional period.
- **Definition of Done:** "departed for Ra'anana", "arrived", "finished" all parse to `set_field_status` with the right sub-type; ambiguous cases route through the existing `task_disambig` path in `src/ai/router.ts` lines 286-296.
- **Reference:** GAP Domain 5 row 3, GAP Part 2 "Existing AI router + intent parser" row. Spec §5.
- **Dependencies:** D5-T1.
- **Blocked:** no (after D5-T1 done).

### Domain 2 — Worker side, field inspections (sections 5-11)

#### D2-T1 — Rewrite worker main menu (`employeeMenu()`) to the 7 v2 items
- **What to do:** rewrite `employeeMenu()` in `src/ai/menu.ts` (lines 51-61 today). The 7 items per spec §5: `הבדיקות שלי להיום`, `הבדיקות שלי למחר`, `עדכון סטטוס בדיקה`, `דיווח על בעיה`, `חסר ציוד`, `חסר מידע לדוח`, `סיכום יום`. Add 7 new `MenuAction` kinds: `list_inspections_today`, `list_inspections_tomorrow`, `update_inspection_status`, `report_problem`, `missing_equipment`, `missing_report_info`, `day_summary`. Per K5, digest-settings exposure is removed from this menu (default: hidden).
- **Definition of Done:** an inspector sees exactly the 7 v2 items, numbered, Hebrew, no emojis; replying with a number triggers the corresponding `MenuAction`; `MENU_TRIGGER_RE` (existing) re-opens the menu.
- **Reference:** GAP Domain 2 row 1. Spec §5.
- **Dependencies:** D5-T1, K5, K6.
- **Blocked:** YES (K5, K6 are decisions, K1 cascades from D5-T1).

#### D2-T2 — Inspection card emission on `TaskField` creation
- **What to do:** new file `src/services/inspections.ts` for `TaskField` reads/writes. New emission path triggered by the K2 mechanism (DB trigger / polling / CRM hook). On creation: load `TaskField` + `InspectionType` + `Customer` + `InspectionChecklist` rows for the family + `User` (the assignee), assemble the card per spec §6 (type label, customer, address, date+time, contact, equipment list, navigation link), and call `sendButtonMessage` with 3 reply buttons: `1. מאשר`, `2. לא יכול להגיע`, `3. צריך פרטים נוספים`. Use deterministic payload IDs (e.g. `INSP_CONFIRM_<taskFieldId>`, `INSP_DECLINE_<taskFieldId>`, `INSP_NEED_INFO_<taskFieldId>`).
- **Definition of Done:** creating a `TaskField` row in DB results in the assigned worker receiving one card with three labelled buttons matching spec §6 verbatim.
- **Reference:** GAP Domain 2 row 2. Spec §6.
- **Dependencies:** D1-T5, D1-T6, K2.
- **Blocked:** YES (K2). For end-to-end verification with a real family label, also B1.

#### D2-T3 — Inspection card button replies → `fieldStatus` writes
- **What to do:** extend `src/routes/webhook.ts` interactive-message handler (lines 162-170 today) to route the 3 stable payload IDs from D2-T2 to `TaskField` updates: `INSP_CONFIRM_*` → `fieldStatus = CONFIRMED` + `confirmedAt`; `INSP_DECLINE_*` → `fieldStatus = DECLINED` + `declinedAt` + prompt for short `declinedReason` (new `conversationContext.awaiting` state) + alert office; `INSP_NEED_INFO_*` → `fieldStatus = NEEDS_MORE_INFO` + prompt for free-text follow-up (new awaiting state).
- **Definition of Done:** each button tap writes the right `fieldStatus`, sets the right timestamp, persists `declinedReason` when supplied, and emits the office alert; the next inbound text from the same user lands in the right `awaiting` slot.
- **Reference:** GAP Domain 2 row 3. Spec §6, §7.
- **Dependencies:** D1-T5, D2-T2.
- **Blocked:** no (after D2-T2).

#### D2-T4 — Worker morning reminder: today's inspections + numbered status update
- **What to do:** extend `src/scheduler/jobs/digestDispatcher.ts` so that — for users identified as inspectors per K1/D5-T1 — the morning slot sends an inspections list (numbered) + a "choose a number to update status" prompt. New content formatter in `src/whatsapp/digestContent.ts` (replaces `formatEmployeeMorning` for inspectors; old CRM formatter handled by `X-T3`). Numbered-reply pattern reused from `src/ai/router.ts`. Per-day dedup via `src/services/digestSendLog.ts`.
- **Definition of Done:** an inspector with N inspections today receives one Hebrew message listing all N numbered, with a status-update prompt; dispatcher dedup prevents a second send the same day.
- **Reference:** GAP Domain 2 row 4. Spec §7.
- **Dependencies:** D1-T5, D2-T1, D5-T1.
- **Blocked:** YES (cascading K1 via D5-T1).

#### D2-T5 — Worker on-demand status transitions (departed / arrived / finished)
- **What to do:** in `src/services/inspections.ts`, implement `advanceFieldStatus(taskFieldId, transition)` for `EN_ROUTE` ("departed", + `departedAt`), `ARRIVED` ("arrived", + `arrivedAt`), `FINISHED_FIELD` ("finished", + `finishedAt`, **unconditional**). Wire to: (a) the menu item 3 numbered-reply path, (b) the free-text/voice routing via D5-T3 intents.
- **Definition of Done:** each transition writes the correct `fieldStatus` and timestamp; "finished" never blocks; ambiguity when the worker has multiple inspections today routes through the existing `task_disambig` style flow.
- **Reference:** GAP Domain 2 row 4. Spec §7.
- **Dependencies:** D1-T5, D2-T4, D5-T3.
- **Blocked:** no (after deps).

#### D2-T6 — Finished follow-up 4-option menu
- **What to do:** after `FINISHED_FIELD` writes successfully, send the 4-option follow-up menu (`אין הערות` / `יש הערות מהשטח` / `יש בעיה` / `חסר מידע לדוח`). Option 2 → free text → save to `fieldNotes` (a column on `TaskField` — confirm it exists in D1-T5 schema; if not, add a `fieldNotes` text column to D1-T5). Option 3 → route to D2-T8 (problem flow). Option 4 → route to D2-T7 (missing-info flow).
- **Definition of Done:** after a finished write, the worker receives the 4-option menu; option 1 ends the flow; option 2 captures notes; options 3/4 hand off cleanly to the right downstream flow.
- **Reference:** GAP Domain 2 row 5. Spec §7.
- **Dependencies:** D2-T5.
- **Blocked:** no.

#### D2-T7 — "Missing info for report" flow
- **What to do:** new flow triggered by menu item 6 or by the post-finished menu option 4. Prompt: "מה חסר לדוח?" → accept free text or voice → set `fieldStatus = WAITING_FOR_INFO`, `missingReportInfo = true`, `missingReportInfoNote = <text>`, `managerNotifiedAt = now()` → alert the office via `sendTextMessage`. Voice transcripts arrive here automatically via D5-T2.
- **Definition of Done:** the four `TaskField` fields are written; the office receives an alert containing the worker name, the inspection identity, and the missing-info note.
- **Reference:** GAP Domain 2 row 6. Spec §8.
- **Dependencies:** D1-T5, D5-T2, D5-T3.
- **Blocked:** YES (K7 cascades via D5-T2).

#### D2-T8 — "Report a problem" flow (7-item numbered sub-menu)
- **What to do:** new flow triggered by menu item 4 or by the post-finished menu option 3. Render the 7 problem types numbered: `CUSTOMER_NOT_ANSWERING / NO_ACCESS / CUSTOMER_NOT_PRESENT / MISSING_EQUIPMENT / CANNOT_PERFORM / PROFESSIONAL_ISSUE / OTHER`. Options 6 ("בעיה מקצועית") and 7 ("אחר") prompt for free-text elaboration. Write `problemType`, `problemNote`, `hasOpenProblem = true`, `fieldStatus = HAS_PROBLEM`. Send the spec-§9 alert to the manager.
- **Definition of Done:** every problem type writes the right `problemType`; options 6 and 7 also write `problemNote`; the manager alert text matches the spec §9 template; only ONE open problem at a time per `TaskField` (per spec §9 — multi-problem is deferred via `TaskFieldEntry`).
- **Reference:** GAP Domain 2 row 7. Spec §9.
- **Dependencies:** D1-T5, D5-T3.
- **Blocked:** no.

#### D2-T9 — Equipment reminder (morning roll-up by family)
- **What to do:** new job (or piggyback on D2-T4) that, for each inspector with inspections today, aggregates the required equipment by joining each inspection's `family` to `InspectionChecklist` rows. Send one message listing the unique equipment items + 2 buttons via `sendButtonMessage`: `לקחתי הכל` / `חסר לי ציוד`. The second button → free-text prompt → manager alert.
- **Definition of Done:** worker with two inspections in different families receives one consolidated equipment list (deduped); "חסר לי ציוד" handler captures the free-text item and alerts the manager.
- **Reference:** GAP Domain 2 row 8. Spec §10.
- **Dependencies:** D1-T3, D1-T5, D1-T6, D2-T4.
- **Blocked:** no.

#### D2-T10 — On-demand worker day summary (menu item 7)
- **What to do:** new service method `dayFieldSummary(userId, date)` in `src/services/inspections.ts`. Reads today's `TaskField` rows for the worker, lists those at `FINISHED_FIELD`, counts `WAITING_FOR_INFO`. Then renders a 4-option menu (`הכל בוצע` / `חסר מידע לדוח` / `צריך לחזור ללקוח` / `בעיה פתוחה`); options 2-4 hand back into D2-T7 / a (light) "call back later" handler / D2-T8 respectively. **No `FieldWorkerDayClose` DB write** — deferred per §14.
- **Definition of Done:** the menu produces a Hebrew summary of today's finished inspections and the waiting-for-info count; options 2-4 hand off to existing flows; no new tables are written.
- **Reference:** GAP Domain 2 row 9. Spec §11.
- **Dependencies:** D1-T5, D2-T1, D2-T7, D2-T8.
- **Blocked:** no.

### Domain 3 — Leads stream (Sasha)

#### D3-T1 — `lead incoming` reader service
- **What to do:** new file `src/services/leadsIncoming.ts`. Read-only queries against the existing `lead incoming` table. Provide: `findUnassignedInWindow(from, to)`, `findUnassignedOlderThan(minutes, createdBetween)`, `findRecentlyAssigned(sinceTimestamp)`. The bot WRITES NOTHING to this table — handling and assignment happen in the CRM.
- **Definition of Done:** functions return typed rows; pool comes from `src/db/connection.ts`; no INSERTs/UPDATEs in this file; verified column mapping matches the B2 input.
- **Reference:** GAP Domain 3 row 1. Spec §12.
- **Dependencies:** B2.
- **Blocked:** YES (B2).

#### D3-T2 — Sasha 09:30 morning leads digest
- **What to do:** new digest type `LEADS_MORNING` (or a Sasha-only flavor per K3). Content formatter in `src/whatsapp/digestContent.ts`: list all `lead incoming` rows from 17:00 yesterday → 09:30 today that are still unassigned, per spec §12 format. Include per-lead AI suggestion of the best-matching worker by ROLE (from D3-T5). New cron entry at 09:30 (override the 08:00 default in `src/db/migrations/008_digests.sql` — either a per-Sasha `UserDigestPreference` row, or a dedicated job).
- **Definition of Done:** at 09:30 local (`Asia/Jerusalem`), Sasha receives one message listing the overnight unassigned leads with AI suggestions; per-day dedup via `digestSendLog`; advisory-lock protected.
- **Reference:** GAP Domain 3 row 2. Spec §12.
- **Dependencies:** D3-T1, D3-T5, K3.
- **Blocked:** YES (B2, K3).

#### D3-T3 — Worker-assignment alert (assignedTo transitions empty → user)
- **What to do:** new polling job in `src/scheduler/jobs/leadAssignmentNotifier.ts` (mirroring `completionNotifier.ts` lines 16-37). On detection of an assigned lead, send the alert: customer name, phone, message text, "לטיפול ועדכון ב-CRM" (read-only — no actions on the bot side). New dedup mechanism: either a new bot-side mirror table tracking notified `lead incoming` rows, or a `notifiedAt`-style column — bot team's choice (note: NOT a column on `lead incoming` itself, per the additive-only rule on CRM tables).
- **Definition of Done:** when `assignedTo` flips from empty to a `User` who is an inspector, that inspector receives one alert and only one; restarts don't re-alert.
- **Reference:** GAP Domain 3 row 3. Spec §12.
- **Dependencies:** D3-T1, K2 (the mechanism is the same shape as the `TaskField` creation mechanism).
- **Blocked:** YES (B2, K2).

#### D3-T4 — 1-hour escalation to Sasha for unassigned daytime leads
- **What to do:** add to the polling job from D3-T3: any `lead incoming` row created between 09:30-22:00 local that's still unassigned 1 hour after its creation → ONE alert to Sasha including the AI suggestion (D3-T5) or "לא נמצאה התאמה". Overnight leads (17:00-09:30) are skipped — they're covered by D3-T2. Dedup must guarantee exactly one event per lead.
- **Definition of Done:** a lead created at 11:00 still unassigned at 12:00 triggers ONE Sasha alert; a lead created at 02:00 never triggers; restarts don't re-fire.
- **Reference:** GAP Domain 3 row 4. Spec §12.
- **Dependencies:** D3-T1, D3-T3, D3-T5.
- **Blocked:** YES (B2).

#### D3-T5 — AI suggest-worker-by-role function
- **Status:** DONE (local, uncommitted). Landed as new sibling file `src/ai/leadSuggester.ts` (not extended into `provider.ts`) exporting `suggestWorkerForLead(lead, candidates, provider?)`. Uses the existing `getProvider()` seam via `emitStructured`, strict JSON schema `{ userId: string|null, reason: string }`. Returns `{ userId: null, reason: 'לא נמצאה התאמה' }` on any of: empty candidates (no AI call), null provider, thrown error, hallucinated userId (not in candidate list). Never throws. Optional third `provider` param mirrors `parseIntent`'s pattern in `intentParser.ts:130-133` — real callers pass just two args; tests inject a mock directly. Per K1, inspector filtering (`role !== 'ADMIN'`) is the caller's responsibility. Tests: `src/__tests__/leadSuggester.test.ts` — 7/7 passing (empty candidates, disabled provider, valid pick, hallucinated id, provider throws, radiation sample, null-with-reason-kept).
- **What to do:** new function in `src/ai/provider.ts` (or a sibling file) that takes a lead's `service`/message text + the list of inspector `User` rows and returns a single suggested `User.id` (or null with reason). System prompt maps the lead text → best `User.role` → candidate. Strictly a suggestion; never auto-assigns.
- **Definition of Done:** for a sample lead "בדיקת קרינה ברעננה", the function returns an inspector whose role matches "קרינה"; for an off-topic message, returns null with "לא נמצאה התאמה".
- **Reference:** GAP Domain 3 row 5. Spec §12.
- **Dependencies:** D5-T1 (need to know which `User`s are inspectors).
- **Blocked:** no (the AI call itself isn't blocked; the lead text input is via B2 which gates the consumers D3-T2 / D3-T4, not this function).

### Domain 4 — Manager digest / exceptions (Yoram + Sasha)

#### D4-T1 — Yoram exceptions digest (morning + evening) content
- **What to do:** new formatters `formatGalitManagerMorning` / `formatGalitManagerEndOfDay` in `src/whatsapp/digestContent.ts` (or rename and replace the existing `formatManagerMorning` / `formatManagerEndOfDay` per K4). New aggregation queries against `TaskField` for the 5 field counts (`בוצעו / לא אושרו / עם בעיה / ממתינות למידע / לא סגרו יום`) and against `lead incoming` for the leads numbers (מהלילה / לא שויכו). Also the numbered list of OPEN exceptions = workers + customers + free-text issue (from `problemNote` / `missingReportInfoNote`).
- **Definition of Done:** Yoram's morning and evening messages match the §13 format; counts come from `TaskField` queries; open-exceptions list is sorted (suggested: by `managerNotifiedAt`); dispatcher uses the existing 08:00/17:00 default times unchanged for Yoram.
- **Reference:** GAP Domain 4 rows 1, 3. Spec §13.
- **Dependencies:** D1-T5, D3-T1 (for the leads counts).
- **Blocked:** YES — leads counts portion blocked on B2; field-exceptions portion is NOT blocked.

#### D4-T2 — Dispatcher branch Yoram vs. Sasha vs. other elevated
- **What to do:** per K3, extend `src/scheduler/jobs/digestDispatcher.ts isElevated` branching (line 119) so Yoram routes to D4-T1, Sasha routes to D3-T2, and the residual elevated path is handled per K4 (kept / removed / env-gated — see `X-T5`).
- **Definition of Done:** Yoram receives only the exceptions digest (D4-T1); Sasha receives only the leads digest (D3-T2); the test of "two elevated users get different content the same morning" passes.
- **Reference:** GAP Domain 4 row 2. Spec §13.
- **Dependencies:** D3-T2, D4-T1, K3, K4.
- **Blocked:** YES (K3, K4).

### Domain 5 — Cross-cutting infra (remaining)

#### D5-T4 — Button-vs-numbered-text policy enforcement
- **What to do:** no new code, but a written policy comment in `src/ai/menu.ts` / `src/whatsapp/sender.ts` reaffirming: 3-button `sendButtonMessage` only for the inspection card (§6) and the equipment reminder (§10); everything else (7-item main menu, 7-item problem sub-menu, finished follow-up 4-item, day-summary 4-item) stays numbered text. Honor the existing comment in `src/ai/router.ts` lines 773-776.
- **Definition of Done:** the policy is documented inline; no menu rendered with more than 3 buttons exists in the code.
- **Reference:** GAP Domain 5 row 4. Spec §1, §6.
- **Dependencies:** none.
- **Blocked:** no.

#### D5-T5 — Approved Meta templates for out-of-window sends
- **What to do:** register Meta-approved templates for: the §6 inspection card and the §13 exception alerts (likely arrive out-of-window). Config task, not a code change — but blocks production validation.
- **Definition of Done:** templates approved by Meta; template IDs added to env config; `sendTemplateMessage` calls in the inspection-card and exception-alert paths reference them.
- **Reference:** GAP Part 2, "WhatsApp sender" row. Spec §6, §13.
- **Dependencies:** D2-T2, D4-T1.
- **Blocked:** no (technically; depends on Meta turnaround).

#### D5-T6 — Polling-job template (shared by Task→inspection creation + lead-assignment detection)
- **What to do:** if K2 resolves to option (b) polling, factor out a shared polling-job template (mirroring `completionNotifier.ts`). Used by D2-T2 (Task flag → create `TaskField`) and D3-T3 (lead `assignedTo` flip → alert worker).
- **Definition of Done:** one reusable polling helper exists; both consumers use it; dedup tables are isolated per consumer.
- **Reference:** GAP Domain 1 row 4, Domain 3 row 3, Domain 5 cross-cutting. Spec §1.
- **Dependencies:** K2.
- **Blocked:** YES (K2).

---

## 4. Dismantle / replace the existing

These tasks remove or rewrite Part 2 capabilities marked "dropped" or "to-rewrite". They are ordered AFTER their replacements so functionality is never absent.

#### X-T1 — Drop `my tasks` / `list_tasks` from the worker menu and intents
- **What to do:** removal from `employeeMenu()` is already covered by `D2-T1`. Additionally: gut the `list_tasks` handler path from `src/ai/router.ts` `doListTasks` (lines 641-655) and the corresponding `MenuAction`. Keep `src/services/tasks.ts listTasks` function for any residual admin use (or remove entirely if no other callers remain).
- **Definition of Done:** `list_tasks` intent no longer reaches a handler in the worker path; `doListTasks` is removed or guarded behind an admin-only flag.
- **Reference:** GAP Part 2, "my tasks / list_tasks" row.
- **Dependencies:** D2-T1, D2-T4 (inspections-list replacement must be live first).
- **Blocked:** no.

#### X-T2 — Drop old CRM intents (`create_task`, `edit_field`, `edit_duedate`, `reassign_task`, `relink_task`, `team_workload`, `confirm_pending_action`, `decline_pending_action`)
- **What to do:** remove these from `src/ai/schema.ts`, `src/types/index.ts` `IntentType`, `src/ai/intentParser.ts`, and the corresponding router handlers in `src/ai/router.ts`. Drop the manager approval pipeline that supports `edit_duedate` (`src/services/pendingActions.ts`, `src/auth/permissions.ts MANAGER_APPROVAL_FIELDS`, the "אישורים ממתינים" manager menu item, the `confirm/decline` handlers in `src/ai/digestCommands.ts` if specific to this pipeline). Leave the `WhatsappPendingAction` TABLE in place (no DROP — bot doesn't write CRM, and the table is harmless).
- **Definition of Done:** none of these intents resolves to a handler; the pending-action approval flow is unreachable from any menu or free-text path.
- **Reference:** GAP Part 2, "create_task" and "change due date + manager approval pipeline" rows.
- **Dependencies:** D5-T3, D2-T1.
- **Blocked:** no.

#### X-T3 — Rewrite worker morning digest content (CRM tasks → inspections list)
- **What to do:** replace `formatEmployeeMorning` (`src/whatsapp/digestContent.ts` lines 71-81) for inspector recipients with D2-T4 content. The 17:00 evening employee broadcast (`runDailySummary`) is already disabled by default (`src/scheduler/index.ts` line 76) — leave dormant; don't delete.
- **Definition of Done:** an inspector's morning send goes through the D2-T4 content path; non-inspectors (if any remain) still get the old `formatEmployeeMorning` until a separate decision.
- **Reference:** GAP Part 2, "Employee morning digest + evening digest (CRM content)" row.
- **Dependencies:** D2-T4, D5-T1.
- **Blocked:** no.

#### X-T4 — Remove `team_workload` manager menu item + handler
- **What to do:** remove menu item 1 from `managerMenu()` in `src/ai/menu.ts` (the `team_workload` action), the `team_workload` intent in the parser, and `doTeamWorkload` (`src/ai/router.ts` lines 745-770). Drop `src/services/tasks.ts getTeamWorkload` if no callers remain.
- **Definition of Done:** no menu path or intent resolves to a workload-counts view; replaced by Yoram's exceptions digest (D4-T1).
- **Reference:** GAP Part 2, "team_workload" row.
- **Dependencies:** D4-T1 (replacement must be live).
- **Blocked:** no.

#### X-T5 — Old manager digest content (Yoram replacement + fallback decision)
- **What to do:** per K4, either: (a) keep `formatManagerMorning` / `formatManagerEndOfDay` (`src/whatsapp/digestContent.ts` lines 83-110, 142-172) as a fallback for non-Yoram non-Sasha elevated users; (b) delete both; or (c) gate behind an env flag (`LEGACY_DAILY_SUMMARY_ENABLED` precedent in `src/scheduler/index.ts` line 76). Implement the chosen option.
- **Definition of Done:** the chosen option is implemented; for Yoram the new D4-T1 content is the only one that fires; no double-send to elevated users.
- **Reference:** GAP Domain 4 row 4, GAP Part 2, "Manager morning + evening digest (CRM content)" row.
- **Dependencies:** D4-T1, D4-T2, K4.
- **Blocked:** YES (K4).

#### X-T6 — Digest preferences menu item (worker 6 / manager 7)
- **What to do:** per K5, either remove the menu item entirely (default), keep as a hidden capability (free-text trigger only), or surface in the v2 worker menu. Code in `src/ai/router.ts showDigestSettings` + `handleDigestSettingsReply` + `handleDigestTimeReply` (lines 897-982) and `src/services/digestPreferences.ts` is infrastructure — KEEP the underlying service even if the menu entry is removed.
- **Definition of Done:** the chosen exposure level is implemented; `UserDigestPreference` table and service untouched.
- **Reference:** GAP Part 2, "Digest settings sub-menu" row.
- **Dependencies:** K5.
- **Blocked:** YES (K5).

#### X-T7 — Disable / retire `completionNotifier`
- **Status:** DONE (commit a628b10). `scheduler/index.ts`: cron registration for `completionNotifier` is env-gated behind `COMPLETION_NOTIFIER_ENABLED` (default off), matching the `LEGACY_DAILY_SUMMARY_ENABLED` precedent on the same file. Comment references the v2 status-ownership rule (bot never writes `Task.status`) and points at `completionNotifier.ts` as the D5-T6 polling template per K2 brief §7. `completionNotifier.ts` itself and the `WhatsappCompletionNotification` table untouched. No scheduler test in repo — nothing to update. `tsc` + 106-baseline tests still pass.
- **What to do:** the bot no longer detects `Task.status = DONE` because the bot doesn't own `Task.status`. Either disable `src/scheduler/jobs/completionNotifier.ts` (preferred — set its scheduled entry off in `src/scheduler/index.ts`) or remove it. Keep `WhatsappCompletionNotification` table in place (no DROP).
- **Definition of Done:** the job no longer runs; no scheduled entry references it; table preserved.
- **Reference:** GAP Part 2, "Audit log + reminder log + completion-notification log" row (the completion-notifier becomes inert).
- **Dependencies:** none.
- **Blocked:** no.

---

## 5. Out of scope — later

Per Section 14 of the spec, deferred — NO tasks created for any of these:

- Photos (no upload, no completion gate, no `TaskPhotoMeta`).
- Outlook integration.
- `TaskFieldStatusHistory` (structured status-history table).
- Structured `TaskFieldEntry` (multi-problem-per-inspection).
- `FieldWorkerDayClose` (the "I'm done for the day" sealed record).
- Performance analysis.
- Automated reports.
- Lead actions from within the bot (assignment / handling — Sasha does this in the CRM).

---

## 6. Suggested execution order — milestones

- **M1: External inputs received + decisions made.** Resolve B1 (InspectionType catalog) and B2 (`lead incoming` columns); close K1, K2, K3, K4, K5, K6, K7. Nothing else can fully ship without these.
- **M2: DB foundation.** `D1-T1`, `D1-T2`, `D1-T3`, `D1-T4`, `D1-T5`, `D1-T6`. (Catalog seed `D1-T7` slides in as soon as B1 lands.)
- **M3: Cross-cutting infra prerequisites.** `D5-T1` (inspector detection + role-based menu routing), `D5-T2` (voice), `D5-T3` (AI intents), `D5-T4` (button policy), `D5-T6` (shared polling template if K2 = polling).
- **M4: Worker inspections menu + card + button replies.** `D2-T1`, `D2-T2`, `D2-T3`. End-to-end: a worker can confirm/decline/need-info on an assigned inspection.
- **M5: Worker morning reminder + on-demand status transitions + finished follow-up.** `D2-T4`, `D2-T5`, `D2-T6`. End-to-end: a full inspection day from morning list to finished + notes.
- **M6: Worker problem + missing-info + day-summary flows.** `D2-T7`, `D2-T8`, `D2-T9`, `D2-T10`. Worker side feature-complete for MVP.
- **M7: Leads stream for Sasha.** `D3-T1`, `D3-T5`, `D3-T3`, `D3-T4`, `D3-T2`. End-to-end: 09:30 digest, assignment alert, escalation.
- **M8: Manager exceptions digest for Yoram.** `D4-T1`, `D4-T2`. End-to-end: §13 morning and evening content with the right routing per K3.
- **M9: Dismantle and clean up.** `X-T1`, `X-T2`, `X-T3`, `X-T4`, `X-T5`, `X-T6`, `X-T7`. Old surface area removed AFTER the new surface is shipping.
- **M10: Templates + production validation.** `D5-T5` (Meta-approved templates for out-of-window sends), end-to-end smoke testing.
