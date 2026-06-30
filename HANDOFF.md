# HANDOFF — resume here

**Last updated:** 2026-06-30 (migration 009 shipped; next: K2 decision or D2-T1 worker menu).

## Project in one sentence
Converting a generic CRM task-management WhatsApp bot (Node/TS, migrations 001–008) into the **Galit bot** per `SPEC_FIELD_V2.md`: field inspections for inspectors (worker side), leads stream for Sasha, exceptions digest for Yoram. One bot, role-routed display. Infra carries over; the entire old UX is rewritten.

## Where we are RIGHT NOW
Two planning docs are written and current:
- `GAP_ANALYSIS.md` — 30 gaps across 5 domains, 12 existing capabilities classified (kept-as-infra / rewritten / dropped / needs-decision).
- `TASKS.md` — 38 dependency-ordered tasks: 2 blockers (B1, B2), 7 decisions (K1–K7), 30 implementation tasks (D1–D5), 7 dismantle tasks (X), 10 milestones.

All 7 decisions (K1–K7) are **CLOSED** (K2's concrete mechanism is still "leaning", but it does not block the DB schema). Resolutions recorded in `TASKS.md §0`.

**Migration `009_field_inspections.sql` is SHIPPED** (commit f7aeaa0) — the first code of the v2 build. It covers `D1-T1, D1-T2, D1-T3, D1-T5, D1-T6`: the 3 additive tables (`InspectionType`, `InspectionChecklist`, `TaskField`) + the 17-row `InspectionChecklist` seed (radiation / noise / asbestos / radon). Verified end-to-end on a fresh local Postgres: `npm run migrate` applies 001–009 and records 009 in `schema_migrations`; idempotent on re-run; the 10-value `fieldStatus` CHECK (no `STARTED`), the 7-value `problemType` CHECK, and the 13-value `family` CHECK each reject bad values; every UNIQUE rejects duplicates; RLS deny-all blocks a non-service-role connection; exactly 17 checklist rows after two runs; `tsc` clean + 106 tests pass. Two reconciliations vs the prose task text, both recorded in `TASKS.md`: `isFieldInspection` was **omitted** from `InspectionType` (not in the authoritative spec block — add via an additive `ALTER` when D1-T7 lands), and a 13-value CHECK was **added** to `TaskField.family`.

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
Migration 009 is done. Two viable next moves — they're independent, so pursue (2) now while chasing the user on (1):

1. **Unblock K2** — the Task→inspection mechanism (DB trigger vs CRM-side hook vs bot-side polling). It is the only remaining decision-blocker. Closing it unblocks `D1-T4` (the `Task.isFieldTask` flag migration — a one-line additive `ALTER TABLE`, the single approved CRM exception) and `D2-T2` (the inspection-card emitter). Chase the user for a steer (see "Open questions" below).

2. **Start Domain 2 worker-side scaffolding — `D2-T1` (worker main-menu rewrite).** UNBLOCKED, no K2 dependency. Rewrite `employeeMenu()` in `src/ai/menu.ts` to the 7 v2 items (spec §5: `הבדיקות שלי להיום`, `הבדיקות שלי למחר`, `עדכון סטטוס בדיקה`, `דיווח על בעיה`, `חסר ציוד`, `חסר מידע לדוח`, `סיכום יום`) + 7 new `MenuAction` kinds. Per `TASKS.md §0`, D2-T1 is no longer K-decision-blocked — the "Blocked: YES" line in the D2-T1 entry is pre-K-closure and stale. See `TASKS.md` §3 Domain 2.

**Still deferred (blocked):** `D1-T4` (Task flag — K2), `D1-T7` (InspectionType ~150-row catalog seed — B1).

## Still blocked — chase later
- **B1** — `InspectionType` ~150-מק"ט catalog sign-off. Draft is in `SPEC_FIELD_V2.md` lines 416–571, but borderline shielding rows need human review. Owner: Galit / spec author. Gates `D1-T7`.
- **B2** — `lead incoming` table column names (name / phone / message / created-at / assignedTo, + whether `assignedTo` is FK or free-text). Owner: whoever owns the CRM/back-office DB. Gates all of Domain 3.
- **K2** — Task→inspection mechanism. Open question: DB trigger vs CRM-side hook vs bot-side polling. Gates `D1-T4` + `D2-T2`.

## Files the next session must read first
1. `HANDOFF.md` (this file)
2. `TASKS.md` §0 (decisions log) + §3 Domain 1 (DONE — D1-T1/T2/T3/T5/T6) + §3 Domain 2 (next)
3. `SPEC_FIELD_V2.md` §3 (schema), §4 (status model), §5 (worker menu), §6 (inspection card), §14 (MVP scope), lines 258–381 (migration block + seed)
4. `src/db/migrations/009_field_inspections.sql` (the shipped migration) + `008_digests.sql` (conventions precedent)
5. `src/db/migrate.ts` (so a future migration file is detected)
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
> Read `HANDOFF.md`. Migration 009 is shipped. Either (a) help me settle K2 (the Task→inspection trigger mechanism) so D1-T4 + D2-T2 unblock, or (b) start `D2-T1`: rewrite `employeeMenu()` in `src/ai/menu.ts` to the 7 v2 inspection items from `SPEC_FIELD_V2.md` §5, adding the 7 new `MenuAction` kinds. Follow existing menu/router conventions; don't touch CRM tables.

## Open questions to ask the user when they're back
1. **K2 unlock** — when can you get a steer on DB-trigger vs CRM-hook vs bot-side polling for the Task→inspection mechanism? Once that's clear, `D1-T4` + `D2-T2` unblock.
2. **B1 catalog** — who's the right person to ping for the catalog sign-off? Draft message ready to go.
3. **B2 lead-incoming columns** — same question for whoever owns that table.
