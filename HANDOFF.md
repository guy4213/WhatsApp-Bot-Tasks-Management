# HANDOFF — resume here

**Last updated:** 2026-06-30 (mid-session, user stepping away — continue from phone).

## Project in one sentence
Converting a generic CRM task-management WhatsApp bot (Node/TS, migrations 001–008) into the **Galit bot** per `SPEC_FIELD_V2.md`: field inspections for inspectors (worker side), leads stream for Sasha, exceptions digest for Yoram. One bot, role-routed display. Infra carries over; the entire old UX is rewritten.

## Where we are RIGHT NOW
Two planning docs are written and current:
- `GAP_ANALYSIS.md` — 30 gaps across 5 domains, 12 existing capabilities classified (kept-as-infra / rewritten / dropped / needs-decision).
- `TASKS.md` — 38 dependency-ordered tasks: 2 blockers (B1, B2), 7 decisions (K1–K7), 30 implementation tasks (D1–D5), 7 dismantle tasks (X), 10 milestones.

All 7 decisions (K1–K7) are **CLOSED**. Resolutions recorded in `TASKS.md §0`. No code written yet — about to start the unblocked DB schema work.

## Decisions locked
| K | Resolution |
|---|---|
| K1 — inspector ID | Rule: `user.role !== 'ADMIN'`. No schema change, no flag column. |
| K2 — Task→inspection trigger | **TBD** (still open). Leaning "some kind of trigger" (DB trigger or CRM hook). Blocks D1-T4 + D2-T2 only. |
| K3 — Yoram vs Sasha routing | Per-user routing inside `src/scheduler/jobs/digestDispatcher.ts`, keyed on env-var phone allow-list or a 2-row lookup. |
| K4 — old CRM manager digest | Gate behind env flag, default off (precedent: `LEGACY_DAILY_SUMMARY_ENABLED` at `src/scheduler/index.ts:76`). Delete after v2 stable in prod ~2 weeks. |
| K5 — digest-pref sub-menu | Hidden capability. Keep table + service. No menu entry. Free-text trigger only. |
| K6 — daily greeting | Keep AND auto-open the v2 inspections menu. Matches §5 spec example. |
| K7 — STT provider | OpenAI Whisper API. Hebrew supported. ~$0.006/min. Env var: `OPENAI_API_KEY` (or dedicated `WHISPER_API_KEY`). |

## NEXT TASK — start here
User chose: **Build migration `009_field_inspections.sql` in one PR** — covers `D1-T1 → D1-T6`:

1. `D1-T1` — Scaffold `src/db/migrations/009_field_inspections.sql`. Header + `BEGIN ... COMMIT` envelope mirroring `008_digests.sql`. Verify `src/db/migrate.ts` picks it up and `schema_migrations` records it.
2. `D1-T2` — `InspectionType` table. UUID PK `gen_random_uuid()`; `code` UNIQUE; `labelHe`; `family` text + CHECK over 13 declared values; `isActive` bool default true; `sortOrder` int; `isFieldInspection` bool; timestamps. Index on `family`. RLS deny-all.
3. `D1-T3` — `InspectionChecklist` table. UUID PK; `family` text + CHECK (same 13 values); `code`; `labelHe`; `isRequired` bool; `sortOrder` int; `UNIQUE(family, code)`; index on `family`; RLS deny-all. NO `kind` column (dropped per spec).
4. `D1-T5` — `TaskField` table (1:1 with Task). UUID PK; `taskId` UUID UNIQUE FK→Task; `inspectionTypeId` UUID FK→InspectionType; snapshot `family` + CHECK; static metadata (`siteAddress, siteCity, fieldContactName, fieldContactPhone, navigationUrl, specialInstructions`); `fieldStatus` text + CHECK over **exactly the 10 values** (`ASSIGNED, CONFIRMED, DECLINED, NEEDS_MORE_INFO, EN_ROUTE, ARRIVED, FINISHED_FIELD, WAITING_FOR_INFO, HAS_PROBLEM, CANCELED` — **NO `STARTED`**); per-status timestamps (`assignedAt, confirmedAt, declinedAt, departedAt, arrivedAt, finishedAt`); `declinedReason` text; inline problem (`problemType` text + CHECK over 7 declared values, `problemNote` text, `hasOpenProblem` bool); missing-info (`missingReportInfo` bool, `missingReportInfoNote` text); `managerNotifiedAt` timestamp; `updatedByUserId` UUID FK→User; timestamps. Index on `fieldStatus`; partial index `WHERE hasOpenProblem = true`. RLS deny-all.
6. `D1-T6` — Seed `InspectionChecklist` for the 4 declared families: radiation / noise / asbestos / radon — **17 rows total**. Idempotent `INSERT ... ON CONFLICT (family, code) DO NOTHING`. Fully specified in `SPEC_FIELD_V2.md` lines 360–381.

