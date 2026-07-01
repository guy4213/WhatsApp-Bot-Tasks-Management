# TASKS — current bot to Galit v2 (dependency-ordered plan)

Source of truth: `GAP_ANALYSIS.md` (30 gaps across 5 domains, 12 existing capabilities reviewed). Spec references: `SPEC_FIELD_V2.md`.

Conventions:
- Task IDs: `<section>-T<n>`. `B` = blocker / external input, `K` = decision-task, `D1..D5` = domain (per GAP_ANALYSIS Part 1), `X` = dismantle/replace (per GAP_ANALYSIS Part 2).
- "Blocked" means cannot be started until the named blocker resolves (external input received, or decision-task closed).
- Constraints in force throughout: ONE bot (role-routed display); additive-only DB for the field layer; the CRM owns `Task.status` and the bot NEVER writes it; no PG enums (text + CHECK); UUID PKs with `gen_random_uuid()`; RLS deny-all on every new table; migration conventions identical to `001`-`008`.

---

## 0. Decisions log (locked 2026-06-30)

The 7 K-tasks from §2 are closed. Resolutions:

- **K1 — Inspector identification:** rule is `user.role !== 'ADMIN'`. No schema change, no new role value, no per-user flag column. Simpler than any of the 3 surfaced options. `D5-T1` collapses to a one-liner branch in the menu router; `D2-T1` is unblocked from the K1 axis.
- **K2 — `TaskField` scheduling mechanism:** CLOSED (2026-07-01). No field-task flag on `Task`. The CRM field scheduling form creates a `TaskField` row using an existing `Task ID`; `Task` remains the office / CRM customer task, and each `TaskField` row is one scheduled field visit / inspection appointment. One `Task` can have multiple `TaskField` rows. `Task.ownerId` is the assigned field worker; do not add `fieldWorkerId` to `TaskField`.
- **K3 — Yoram vs Sasha dispatcher routing:** option (a) — per-user routing inside `src/scheduler/jobs/digestDispatcher.ts`, keyed on a tiny bot-side mapping (env-var phone allow-list, or a 2-row lookup table). One scheduled job, two code paths inside. Two-cron-jobs rejected as over-engineered for ~2 users.
- **K4 — Old CRM manager digest:** option (c) — gate behind an env flag, default off. Precedent: `LEGACY_DAILY_SUMMARY_ENABLED` at `src/scheduler/index.ts:76`. Delete entirely once v2 has run cleanly in production for ~2 weeks.
- **K5 — Digest-preference sub-menu:** option (b) — hidden capability. Keep `UserDigestPreference` table + service as infrastructure. No menu entry. Accessible only via a free-text trigger. Worker menu stays at exactly 7 items per spec.
- **K6 — Daily greeting:** option (a) — keep AND auto-open the v2 inspections menu after it. Matches the §5 spec example "שלום דני, מה תרצה לעשות?".
- **K7 — STT provider:** OpenAI Whisper API. Hebrew supported. ~$0.006/min. Single env var (`OPENAI_API_KEY` or a dedicated `WHISPER_API_KEY`).

Downstream effect on task blockers: all K-decisions are closed. `D1-T4`, `D2-T2`, `D3-T3`, and `D5-T6` are no longer blocked on K2; they now target the CRM scheduling-form / unsent-`TaskField` model.