**Deferred from this PR:** `D1-T4` (Task flag — K2-blocked), `D1-T7` (catalog seed — B1-blocked).

**Definition of Done for the PR:**
- `npm run migrate` on a fresh DB applies 009 cleanly; idempotent on re-run.
- All CHECK constraints reject invalid values (verify via a smoke script or pgAdmin).
- All UNIQUE constraints reject duplicates.
- RLS deny-all verified on each new table via a non-service-role connection.
- Exactly 17 rows in `InspectionChecklist` after the seed runs twice.

## Still blocked — chase later
- **B1** — `InspectionType` ~150-מק"ט catalog sign-off. Draft is in `SPEC_FIELD_V2.md` lines 416–571, but borderline shielding rows need human review. Owner: Galit / spec author. Gates `D1-T7`.
- **B2** — `lead incoming` table column names (name / phone / message / created-at / assignedTo, + whether `assignedTo` is FK or free-text). Owner: whoever owns the CRM/back-office DB. Gates all of Domain 3.
- **K2** — Task→inspection mechanism. Open question: DB trigger vs CRM-side hook vs bot-side polling. Gates `D1-T4` + `D2-T2`.

## Files the next session must read first
1. `HANDOFF.md` (this file)
2. `TASKS.md` §0 (decisions log) + §3 Domain 1 (the work queued)
3. `SPEC_FIELD_V2.md` §3 (schema), §4 (status model), §6 (inspection card), §14 (MVP scope), lines 258–381 (migration block + seed)
4. `src/db/migrations/008_digests.sql` (closest precedent for conventions)
5. `src/db/migrate.ts` (so the new file is detected)
6. `GAP_ANALYSIS.md` only if context on a specific gap is needed — TASKS.md cites the gap rows directly.

## Hard constraints — never violate
- One bot, role determines display. Not two bots.
- **Additive-only at the DB level.** Zero changes to existing CRM tables, except the single approved `Task.isFieldTask` flag (deferred to a later PR — K2-blocked).
- **The CRM owns `Task.status`. The bot NEVER writes it.** Operational status lives only in `TaskField.fieldStatus`.
- **No PG enums** — text + CHECK only.
- UUID PKs with `gen_random_uuid()` for all new tables.
- RLS enabled deny-all on every new table.
- Conventions identical to migrations 001–008 (header comment, `BEGIN ... COMMIT`, idempotent re-run).

## Suggested first prompt for the next Claude session
> Read `HANDOFF.md`. Then build migration `009_field_inspections.sql` end-to-end covering tasks D1-T1 through D1-T6 from `TASKS.md`. Follow `008_digests.sql` conventions exactly. Don't touch any existing CRM table. Don't add the Task flag (K2-blocked) or seed the InspectionType catalog (B1-blocked) in this PR. When done, run `npm run migrate` against a local DB and show me the schema_migrations row plus a `\d+ TaskField` output.

## Open questions to ask the user when they're back
1. **K2 unlock** — when can you get a steer on DB-trigger vs CRM-hook vs bot-side polling for the Task→inspection mechanism? Once that's clear, `D1-T4` + `D2-T2` unblock.
2. **B1 catalog** — who's the right person to ping for the catalog sign-off? Draft message ready to go.
3. **B2 lead-incoming columns** — same question for whoever owns that table.