**2026-07-01 — B1, B2, and K2 RESOLVED.**
- **B1 resolved:** proceed with the clear, field-relevant מק"טים from the spec draft (lines 416-571). Shielding and borderline rows are skipped for now — include only unambiguous field-inspection types. `D1-T7` is unblocked.
- **B2 resolved:** table is `IncomingLead`. Columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`. Assignment field is `ownerId` (UUID FK to `User`). No phone column — messages display `fromName` / `fromEmail` / `subject` / `body`. `transferredToId` exists but is not used. All Domain 3 tasks unblocked; `D4-T1` leads portion unblocked.
- **K2 resolved:** the CRM field scheduling form creates `TaskField` using an existing `Task ID`. The bot detects/sends assignment cards from created `TaskField` rows where `workerNotifiedAt IS NULL`.

---

## 1. Blockers / external dependencies

These are inputs the bot team cannot produce internally. Work that depends on them is marked `Blocked: YES (B<n>)` throughout this document.

### B1 — InspectionType catalog (~150 מק"טים) sign-off
- **Status: RESOLVED (2026-07-01).** Proceed with the clear, field-relevant מק"טים from the draft at `SPEC_FIELD_V2.md` lines 416-571. Shielding rows and borderline non-inspection services are excluded from the initial seed — include only unambiguous field-inspection types. `D1-T7` is now unblocked.
- **What was needed:** the full, signed-off list of inspection מק"טים used to seed `InspectionType` — code (מק"ט), Hebrew label, family (one of the 13 CHECK values), `isActive`, `sortOrder`, and the `isFieldInspection` boolean per row.
- **Tasks previously gated on B1:** `D1-T7` (catalog seed) — now unblocked. Downstream verification of `D2-T2` (inspection card family label) also unblocked.

### B2 — `IncomingLead` table schema
- **Status: RESOLVED (2026-07-01).** All Domain 3 tasks unblocked; `D4-T1` leads portion unblocked.
- **Resolved details:**
  - **Table name:** `IncomingLead` (not `lead incoming` — old references in the spec/gap analysis are updated below).
  - **Columns:** `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`.
  - **Assignment field:** `ownerId` (UUID FK to `User`) — transitions from null/empty to a user ID when Sasha assigns in the CRM.
  - **No phone column** — lead messages display `fromName` / `fromEmail` / `subject` / `body`.
  - `transferredToId` exists on the table but is **not used** in the bot for now.
  - The spec's earlier question about whether `assignedTo` is a FK or free-text: it is a UUID FK (`ownerId`).
- **Tasks previously gated on B2:** `D3-T1`, `D3-T2`, `D3-T3`, `D3-T4` — all now unblocked. `D3-T3` is independent of K2 unless it deliberately reuses generic polling helpers. The leads-counts portion of `D4-T1` is also now unblocked.

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

### K2 — CRM scheduling form creates `TaskField`
- **Status: RESOLVED (2026-07-01).**
- **Decision:** no field-task flag on `Task` and no automatic `Task` → `TaskField` conversion. The CRM field scheduling form receives an existing `Task ID` and creates a `TaskField` row for one scheduled field visit / inspection appointment.
- **Card trigger:** the bot sends the inspection card when a created `TaskField` row exists and `workerNotifiedAt IS NULL`. After sending, the bot stamps `workerNotifiedAt` to prevent duplicate assignment-card sends.
- **Cardinality:** `TaskField.taskId` is not unique. One `Task` can have multiple scheduled `TaskField` rows.
- **Worker assignment:** `Task.ownerId` remains the assigned field worker. Do not add `fieldWorkerId` to `TaskField`.
- **Required creation validation:** `Task` exists; `Task.ownerId` exists; `Task.productName` exists; `Task.productName` matches `InspectionType.code`; scheduling form includes `scheduledStartAt`, `durationMinutes`, and location; `scheduledEndAt` is calculated from start time + duration. Do not send an inspection card unless `TaskField` was created successfully.
- **Unblocked by this decision:** `D1-T4`, `D2-T2`, `D3-T3`, `D5-T6`.

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

#### D1-T4 — CRM scheduling form creates `TaskField` using `Task ID`
- **Status:** OBSOLETE/REWRITTEN by K2 (2026-07-01). Do not add a field-task flag to `Task`.
- **What to do:** document the CRM scheduling-form contract instead of adding a `Task` flag. The form creates one `TaskField` row per scheduled field visit using an existing `Task ID`; `Task` remains the office / CRM customer task.
- **Definition of Done:** no migration adds a field-task flag column to `Task`; docs/migration comments state that `TaskField` is created from the CRM scheduling form using `Task ID`; validation rules are documented (`Task` exists, `ownerId`, `productName`, matching `InspectionType.code`, `scheduledStartAt`, `durationMinutes`, location, calculated `scheduledEndAt`).
- **Reference:** GAP Domain 1 row 4. Spec §1, §3.
- **Dependencies:** D1-T1, K2.
- **Blocked:** NO (K2 resolved 2026-07-01).

#### D1-T5 — `TaskField` table DDL (operational spine)
- **Status:** DONE (commit b288e72; original DDL commit f7aeaa0). K2 revision applied 2026-07-01 and committed: removed the old uniqueness constraint on `taskId`, added scheduling fields (`appointmentTitle`, `scheduledStartAt`, `scheduledEndAt`, `durationMinutes`, `workerNotifiedAt`), and added `idx_taskfield_task_id`. Note: a 13-value `CHECK` was added to `TaskField.family` (the snapshot column) to match `InspectionType`/`InspectionChecklist` — the raw spec block left it bare, but the build brief's hard constraints and this task spec both require it.
- **What to do:** extend `009_field_inspections.sql` with `TaskField`. Columns per spec §3, §4, migration block lines 297-336: UUID PK, `taskId` FK to `Task` (**not unique**; one `Task` can have multiple scheduled field visits), `inspectionTypeId` UUID FK to `InspectionType`, snapshot `family` text + CHECK (same 13 values), scheduling metadata (`appointmentTitle`, `scheduledStartAt`, `scheduledEndAt`, `durationMinutes`, `workerNotifiedAt`), static site metadata (`siteAddress`, `siteCity`, `fieldContactName`, `fieldContactPhone`, `navigationUrl`, `specialInstructions`), live `fieldStatus` text + CHECK over **exactly the 10 values** (`ASSIGNED, CONFIRMED, DECLINED, NEEDS_MORE_INFO, EN_ROUTE, ARRIVED, FINISHED_FIELD, WAITING_FOR_INFO, HAS_PROBLEM, CANCELED` — NO `STARTED`), per-status timestamps (`assignedAt, confirmedAt, declinedAt, departedAt, arrivedAt, finishedAt`), `declinedReason` text, inline problem (`problemType` text + CHECK over the 7 declared values, `problemNote` text, `hasOpenProblem` bool), missing-info (`missingReportInfo` bool, `missingReportInfoNote` text), `managerNotifiedAt` timestamp, `updatedByUserId` UUID FK to `User`, `createdAt/updatedAt` timestamps. `assignedAt` is row creation / system assignment time; `scheduledStartAt` is the planned inspection time. Index on `taskId`; index on `fieldStatus`; partial index `WHERE hasOpenProblem = true`. RLS deny-all.
- **Definition of Done:** table created; `taskId` allows multiple rows for the same `Task`; normal `idx_taskfield_task_id` exists; the 10-value CHECK rejects any other `fieldStatus`; the 7-value CHECK rejects any other `problemType`; scheduling fields exist with `scheduledStartAt`, `scheduledEndAt`, and positive `durationMinutes`; indexes present; RLS deny-all verified.
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
- **What to do:** idempotent `INSERT ... ON CONFLICT (code) DO NOTHING` block for the clear field-relevant מק"ט rows from `SPEC_FIELD_V2.md` lines 416-571. Shielding/borderline rows excluded for now. Set `isFieldInspection = true` for the relevant subset.
- **Definition of Done:** catalog seed runs idempotently; every row's `family` passes the CHECK; shielding/borderline rows omitted; re-runnable without duplicates.
- **Reference:** GAP Domain 1 row 1 (seed). Spec lines 416-571 (draft).
- **Dependencies:** D1-T2, B1.
- **Blocked:** NO (B1 resolved 2026-07-01 — proceed with unambiguous field-inspection rows).

### Cross-cutting infra prerequisites (interleaved here — needed before D2 menus and D3 reads)

#### D5-T1 — Inspector role detection + role-based menu routing
- **Status:** DONE (commit b288e72). `menuItemsFor` in `src/ai/menu.ts` implements K1: `user.role === 'ADMIN' → managerMenu(); else → employeeMenu()`. Comment in the function documents the deliberate v2 change from the old `isElevated` split. The three-way Yoram/Sasha/inspector routing at the dispatcher level is D4-T2 (not yet done). DoD is met: inspector sees v2 7-item menu; ADMIN (elevated) sees manager menu; tsc clean; 276/283 tests pass.
- **What to do:** extend `src/auth/userResolver.ts` and `src/ai/menu.ts` to recognize a field inspector per the K1 decision. The current `menuItemsFor` two-way branch (`isElevated` vs. not) becomes three-way: inspector → inspections menu (Domain 2); Sasha → leads-only display; Yoram → exceptions-only display; remaining elevated → fallback per K4.
- **Definition of Done:** an inspector calling the menu trigger sees the v2 inspections menu items only; a non-inspector elevated user sees no inspector menu; resolved role is logged in the audit trail.
- **Reference:** GAP Domain 5 row 1. Spec §1, §2.
- **Dependencies:** K1, K3, K4.
- **Blocked:** NO (K1, K3, K4 closed).

#### D5-T2 — Voice (`audio`) inbound: download + transcribe + route as text
- **Status:** DONE (commit a628b10). New `src/whatsapp/voice.ts` (Meta 2-step download + Whisper `/v1/audio/transcriptions`, `whisper-1`, `language=he`, K7) + `src/__tests__/voice.test.ts` (11 tests, all pass). `webhook.ts` audio branch seeds `WhatsappAuditLog` with `mediaId`, transcribes, feeds transcript through the existing `handleIncomingMessage` text path; fallback text `לא הצלחתי להבין את ההודעה הקולית…` on null. `utils/auditLog.ts`: `writeAuditLog` now returns the inserted id + new `updateTranscribedMessage(id, text)` helper (never throws) — 3 unrelated callers (`routes/tasks.ts`, `scheduler/jobs/digestDispatcher.ts`, `ai/router.ts`) got 1-line `await` conversions to preserve `Promise<void>` contracts. Deviations: raw `https.request` (mirrors `sender.ts`) instead of fetch, no new dep; audit-log helper lives in `utils/auditLog.ts` (no `whatsappAuditLog.ts` service exists in this repo). `OPENAI_API_KEY` already recognized by preflight — missing key logs a warn and no-ops.
- **What to do:** new file `src/whatsapp/voice.ts` (or similar). Extend `src/routes/webhook.ts processInbound` to handle `m.type === 'audio'`. Pipeline: download the Meta audio asset → call the STT provider chosen in K7 → write the transcript into the existing `WhatsappAuditLog.transcribedMessage` column (slot already exists from migration 001 line 54) → feed the transcript into the existing `handleIncomingMessage` text path. New env var for the STT credential.
- **Definition of Done:** sending a Hebrew voice message via WhatsApp results in: (a) the transcript stored in `WhatsappAuditLog.transcribedMessage`, (b) the same downstream routing as if the transcript had been typed.
- **Reference:** GAP Domain 5 row 2. Spec §5, §8, §9, §11, §14.
- **Dependencies:** K7.
- **Blocked:** NO (K7 closed).

#### D5-T3 — AI intent set rewrite for field statuses
- **Status:** DONE (commit a628b10). `ai/schema.ts` adds 3 new `AI_INTENTS` (`set_field_status`, `report_problem`, `report_missing_info`) + `FIELD_STATUS_TRANSITIONS` (5 values) + `FIELD_PROBLEM_TYPES` (7 values); JSON tool-call schema + Zod validator extended with strict `z.enum` (out-of-set values rejected per DoD). `types/index.ts`: `AIIntent` union extended, `FieldStatusTransition` + `FieldProblemType` exported. `intentParser.ts`: Hebrew few-shot mappings for all 5 transitions (יצאתי / הגעתי / סיימתי / מחכה למידע / יש בעיה), mapped + unmapped `problem_type` cases, missing-info notes, inline customer-ref ("יצאתי ללקוח כהן"). Legacy CRM intents preserved (X-T2 removes them). 20 new tests in `aiSchema.test.ts` across 8 describe blocks — all pass; existing 5 tests unchanged. Deviation: `transition` + `problem_type` land as top-level `AIIntentResult` fields (mirrors `field` / `new_value`) rather than inside `params` — required for strict `z.enum` rejection. Router untouched (`executeIntent` has a `default: helpText()` branch, no exhaustiveness fix needed) — the 3 new intents fall to `helpText()` until D2-T5 / T7 / T8 wire them.
- **What to do:** extend `src/ai/intentParser.ts` and `src/ai/schema.ts` with a new intent `set_field_status` and sub-types `DEPARTED / ARRIVED / FINISHED / WAITING_FOR_INFO / HAS_PROBLEM`. Also add `report_problem`, `report_missing_info`. Keep `help` and `unknown`. The drop of the old CRM intents (`list_tasks`, `create_task`, `edit_field`, `edit_duedate`, `reassign_task`, `relink_task`, `team_workload`, `confirm_pending_action`, `decline_pending_action`) is `X-T2` — keep them temporarily here for the transitional period.
- **Definition of Done:** "departed for Ra'anana", "arrived", "finished" all parse to `set_field_status` with the right sub-type; ambiguous cases route through the existing `task_disambig` path in `src/ai/router.ts` lines 286-296.
- **Reference:** GAP Domain 5 row 3, GAP Part 2 "Existing AI router + intent parser" row. Spec §5.
- **Dependencies:** D5-T1.
- **Blocked:** no (after D5-T1 done).

### Domain 2 — Worker side, field inspections (sections 5-11)

#### D2-T1 — Rewrite worker main menu (`employeeMenu()`) to the 7 v2 items
- **Status:** DONE (commit b288e72). `employeeMenu()` in `src/ai/menu.ts` has exactly 7 v2 items: הבדיקות שלי להיום / למחר / עדכון סטטוס / דיווח על בעיה / חסר ציוד / חסר מידע לדוח / סיכום יום. Per K5, digest_settings is absent from `employeeMenu()` (hidden capability — it remains in `managerMenu()` only). `menuItemsFor` routes !ADMIN → employeeMenu per K1. Items 1+2 (list_inspections_today/tomorrow) have stub "פונקציה זו בפיתוח" handlers in the router — real implementation lands in D2-T4. Deviation: items 1+2 stubs intentional; all other items are fully wired.
- **What to do:** rewrite `employeeMenu()` in `src/ai/menu.ts` (lines 51-61 today). The 7 items per spec §5: `הבדיקות שלי להיום`, `הבדיקות שלי למחר`, `עדכון סטטוס בדיקה`, `דיווח על בעיה`, `חסר ציוד`, `חסר מידע לדוח`, `סיכום יום`. Add 7 new `MenuAction` kinds: `list_inspections_today`, `list_inspections_tomorrow`, `update_inspection_status`, `report_problem`, `missing_equipment`, `missing_report_info`, `day_summary`. Per K5, digest-settings exposure is removed from this menu (default: hidden).
- **Definition of Done:** an inspector sees exactly the 7 v2 items, numbered, Hebrew, no emojis; replying with a number triggers the corresponding `MenuAction`; `MENU_TRIGGER_RE` (existing) re-opens the menu.
- **Reference:** GAP Domain 2 row 1. Spec §5.
- **Dependencies:** D5-T1, K5, K6.
- **Blocked:** NO (K5, K6 closed; K1 axis resolved via D5-T1).

#### D2-T2 — Inspection card emission on `TaskField` creation
- **Status:** DONE (local, uncommitted). New `src/services/inspectionAssignment.ts` — `findUnnotifiedTaskFields()` selects `WHERE workerNotifiedAt IS NULL`, joins `Task → User (ownerId)`, `InspectionType`, `Customer` (LEFT), ordered by `assignedAt`. `getEquipmentLabels(family)` reads `InspectionChecklist` sorted by `sortOrder`, deduped by `labelHe`. `formatInspectionCard` renders the spec §6 body verbatim (type / customer / address / date+time in Asia/Jerusalem / contact / equipment list / navigation / 3 numbered choices); missing optional fields are omitted rather than shown as placeholders. `sendAndStampAssignmentCard` calls `sendButtonMessage` with 3 deterministic payload IDs (`INSP_CONFIRM_<uuid>`, `INSP_DECLINE_<uuid>`, `INSP_NEED_INFO_<uuid>`), then UPDATEs `workerNotifiedAt = now()` guarded by `AND "workerNotifiedAt" IS NULL` so a concurrent stamp is a no-op. Send failures leave the row unstamped for the next tick to retry. Skips rows with no worker phone (warning). Tests: `src/__tests__/inspectionAssignment.test.ts` — payload IDs, query shape, dedup, layout, missing-field handling, send-then-stamp order, send-failure-does-not-stamp, no-phone skip. `npx tsc --noEmit` clean; `npx vitest run` — 299 passed / 7 skipped / 306 total. Deviations: (a) card lives in `services/inspectionAssignment.ts` rather than `services/inspections.ts` (the latter already exists as the D2-T5/T7/T8 write path; splitting keeps the polling send-path isolated). (b) Button titles are shortened to fit Meta's 20-char cap while preserving numbers ("1. מאשר" / "2. לא יכול" / "3. פרטים") — the full spec labels appear in the card body's numbered "בחר:" section.
- **What to do:** new file `src/services/inspections.ts` for `TaskField` reads/writes. New emission path detects created `TaskField` rows where `workerNotifiedAt IS NULL`; these rows come from the CRM field scheduling form using an existing `Task ID`. Load `TaskField` + `Task` + `InspectionType` + `Customer` + `InspectionChecklist` rows for the family + `User` from `Task.ownerId` (the assignee), assemble the card per spec §6 (type label, customer, address, `scheduledStartAt`, contact, equipment list, navigation link), and call `sendButtonMessage` with 3 reply buttons: `1. מאשר`, `2. לא יכול להגיע`, `3. צריך פרטים נוספים`. Use deterministic payload IDs (e.g. `INSP_CONFIRM_<taskFieldId>`, `INSP_DECLINE_<taskFieldId>`, `INSP_NEED_INFO_<taskFieldId>`). After successful send, stamp `workerNotifiedAt`.
- **Definition of Done:** a created `TaskField` row with `workerNotifiedAt IS NULL` results in the assigned worker (`Task.ownerId`) receiving one card with three labelled buttons matching spec §6 verbatim; successful sends set `workerNotifiedAt`; repeated polling does not send duplicates.
- **Reference:** GAP Domain 2 row 2. Spec §6.
- **Dependencies:** D1-T5, D1-T6, K2.
- **Blocked:** NO (K2 resolved). For end-to-end verification with a real family label, also B1.

#### D2-T3 — Inspection card button replies → `fieldStatus` writes
- **Status:** DONE (local, uncommitted). Five new write helpers in `src/services/inspections.ts`: `confirmInspection` (CONFIRMED + confirmedAt), `declineInspection` (DECLINED + declinedAt + declinedReason), `requestMoreInfo` (NEEDS_MORE_INFO + fieldNotes + managerNotifiedAt), plus `notifyOfficeDeclined` / `notifyOfficeNeedsMoreInfo` broadcasting to every active MANAGER/ADMIN via the existing `broadcastToManagers`/`loadAlertContext` helpers. Router (`src/ai/router.ts`): new `matchInspectionCardTap(text)` — anchored regex `^INSP_(CONFIRM|DECLINE|NEED_INFO)_([0-9a-f-]{36})$` — invoked ahead of AI/NLU inside `handleAIMessage`, same slot as `matchEquipmentTap`. `handleInspectionCardTap` — CONFIRM writes directly + acks + clears; DECLINE sets `awaiting: 'inspection_decline_reason'` with `taskFieldId` and prompts for a short reason; NEED_INFO sets `awaiting: 'inspection_need_info_note'` and prompts for follow-up text. Two new `AwaitingKind`s added to `conversationContext.ts` (`inspection_decline_reason`, `inspection_need_info_note`) — `continueConversation` handles both via `handleInspectionDeclineReasonReply` / `handleInspectionNeedInfoNoteReply`, which run the write + notify pair and reply "עדכנתי. המשרד קיבל התראה." — empty text keeps the awaiting state and re-prompts. Interactive-message handling already routes button `id` through the text path in `webhook.ts:162-170` (no webhook change needed). Tests: 5 new write/notify cases in `src/__tests__/inspections.test.ts` (SQL shape + params for all 3 writes, alert body content for both notifies); 7 new tap-driven cases in `src/__tests__/routerInspections.test.ts` (CONFIRM ack, DECLINE prompt, DECLINE reason capture, DECLINE empty-reason re-prompt, NEED_INFO prompt, NEED_INFO note capture, non-matching INSP_* payload falls through). `npx tsc --noEmit` clean; `npx vitest run` — 299 passed / 7 skipped / 306 total. Deviation: NEEDS_MORE_INFO follow-up text is persisted to `fieldNotes` (no dedicated column exists on `TaskField` for assignment-time questions; the migration comment "field notes + single inline problem" makes it the natural home). The office receives the text in the alert, so durability is not required, but persisting preserves the request across CRM-side inspection review.
- **What to do:** extend `src/routes/webhook.ts` interactive-message handler (lines 162-170 today) to route the 3 stable payload IDs from D2-T2 to `TaskField` updates: `INSP_CONFIRM_*` → `fieldStatus = CONFIRMED` + `confirmedAt`; `INSP_DECLINE_*` → `fieldStatus = DECLINED` + `declinedAt` + prompt for short `declinedReason` (new `conversationContext.awaiting` state) + alert office; `INSP_NEED_INFO_*` → `fieldStatus = NEEDS_MORE_INFO` + prompt for free-text follow-up (new awaiting state).
- **Definition of Done:** each button tap writes the right `fieldStatus`, sets the right timestamp, persists `declinedReason` when supplied, and emits the office alert; the next inbound text from the same user lands in the right `awaiting` slot.
- **Reference:** GAP Domain 2 row 3. Spec §6, §7.
- **Dependencies:** D1-T5, D2-T2.
- **Blocked:** no (after D2-T2).

#### D2-T4 — Worker morning reminder: today's inspections + numbered status update
- **Status:** DONE (commit b288e72). `getInspectionsForWorkerOnDate(userId, localDate)` in `src/services/inspectionsQueries.ts` filters/orders by `scheduledStartAt`. `formatInspectorMorning(items, user)` in `src/whatsapp/digestContent.ts` — Hebrew numbered list per spec §7, all 8 status labels, null-tolerant. Dispatcher in `src/scheduler/jobs/digestDispatcher.ts` routes non-ADMIN → `formatInspectorMorning` (X-T3 done here). Tests: `inspectorMorning.test.ts` + `inspectorMorningDispatcher.test.ts` — all pass. tsc clean.
- **What to do:** extend `src/scheduler/jobs/digestDispatcher.ts` so that — for users identified as inspectors per K1/D5-T1 — the morning slot sends inspections where `TaskField.scheduledStartAt` falls on the local day (numbered, ordered by `scheduledStartAt`) + a "choose a number to update status" prompt. New content formatter in `src/whatsapp/digestContent.ts` (replaces `formatEmployeeMorning` for inspectors; old CRM formatter handled by `X-T3`). Numbered-reply pattern reused from `src/ai/router.ts`. Per-day dedup via `src/services/digestSendLog.ts`.
- **Definition of Done:** an inspector with N inspections today receives one Hebrew message listing all N numbered, with a status-update prompt; dispatcher dedup prevents a second send the same day.
- **Reference:** GAP Domain 2 row 4. Spec §7.
- **Dependencies:** D1-T5, D2-T1, D5-T1.
- **Blocked:** NO (K1 axis resolved; query contract updated to `scheduledStartAt`).

#### D2-T5 — Worker on-demand status transitions (departed / arrived / finished)
- **Status:** DONE (commit b288e72). `services/inspections.ts` gained `advanceFieldStatus({ taskFieldId, transition, updatedBy })` — 3-way switch on the `AdvanceTransition` union (`DEPARTED|ARRIVED|FINISHED`, narrowed at the type level so `WAITING_FOR_INFO`/`HAS_PROBLEM` are not accepted here; those still route through `writeMissingInfo`/`writeProblem`). FINISHED write is unconditional (only `WHERE id = $1` — no CHECK-current-status guard). Also added `resolveOpenTaskFieldByHint(userId, hint)` — parameterized ILIKE substring on `Customer.name` OR `TaskField.siteAddress` (`'%' || $2 || '%'`), same OPEN_FIELD_STATUSES filter as `findOpenTaskFieldForWorker`, empty-hint short-circuit. `ai/menu.ts` gained `statusUpdateMenu()` + `renderStatusUpdateMenu()` (3 items). `ai/router.ts`: menu route 3 replaced (`startStatusUpdateFlow` → `renderStatusUpdateMenu` → `status_choice` awaiting → `advanceFieldStatus` + "עדכנתי — סטטוס: …" reply; FINISHED opens the D2-T6 follow-up). D5-T3 `set_field_status` intent wired in `executeIntent`: DEPARTED/ARRIVED/FINISHED → `runAdvanceStatusDirect` (with hint via `resolveOpenTaskFieldByHint` when `intent.task_reference` set); WAITING_FOR_INFO → D2-T7 path (with `params.note` short-circuit); HAS_PROBLEM → D2-T8 path (with `problem_type` short-circuit). The previously-stubbed `missing_info_disambig`/`problem_disambig` are now wired via a shared `handleDisambigReply` that resolves the hint and transitions to the right follow-up state (`missing_info_note`/`problem_type_choice`); "ביטול" clears; no match keeps awaiting. New `AwaitingKind`s: `status_choice`, `status_disambig`. `pendingTransition?: FieldStatusTransition` added to `ConversationState` so a free-text disambig hint carries the requested transition across turns. Tests: `__tests__/inspections.test.ts` — 3 `advanceFieldStatus` cases (per transition, asserting sibling timestamps untouched, FINISHED assert no `AND "fieldStatus"` guard), 5 `resolveOpenTaskFieldByHint` cases (0/1/N + ILIKE parameterization + empty short-circuit). `__tests__/routerInspections.test.ts` — 7 D2-T5 menu-driven cases + 5 `set_field_status` intent cases + 6 disambig-resolution cases. Full suite: 233 pass / 7 skipped / 240 total (was 183/7/190). `npx tsc --noEmit` clean. No deviations.
- **What to do:** in `src/services/inspections.ts`, implement `advanceFieldStatus(taskFieldId, transition)` for `EN_ROUTE` ("departed", + `departedAt`), `ARRIVED` ("arrived", + `arrivedAt`), `FINISHED_FIELD` ("finished", + `finishedAt`, **unconditional**). Wire to: (a) the menu item 3 numbered-reply path, (b) the free-text/voice routing via D5-T3 intents.
- **Definition of Done:** each transition writes the correct `fieldStatus` and timestamp; "finished" never blocks; ambiguity when the worker has multiple inspections today routes through the existing `task_disambig` style flow.
- **Reference:** GAP Domain 2 row 4. Spec §7.
- **Dependencies:** D1-T5, D2-T4, D5-T3.
- **Blocked:** no (after deps).

#### D2-T6 — Finished follow-up 4-option menu
- **Status:** DONE (commit b288e72). Landed in the same edits as D2-T5. `services/inspections.ts` gained `writeFieldNotes({ taskFieldId, notes, updatedBy })` — writes only `fieldNotes` + `updatedByUserId` + `updatedAt` (no `fieldStatus`/`finishedAt`/`managerNotifiedAt` touched; the FINISHED_FIELD write already happened). `fieldNotes` column already exists on `TaskField` from D1-T5, no migration change needed. `ai/menu.ts` gained `finishedFollowUpMenu()` + `renderFinishedFollowUpMenu()` (4 items, numbered text per D5-T4). `ai/router.ts`: after `performTransition(...,'FINISHED')` we set `awaiting: 'finished_followup'` (retaining `taskFieldId`) and send the 4-option menu. `handleFinishedFollowUpReply`: option 1 → "רשמנו. כל טוב!" + clear; option 2 → prompt "מה ההערות מהשטח?" + `awaiting: 'finished_notes'`; option 3 → hand off to D2-T8 (`awaiting: 'problem_type_choice'` + `renderProblemTypeMenu()` — reuses the already-known `taskFieldId`, no re-lookup); option 4 → hand off to D2-T7 (`awaiting: 'missing_info_note'` + "מה חסר לדוח?"). Invalid input → resend menu with "בחר מספר תקין:" prefix, keep awaiting. `handleFinishedNotesReply` captures the text (voice arrives as text via D5-T2) and calls `writeFieldNotes`, then "נשמר. תודה." + clear. New `AwaitingKind`s: `finished_followup`, `finished_notes`. Tests: `__tests__/inspections.test.ts` — `writeFieldNotes` asserts fieldNotes/updatedByUserId/updatedAt only, no other columns touched. `__tests__/routerInspections.test.ts` — 5 D2-T6 cases (option 1, option 2 flow with notes write, options 3/4 hand-offs asserting no re-lookup, invalid input). Full suite: 233 pass / 7 skipped / 240 total. No deviations.
- **What to do:** after `FINISHED_FIELD` writes successfully, send the 4-option follow-up menu (`אין הערות` / `יש הערות מהשטח` / `יש בעיה` / `חסר מידע לדוח`). Option 2 → free text → save to `fieldNotes` (a column on `TaskField` — confirm it exists in D1-T5 schema; if not, add a `fieldNotes` text column to D1-T5). Option 3 → route to D2-T8 (problem flow). Option 4 → route to D2-T7 (missing-info flow).
- **Definition of Done:** after a finished write, the worker receives the 4-option menu; option 1 ends the flow; option 2 captures notes; options 3/4 hand off cleanly to the right downstream flow.
- **Reference:** GAP Domain 2 row 5. Spec §7.
- **Dependencies:** D2-T5.
- **Blocked:** no.

#### D2-T7 — "Missing info for report" flow
- **Status:** DONE (commit b288e72). New `src/services/inspections.ts` (~230 LOC — `writeMissingInfo`, `findOpenTaskFieldForWorker`, `notifyOfficeMissingInfo` + shared `writeProblem` / `notifyOfficeProblem` for D2-T8, all queries parameterized). `src/ai/router.ts`: menu route 6 replaced (prompts "מה חסר לדוח?" → new `missing_info_note` awaiting state → `writeMissingInfo` + `notifyOfficeMissingInfo` → "עדכנתי. המשרד קיבל התראה."); D5-T3 free-text intent `report_missing_info` wired in `executeIntent` (skips prompt when `params.note` is set). `src/services/conversationContext.ts` extended with 5 new `AwaitingKind`s + `taskFieldId` / `problemType` state fields. Ambiguous case (>1 open TaskField) captures `missing_info_disambig` state with a TODO(D2-T5) message — D2-T5 will resolve. Office recipient uses existing `getManagersForBroadcast()` (active MANAGER/ADMIN with a phone) — matches how the due-date approval flow broadcasts today; when no managers exist, logs a warning and no-ops the send (the write already stamped `managerNotifiedAt`). Verified `Task.ownerId` column name against `src/services/tasks.ts` (no `assigneeId` in this schema). Tests: `src/__tests__/inspections.test.ts` (20/20 pass); `src/__tests__/routerInspections.test.ts` (17/17 pass). Full suite: 183 pass / 7 skipped. `npx tsc --noEmit` clean.
- **What to do:** new flow triggered by menu item 6 or by the post-finished menu option 4. Prompt: "מה חסר לדוח?" → accept free text or voice → set `fieldStatus = WAITING_FOR_INFO`, `missingReportInfo = true`, `missingReportInfoNote = <text>`, `managerNotifiedAt = now()` → alert the office via `sendTextMessage`. Voice transcripts arrive here automatically via D5-T2.
- **Definition of Done:** the four `TaskField` fields are written; the office receives an alert containing the worker name, the inspection identity, and the missing-info note.
- **Reference:** GAP Domain 2 row 6. Spec §8.
- **Dependencies:** D1-T5, D5-T2, D5-T3.
- **Blocked:** NO (D5-T2/K7 closed).

#### D2-T8 — "Report a problem" flow (7-item numbered sub-menu)
- **Status:** DONE (commit b288e72). Shipped in the same commit as D2-T7 — the 4 write/query helpers live together in the new `src/services/inspections.ts`. `src/ai/menu.ts` gained `problemTypeMenu()` + `renderProblemTypeMenu()` exports (7 items numbered 1–7, Hebrew labels, `problemType` machine values verbatim from the CHECK constraint on `TaskField.problemType` in migration 009). `src/ai/router.ts`: menu route 4 replaced (findOpenTaskFieldForWorker → `renderProblemTypeMenu` → new `problem_type_choice` awaiting state; types 1–5 write directly with `note=null`; types 6 [PROFESSIONAL_ISSUE] / 7 [OTHER] transition to `problem_type_note` awaiting state and write on the follow-up reply; invalid number → resend menu with "בחר מספר תקין:" prefix, keep awaiting). D5-T3 free-text intent `report_problem` wired: skips the sub-menu when `problem_type` is set on the intent; otherwise runs the same menu-driven flow. Manager alert per spec §9 (בעיה מהשטח / עובד / בדיקה / לקוח / סוג / detail / לטיפול מנהל.) broadcast via `getManagersForBroadcast()`. Tests: 5 problem-type param tests (types 1–5 direct write); 2 elaboration tests (6, 7); invalid-input resend; ambiguous & no-open branches; D5-T3 direct-dispatch tests. Full suite: 183 pass / 7 skipped. `npx tsc --noEmit` clean.
- **What to do:** new flow triggered by menu item 4 or by the post-finished menu option 3. Render the 7 problem types numbered: `CUSTOMER_NOT_ANSWERING / NO_ACCESS / CUSTOMER_NOT_PRESENT / MISSING_EQUIPMENT / CANNOT_PERFORM / PROFESSIONAL_ISSUE / OTHER`. Options 6 ("בעיה מקצועית") and 7 ("אחר") prompt for free-text elaboration. Write `problemType`, `problemNote`, `hasOpenProblem = true`, `fieldStatus = HAS_PROBLEM`. Send the spec-§9 alert to the manager.
- **Definition of Done:** every problem type writes the right `problemType`; options 6 and 7 also write `problemNote`; the manager alert text matches the spec §9 template; only ONE open problem at a time per `TaskField` (per spec §9 — multi-problem is deferred via `TaskFieldEntry`).
- **Reference:** GAP Domain 2 row 7. Spec §9.
- **Dependencies:** D1-T5, D5-T3.
- **Blocked:** no.

#### D2-T9 — Equipment reminder (morning roll-up by family)
- **Status:** DONE (commit b288e72). `getEquipmentChecklistForFamilies(families)` in `src/services/inspectionsQueries.ts` — deduped by `labelHe`, returns `EquipmentChecklistItem[]`. `formatEquipmentReminder(items, user)` + `equipmentTakenAllPayloadId` / `equipmentMissingPayloadId` in `src/whatsapp/digestContent.ts`. `maybeDispatchEquipmentReminder(row)` in `src/scheduler/jobs/digestDispatcher.ts` — piggybacked on the MORNING slot, own `EQUIPMENT_MORNING` dedup key. Button handler in `src/ai/router.ts`: `EQUIP_ALL_*` → ack + clear; `EQUIP_MISSING_*` → `equipment_missing_note` awaiting → free-text → manager alert. Menu item 5 also opens the "חסר ציוד" flow. Tests: `equipmentReminder.test.ts` (formatter — 5 cases), `equipmentQuery.test.ts` (query — 2 cases), `equipmentReminderDispatcher.test.ts` (dispatcher routing). All pass.
- **What to do:** new job (or piggyback on D2-T4) that, for each inspector with inspections where `TaskField.scheduledStartAt` falls today, aggregates the required equipment by joining each inspection's `family` to `InspectionChecklist` rows. Send one message listing the unique equipment items + 2 buttons via `sendButtonMessage`: `לקחתי הכל` / `חסר לי ציוד`. The second button → free-text prompt → manager alert.
- **Definition of Done:** worker with two inspections in different families receives one consolidated equipment list (deduped); "חסר לי ציוד" handler captures the free-text item and alerts the manager.
- **Reference:** GAP Domain 2 row 8. Spec §10.
- **Dependencies:** D1-T3, D1-T5, D1-T6, D2-T4.
- **Blocked:** no.

#### D2-T10 — On-demand worker day summary (menu item 7)
- **Status:** DONE (commit b288e72). `getFieldSummaryForWorkerOnDate(userId, localDate)` in `src/services/inspectionsQueries.ts` filters/orders by `scheduledStartAt`. `dayFieldSummary(userId, localDate)` in `src/services/inspections.ts`. `formatDaySummary` + `daySummaryFollowUpMenu()` + `renderDaySummaryFollowUpMenu()` in `src/whatsapp/digestContent.ts` + `src/ai/menu.ts`. Router: menu item 7 → `startDaySummaryFlow` → `day_summary_choice` awaiting; option 1 → "כל הכבוד!"; options 2/3/4 hand off to D2-T7/call-back-later/D2-T8. Tests: `daySummary.test.ts` + `routerDaySummary.test.ts` (20 cases). All pass. No new DB tables written per spec §14.
- **What to do:** new service method `dayFieldSummary(userId, date)` in `src/services/inspections.ts`. Reads today's `TaskField` rows for the worker by `scheduledStartAt`, lists those at `FINISHED_FIELD`, counts `WAITING_FOR_INFO`. Then renders a 4-option menu (`הכל בוצע` / `חסר מידע לדוח` / `צריך לחזור ללקוח` / `בעיה פתוחה`); options 2-4 hand back into D2-T7 / a (light) "call back later" handler / D2-T8 respectively. **No `FieldWorkerDayClose` DB write** — deferred per §14.
- **Definition of Done:** the menu produces a Hebrew summary of today's finished inspections and the waiting-for-info count; options 2-4 hand off to existing flows; no new tables are written.
- **Reference:** GAP Domain 2 row 9. Spec §11.
- **Dependencies:** D1-T5, D2-T1, D2-T7, D2-T8.
- **Blocked:** no.

### Domain 3 — Leads stream (Sasha)

#### D3-T1 — `IncomingLead` reader service
- **Status:** DONE (local, uncommitted). New file `src/services/incomingLeads.ts`. Exports: `IncomingLeadRow`, `AssignedLeadRow`, `findUnassignedInWindow(from, to)`, `findOvernightUnassignedLeads(localDate)` (DST-aware PostgreSQL window: prev-day 17:00 → today 09:30 Jerusalem), `findNewlyAssignedLeads(limit?)` (JOIN User, role != ADMIN, NOT EXISTS WLN ASSIGNED_TO_WORKER), `findEscalationCandidates(limit?)` (ownerId NULL, >1h old, 09:30–22:00 Jerusalem, NOT EXISTS WLN ESCALATED_1H), `findActiveInspectors()`. Also new `src/services/leadNotificationLog.ts` with `claimLeadNotification(leadId, eventKind)` (INSERT-first dedup into WhatsappLeadNotification). Migration 010 (`WhatsappLeadNotification` dedup table) already committed. Tests: `src/__tests__/incomingLeads.test.ts` (9 cases). tsc clean; 329/336 tests pass. Deviation: function names differ from spec (renamed to match actual callers; `findOvernightUnassignedLeads` replaces `findUnassignedInWindow` for D3-T2; `findNewlyAssignedLeads` replaces `findRecentlyAssigned`; dedup checks included in queries rather than delegated to callers).
- **What to do:** new file `src/services/incomingLeads.ts`. Read-only queries against the `IncomingLead` table. Columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`. No phone — messages use `fromName`/`fromEmail`/`subject`/`body`. Provide: `findUnassignedInWindow(from, to)` (where `ownerId IS NULL`), `findUnassignedOlderThan(minutes, createdBetween)`, `findRecentlyAssigned(sinceTimestamp)` (where `ownerId` just flipped from null). The bot WRITES NOTHING to this table — handling and assignment happen in the CRM.
- **Definition of Done:** functions return typed `IncomingLeadRow` rows; pool from `src/db/connection.ts`; no INSERTs/UPDATEs; column names match B2 resolution.
- **Reference:** GAP Domain 3 row 1. Spec §12.
- **Dependencies:** B2.
- **Blocked:** NO (B2 resolved 2026-07-01).

#### D3-T2 — Sasha 09:30 morning leads digest
- **Status:** DONE (local, uncommitted). `DigestType` in `src/services/digestSendLog.ts` extended with `'LEADS_MORNING'`. Formatter `formatSashaLeadsMorning(leads, suggestions, user)` + supporting types (`LeadDigestRow`, `LeadDigestSuggestion`) added to `src/whatsapp/digestContent.ts` (numbered list: sender, subject, body truncated to 200 chars, AI suggestion; empty → "לא התקבלו לידים ממתינים"). Sasha branch added to `src/scheduler/jobs/digestDispatcher.ts`: phone matched against `SASHA_PHONE` env var (same pattern as `YORAM_PHONE`); if 09:30 window fires → `claimDigestSend(userId, 'LEADS_MORNING', localDate)` → fetch overnight leads + AI suggestions in parallel → `formatSashaLeadsMorning` → `sendTextMessage` (no template yet — D5-T5 scope). Normal MORNING/EVENING are suppressed for Sasha (`continue` in loop). SASHA_PHONE preflight warning added. `.env.example` updated. Also partially completes D4-T2 (Sasha dispatcher branch wired). Tests: `src/__tests__/sashaLeadsMorning.test.ts` (8 cases) + `src/__tests__/sashaLeadsDispatcher.test.ts` (5 cases). Deviations: uses `sendTextMessage` directly (no template key registered yet; D5-T5 scope); no dedicated cron — routed through existing `digestDispatcher` every-5-min run with the `isDigestDue('09:30', ...)` check.
- **What to do:** new digest type `LEADS_MORNING` (or a Sasha-only flavor per K3). Content formatter in `src/whatsapp/digestContent.ts`: list all `IncomingLead` rows from 17:00 yesterday → 09:30 today where `ownerId IS NULL`, per spec §12 format. Display `fromName` / `fromEmail` / `subject` / `body` (no phone). Include per-lead AI suggestion of the best-matching worker by ROLE (from D3-T5). New cron entry at 09:30 (either a per-Sasha `UserDigestPreference` row, or a dedicated job).
- **Definition of Done:** at 09:30 local (`Asia/Jerusalem`), Sasha receives one message listing overnight unassigned leads with AI suggestions; per-day dedup via `digestSendLog`; advisory-lock protected.
- **Reference:** GAP Domain 3 row 2. Spec §12.
- **Dependencies:** D3-T1, D3-T5, K3.
- **Blocked:** NO (B2 resolved; K3 closed to option (a)).

#### D3-T3 — Worker-assignment alert (`ownerId` transitions null → user)
- **Status:** DONE (local, uncommitted). New file `src/scheduler/jobs/leadAssignmentNotifier.ts` (`runLeadAssignmentNotifier` → `processAssignmentAlerts` + `processEscalations`). D3-T3 path: `findNewlyAssignedLeads()` → INSERT-first `claimLeadNotification(leadId, 'ASSIGNED_TO_WORKER')` → `sendTextMessage` to worker (alert: sender, subject, body, "לטיפול ועדכון ב-CRM"). Skips workers with no phone. Per-lead failures isolated. Registered in `scheduler/index.ts` at `*/2 * * * *`, lock ID 1010. Dedup is via `WhatsappLeadNotification` (migration 010) — NOT via `IncomingLead.notifiedAt` (CRM-owned column not written). Tests: in `src/__tests__/leadAssignmentNotifier.test.ts`.
- **What to do:** new polling job in `src/scheduler/jobs/leadAssignmentNotifier.ts` (mirroring `completionNotifier.ts` lines 16-37). Polls `IncomingLead` for rows where `ownerId` just flipped from null to a `User.id`. Alert content: `fromName` / `fromEmail` / `subject` / `body` + "לטיפול ועדכון ב-CRM" (no phone; read-only). Dedup: use `IncomingLead.notifiedAt` — stamp it on the bot side after sending (NOT via a column on the CRM table — use a bot-side mirror table if `notifiedAt` is not writable, or confirm it is a bot-writable column).
- **Definition of Done:** when `ownerId` flips from null to a `User` who is an inspector (`role !== 'ADMIN'`), that inspector receives one alert and only one; restarts don't re-alert.
- **Reference:** GAP Domain 3 row 3. Spec §12.
- **Dependencies:** D3-T1. Optional: reuse generic polling/dedup infrastructure from D5-T6 if that helper exists, but lead assignment is independent of K2.
- **Blocked:** NO (B2 and K2 resolved).

#### D3-T4 — 1-hour escalation to Sasha for unassigned daytime leads
- **Status:** DONE (local, uncommitted). D3-T4 path in `src/scheduler/jobs/leadAssignmentNotifier.ts` `processEscalations`: `findEscalationCandidates()` (ownerId IS NULL, >1h old, 09:30–22:00 Jerusalem local time) → `findActiveInspectors()` → per-lead `claimLeadNotification(leadId, 'ESCALATED_1H')` → `suggestWorkerForLead` → `sendTextMessage` to `SASHA_PHONE` (escalation alert: sender, subject, body, AI suggestion, "לשיבוץ ב-CRM"). Silently skips when `SASHA_PHONE` is unset. Per-lead failures isolated. Dedup via `WhatsappLeadNotification(leadId, 'ESCALATED_1H')` — INSERT-first before send (at-most-once per lead). Tests: `src/__tests__/leadAssignmentNotifier.test.ts` (9 cases total for D3-T3 + D3-T4). tsc clean; 329/336 tests pass.
- **What to do:** add to the polling job from D3-T3: any `IncomingLead` row where `ownerId IS NULL` and `receivedAt` is between 09:30-22:00 local and more than 1 hour ago → ONE alert to Sasha including the AI suggestion (D3-T5) or "לא נמצאה התאמה". Display: `fromName` / `fromEmail` / `subject` / `body`. Overnight leads (17:00-09:30) are skipped — covered by D3-T2. Dedup must guarantee exactly one event per lead.
- **Definition of Done:** a lead with `receivedAt` at 11:00, still `ownerId IS NULL` at 12:00, triggers ONE Sasha alert; overnight leads never trigger; restarts don't re-fire.
- **Reference:** GAP Domain 3 row 4. Spec §12.
- **Dependencies:** D3-T1, D3-T3, D3-T5.
- **Blocked:** NO (B2 resolved; lead assignment/escalation is independent of K2).

#### D3-T5 — AI suggest-worker-by-role function
- **Status:** DONE (commit b288e72). Landed as new sibling file `src/ai/leadSuggester.ts` (not extended into `provider.ts`) exporting `suggestWorkerForLead(lead, candidates, provider?)`. Uses the existing `getProvider()` seam via `emitStructured`, strict JSON schema `{ userId: string|null, reason: string }`. Returns `{ userId: null, reason: 'לא נמצאה התאמה' }` on any of: empty candidates (no AI call), null provider, thrown error, hallucinated userId (not in candidate list). Never throws. Optional third `provider` param mirrors `parseIntent`'s pattern in `intentParser.ts:130-133` — real callers pass just two args; tests inject a mock directly. Per K1, inspector filtering (`role !== 'ADMIN'`) is the caller's responsibility. Tests: `src/__tests__/leadSuggester.test.ts` — 7/7 passing (empty candidates, disabled provider, valid pick, hallucinated id, provider throws, radiation sample, null-with-reason-kept).
- **What to do:** new function in `src/ai/provider.ts` (or a sibling file) that takes a lead's `service`/message text + the list of inspector `User` rows and returns a single suggested `User.id` (or null with reason). System prompt maps the lead text → best `User.role` → candidate. Strictly a suggestion; never auto-assigns.
- **Definition of Done:** for a sample lead "בדיקת קרינה ברעננה", the function returns an inspector whose role matches "קרינה"; for an off-topic message, returns null with "לא נמצאה התאמה".
- **Reference:** GAP Domain 3 row 5. Spec §12.
- **Dependencies:** D5-T1 (need to know which `User`s are inspectors).
- **Blocked:** no (the AI call itself isn't blocked; the lead text input is via B2 which gates the consumers D3-T2 / D3-T4, not this function).

### Domain 4 — Manager digest / exceptions (Yoram + Sasha)

#### D4-T1 — Yoram exceptions digest (morning + evening) content
- **Status:** PARTIAL — FIELD portion DONE (commit b288e72). LEADS portion outstanding (D3-T1 is now done so the IncomingLead reader is available; the Yoram digest still shows the `LEADS_TODO_LINE` placeholder). D4-T2 Sasha branch wired (local, uncommitted — see D3-T2 / D4-T2 status above); Yoram's existing branch unchanged. New file `src/services/exceptionsQueries.ts` — read-only, parameterized: `getFieldExceptionCounts(localDate)` (5 counts per §13: בוצעו / לא אושרו / עם בעיה / ממתינות למידע / לא סגרו יום, all in ONE round-trip via `COUNT(*) FILTER` + a `bounds` CTE for the Asia/Jerusalem half-open window) + `getOpenFieldExceptions(localDate)` (LEFT JOIN Task→Customer, LEFT JOIN Task→User via `Task.ownerId`, WHERE `hasOpenProblem = true` OR (`missingReportInfo = true` AND `fieldStatus = 'WAITING_FOR_INFO'`), ordered by `managerNotifiedAt ASC NULLS LAST`). New formatters in `src/whatsapp/digestContent.ts`: `formatGalitManagerMorning` + `formatGalitManagerEndOfDay` (no emojis per spec, no CTA button; header + field counts row + leads placeholder still pending integration + numbered `פתוחים:` list or `אין חריגים פתוחים.` one-liner; null-tolerant worker/customer → `עובד לא ידוע`/`לקוח לא ידוע`; note fallback: `problemNote` / `missingReportInfoNote` → `problemType` Hebrew label from `problemTypeMenu()` → `—`). `src/scheduler/jobs/digestDispatcher.ts`: new Yoram branch in `buildContent` fires BEFORE both the D2-T4 inspector branch AND the legacy ADMIN branch when `normalizeIsraeliPhone(row.user_phone) === normalizeIsraeliPhone(YORAM_PHONE)`; `YORAM_PHONE` is cached OUTSIDE the `for (const row of rows)` loop so non-Yoram rows pay only a string-compare — no N+1 env-parse fan-out. Dedup ledger (`claimDigestSend(userId, MORNING|EVENING, localDate)`) untouched — Yoram writes the same digestType so the existing PK covers him. Legacy paths preserved when `YORAM_PHONE` unset/empty/unparseable. Phone normalization reuses `normalizeIsraeliPhone` from `src/auth/phoneNormalizer.ts` — no new helper. `src/config/preflight.ts`: added a production-only warning when `YORAM_PHONE` is unset; app never crashes on absence. `.env.example`: added `YORAM_PHONE=` block with K3/B2 context. Tests: `src/__tests__/galitManagerDigest.test.ts` (12 formatter cases — empty/N exceptions, null worker+customer, note-null-with-problemType fallback, note+problemType both null → `—`, null user name, counts row content, leads TODO present for both formatters) + `src/__tests__/galitManagerDispatcher.test.ts` (9 routing cases — MORNING+EVENING match, MORNING+EVENING unset, whitespace-only YORAM_PHONE, different-ADMIN-phone falls through to legacy, MANAGER whose phone matches STILL wins the Yoram branch, `claimDigestSend`-false skips send). Split into two files because `vi.mock('../whatsapp/digestContent', ...)` is file-hoisted and would replace the real formatters in the pure suite. `npx tsc --noEmit` clean; `npx vitest run` — 233 passed / 7 skipped / 240 total (baseline before this task was 183/7/190 per brief; the delta is Wave-2 test files landing between the brief being written and this task starting). Deviations: (1) LEADS portion outstanding; B2 is resolved. (2) `getOpenFieldExceptions` takes `localDate` in its signature for API symmetry but does NOT filter by date — an open problem from yesterday is still open today; commented in the module. (3) `hasProblemToday` count considers rows either finished-today OR assigned-today-still-open, so a same-day problem counts even if unfinished. (4) preflight warning is `productionOnly`, following the precedent of other optional-in-dev keys.
- **What to do:** new formatters `formatGalitManagerMorning` / `formatGalitManagerEndOfDay` in `src/whatsapp/digestContent.ts` (or rename and replace the existing `formatManagerMorning` / `formatManagerEndOfDay` per K4). New aggregation queries against `TaskField` for the 5 field counts (`בוצעו / לא אושרו / עם בעיה / ממתינות למידע / לא סגרו יום`) and against `IncomingLead` for the leads numbers (מהלילה / לא שויכו). Also the numbered list of OPEN exceptions = workers + customers + free-text issue (from `problemNote` / `missingReportInfoNote`).
- **Definition of Done:** Yoram's morning and evening messages match the §13 format; counts come from `TaskField` queries; open-exceptions list is sorted (suggested: by `managerNotifiedAt`); dispatcher uses the existing 08:00/17:00 default times unchanged for Yoram.
- **Reference:** GAP Domain 4 rows 1, 3. Spec §13.
- **Dependencies:** D1-T5, D3-T1 (for the leads counts).
- **Blocked:** NO — B2 resolved (2026-07-01); leads portion now unblocked. `IncomingLead` columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`.

#### D4-T2 — Dispatcher branch Yoram vs. Sasha vs. other elevated
- **Status:** PARTIAL (local, uncommitted). Sasha branch wired (D3-T2 landing): `SASHA_PHONE` env var checked before normal MORNING/EVENING in `runDigestDispatcher` loop; matched phone → `dispatchSashaLeadsMorning` at 09:30, then `continue` (suppresses MORNING/EVENING for Sasha). Yoram branch was already wired (D4-T1). Residual elevated path (other ADMIN users) continues to run the legacy MANAGER_MORNING_DIGEST + MANAGER_END_OF_DAY_REPORT digests — K4 option (a) effectively in place. X-T5 (formal removal/gating of old ADMIN digest formatters) remains open.
- **What to do:** per K3, extend `src/scheduler/jobs/digestDispatcher.ts isElevated` branching (line 119) so Yoram routes to D4-T1, Sasha routes to D3-T2, and the residual elevated path is handled per K4 (kept / removed / env-gated — see `X-T5`).
- **Definition of Done:** Yoram receives only the exceptions digest (D4-T1); Sasha receives only the leads digest (D3-T2); the test of "two elevated users get different content the same morning" passes.
- **Reference:** GAP Domain 4 row 2. Spec §13.
- **Dependencies:** D3-T2, D4-T1, K3, K4.
- **Blocked:** NO (K3, K4 closed).

### Domain 5 — Cross-cutting infra (remaining)

#### D5-T4 — Button-vs-numbered-text policy enforcement
- **Status:** DONE (wave 2 commit — same as D2-T4/T7/T8). Policy documented inline in two places: (1) a JSDoc block above `problemTypeMenu()` in `src/ai/menu.ts` naming the two allowed `sendButtonMessage` surfaces (§6 inspection card = D2-T2; §10 equipment reminder = D2-T9) and stating every other menu stays numbered text; (2) the JSDoc on `sendButtonMessage` in `src/whatsapp/sender.ts:57-66` extended with the same policy. Cross-refs the pre-existing caveat at `src/ai/router.ts:773-776` (which predates this policy but stays valid). No behavioural change — every v2 menu emitted so far (7-item main via D2-T1, 7-item problem sub-menu via D2-T8) is already numbered text; policy locks in the invariant.
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

#### D5-T6 — Polling-job template for unsent `TaskField` assignment cards
- **Status:** DONE (local, uncommitted). Instead of a shared "template" file, the D2-T2 send + stamp lives in `services/inspectionAssignment.ts` and the polling entrypoint `runInspectionAssignmentPoll` is invoked by a thin new job wrapper `src/scheduler/jobs/assignmentCardNotifier.ts` (`runAssignmentCardNotifier`). Registered in `src/scheduler/index.ts` at `*/2 * * * *` (Asia/Jerusalem), new advisory-lock id `1009` (`assignmentCardNotifier`) — same interval and lock discipline the retired `completionNotifier` used to run at. Dedup semantics: `workerNotifiedAt IS NULL` is the primary filter; the UPDATE is `SET "workerNotifiedAt" = now() WHERE id = $1 AND "workerNotifiedAt" IS NULL` so a race between the same instance's retries or a manual DB stamp becomes a no-op. Per-row send failures are logged and isolated — the loop continues to the next row and unstamped rows retry on the next tick. Tests: `runInspectionAssignmentPoll` cases in `inspectionAssignment.test.ts` verify per-row failure isolation and the no-rows short-circuit. `npx tsc --noEmit` clean; `npx vitest run` — 299 passed / 7 skipped / 306 total. Deviation from spec: no separate reusable "polling template" — the primary consumer (D2-T2 assignment cards) has its own dedicated module; lead-assignment polling (D3-T3) is independent of K2 and will be introduced separately when the leads stream lands.
- **What to do:** if D2-T2 uses polling, factor out a shared polling-job template (mirroring `completionNotifier.ts`). Primary consumer: D2-T2 detects created `TaskField` rows where `workerNotifiedAt IS NULL`, sends the inspection card, then stamps `workerNotifiedAt`. Optional consumer: D3-T3 may reuse the helper for `IncomingLead.ownerId` flip null→user → alert worker, but that lead flow is independent of K2.
- **Definition of Done:** one reusable polling helper exists if polling is chosen; the `TaskField` assignment-card consumer uses `workerNotifiedAt` for dedup; any lead-assignment consumer has isolated dedup from field cards.
- **Reference:** GAP Domain 1 row 4, Domain 3 row 3, Domain 5 cross-cutting. Spec §1.
- **Dependencies:** D1-T5, D2-T2.
- **Blocked:** NO (K2 resolved).

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
- **Status:** DONE (commit b288e72). `src/scheduler/jobs/digestDispatcher.ts` MORNING branch: `formatEmployeeMorning` is retired — every non-ADMIN routes to `formatInspectorMorning` (D2-T4). Comment in the dispatcher marks "formatEmployeeMorning fallback is retired (X-T3)". The 17:00 evening `runDailySummary` broadcast remains disabled by default per `LEGACY_DAILY_SUMMARY_ENABLED` (untouched per spec).
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
- **Blocked:** NO (K4 closed).

#### X-T6 — Digest preferences menu item (worker 6 / manager 7)
- **Status:** DONE (commit b288e72; K5 option b). `employeeMenu()` in `src/ai/menu.ts` has 7 items — `digest_settings` does NOT appear. The underlying `showDigestSettings` handler and `UserDigestPreference` service are untouched (hidden capability, accessible via free-text). `managerMenu()` retains its own digest-settings item (item 7) — that is the legacy manager surface, not the worker menu.
- **What to do:** per K5, either remove the menu item entirely (default), keep as a hidden capability (free-text trigger only), or surface in the v2 worker menu. Code in `src/ai/router.ts showDigestSettings` + `handleDigestSettingsReply` + `handleDigestTimeReply` (lines 897-982) and `src/services/digestPreferences.ts` is infrastructure — KEEP the underlying service even if the menu entry is removed.
- **Definition of Done:** the chosen exposure level is implemented; `UserDigestPreference` table and service untouched.
- **Reference:** GAP Part 2, "Digest settings sub-menu" row.
- **Dependencies:** K5.
- **Blocked:** NO (K5 closed).

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

- **M1: External inputs received + decisions made.** ✅ B1 resolved (proceed with clear מק"טים). ✅ B2 resolved (`IncomingLead` table + columns confirmed). ✅ K1–K7 closed, including K2 (CRM scheduling form creates `TaskField` by existing `Task ID`).
- **M2: DB foundation.** `D1-T1`, `D1-T2`, `D1-T3`, `D1-T4`, `D1-T5`, `D1-T6`. (Catalog seed `D1-T7` slides in as soon as B1 lands.)
- **M3: Cross-cutting infra prerequisites.** `D5-T1` (inspector detection + role-based menu routing), `D5-T2` (voice), `D5-T3` (AI intents), `D5-T4` (button policy), `D5-T6` (unsent `TaskField` assignment-card polling template if polling is used).
- **M4: Worker inspections menu + card + button replies.** `D2-T1`, `D2-T2`, `D2-T3`. End-to-end: a worker can confirm/decline/need-info on an assigned inspection.
- **M5: Worker morning reminder + on-demand status transitions + finished follow-up.** `D2-T4`, `D2-T5`, `D2-T6`. End-to-end: a full inspection day from morning list to finished + notes.
- **M6: Worker problem + missing-info + day-summary flows.** `D2-T7`, `D2-T8`, `D2-T9`, `D2-T10`. Worker side feature-complete for MVP.
- **M7: Leads stream for Sasha.** `D3-T1`, `D3-T5`, `D3-T3`, `D3-T4`, `D3-T2`. End-to-end: 09:30 digest, assignment alert, escalation.
- **M8: Manager exceptions digest for Yoram.** `D4-T1`, `D4-T2`. End-to-end: §13 morning and evening content with the right routing per K3.
- **M9: Dismantle and clean up.** `X-T1`, `X-T2`, `X-T3`, `X-T4`, `X-T5`, `X-T6`, `X-T7`. Old surface area removed AFTER the new surface is shipping.
- **M10: Templates + production validation.** `D5-T5` (Meta-approved templates for out-of-window sends), end-to-end smoke testing.
