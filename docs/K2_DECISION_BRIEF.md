# K2 Decision Brief — Task→Inspection Trigger Mechanism

## 1. TL;DR

**Option (b) — bot-side polling**, mirroring `src/scheduler/jobs/completionNotifier.ts`. Decisive axis: **feasibility given actual repo state**. (a) violates the additive-only spec and still needs a second layer for WhatsApp; (c) requires a CRM-side outbound HTTP capability the bot team cannot build alone. Polling is the pattern the codebase already ships to production for `Task.status='DONE'`; K2 reuses it verbatim.

## 2. Option analysis (matrix)

| Axis | (a) DB trigger | (b) Bot polling | (c) CRM hook |
|---|---|---|---|
| **1. Sketch** | `CREATE TRIGGER trg_task_field AFTER INSERT OR UPDATE OF "isFieldTask" ON "Task" WHEN (NEW."isFieldTask")` → function `INSERT INTO "TaskField" SELECT ... FROM "InspectionType" WHERE code = NEW."productName" ON CONFLICT DO NOTHING`. Card send needs a **separate** LISTEN/NOTIFY or polling consumer — PG can't emit HTTP. | New `src/scheduler/jobs/taskFieldNotifier.ts` cloning `completionNotifier.ts:16-37`. Every 2min: `SELECT ... FROM "Task" WHERE "isFieldTask" = true AND NOT EXISTS (SELECT 1 FROM "TaskField" WHERE "taskId" = t.id) LIMIT 50`. For each: INSERT `TaskField` (UNIQUE `taskId` at `009_field_inspections.sql:62` is natural dedup), call `sendInspectionCard()`. Register `taskFieldNotifier: 1009` in `scheduler/index.ts:20-29`. | New Fastify route `app.post('/internal/task-marked-field', ...)` gated by `verifyInternalSecret` (`tasks.ts:64-68`). Handler validates `taskId`, upserts `TaskField`, sends card. CRM POSTs with `x-internal-secret`. |
| **2. Atomicity** | Trigger fires in the CRM txn — insert atomic with the flip. But send is out-of-band, so the edge collapses. Bad `productName` throws in office's UPDATE. LISTEN down = silent drop. | INSERT-first dedup identical to `completionNotifier.ts:56-61`. Failed send doesn't roll back INSERT — retry via `cardSentAt` column (Q4). Same failure profile as `completionNotifier` in production. | try/catch in handler. CRM owns retry; fire-and-forget + bot restart mid-window = lost. Needs bot-side ledger for exactly-once. |
| **3. Latency** | Insert sub-second; card = LISTEN sub-second OR polling (same as b). | 0–2 min at `*/2 * * * *`. Matches today's completion cadence. Acceptable for a §6 assignment card. | Sub-second. Best of three. |
| **4. Testability** | Very hard. Live PG + trigger installed; not mockable at the app layer. DROP+recreate per test. | Straightforward. `runTaskFieldNotifier()` is plain async against `pool`. `README.md:220-228` `RUN_DB_TESTS=1` pattern already covers `completionNotifier`. Mock `sendInspectionCard`; assert INSERT + args. | Bot-side test covers the handler only. End-to-end needs a CRM stub. `dispatchInternal` (`utils/internalApi.ts:64-87`) is loopback-only. |
| **5. Ops** | Trigger DDL inside the CRM DB — deploy/rollback = SQL on a table the bot doesn't own. No app log; debug via `pg_stat_user_functions`. | Standard Node deploy — new file, one cron entry. Inherits `log.info` (`completionNotifier.ts:37`) + advisory lock (`scheduler/index.ts:31-50`) + `WhatsappAuditLog`. Rollback = `git revert`. | CRM team must build + deploy the outbound hook. Bot-side: new route + 4xx monitor. CRM rollback needs their team. |
| **6. Security** | Service-role, bypasses RLS. No new HTTP surface. No new secret. | No new HTTP surface. Reuses `SUPABASE_SERVICE_ROLE_KEY` (`db/connection.ts:14`). No new attack surface beyond `completionNotifier`. | New `/internal/*` route. Gated on `INTERNAL_API_SECRET` (`tasks.ts:107-113`), which today only guards loopback bot→bot (`utils/internalApi.ts:33`). Extending trust to CRM-origin is a boundary change; leaked secret = forged `TaskField` for arbitrary `taskId`. Needs mTLS/IP allowlist for off-network. |
| **7. Downstream reuse** | Trigger reusable for `lead incoming` only if bot has DDL there — `TASKS.md:283` forbids. D1-T4 installs a trigger (CRM behavior change). D2-T2 still needs its own mechanism. D5-T6 template disappears. | Perfect. `TASKS.md:334-339` D5-T6 says explicitly: "if K2 = polling, factor out a shared polling-job template. Used by D2-T2 and D3-T3". One template, two consumers. D1-T4 = pure `ALTER TABLE`. D2-T2 called from the job. | CRM must POST on `lead incoming` assignment too. Two hooks, two CRM code paths, two auth surfaces. D5-T6 disappears. |
| **8. Feasibility** | **NON-STARTER.** `009_field_inspections.sql:1-3` declares "Additive only — zero changes to existing CRM tables". A trigger changes `Task` behavior. `SPEC_FIELD_V2.md:24` approves ONE column, not "column plus trigger". Installable but scope creep. | **VIABLE — direct precedent.** `completionNotifier.ts:16-37` polls `Task.status='DONE'` on the same DB with the same dedup; `scheduler/index.ts:67` runs it `*/2 * * * *`. Zero new infra, zero env vars. | **NON-STARTER unilaterally.** No evidence the CRM emits outbound HTTP. `utils/internalApi.ts:33` is loopback-only. `/tasks/*` is loopback (`tasks.ts:58-60`). Requires Galit's back-office team to build the hook — B1/B2-tier dependency. |

## 3. Feasibility check

- **(a) DB trigger** — technically installable (bot has service-role), **eliminated on spec grounds**. `SPEC_FIELD_V2.md:24` and `TASKS.md:8` authorize ONE additive column on `Task`; a trigger is behavioral modification of a CRM-owned table, not an additive column. It also can't send WhatsApp on its own — a second polling/LISTEN layer is still needed, killing the atomicity argument.
- **(b) Bot-side polling** — **viable now.** `completionNotifier.ts` is the working template. No external work, no new env vars, no CRM engagement.
- **(c) CRM HTTP hook** — **eliminated on capability grounds.** No evidence the CRM can call outbound. `utils/internalApi.ts:33` is loopback-only; README's architecture (`README.md:41-51`) shows the bot as a downstream reader with no reverse channel. Blocks on a B1/B2-tier external dependency.

**Only (b) survives.**


## 4. Rationale

(b) wins on axis **8 (feasibility)** — the only axis where the others are eliminated. Close calls:

- **Latency (3):** (c) beats (b) by ~1 min median. Irrelevant for a §6 card sent hours before a visit.
- **Atomicity (2):** (a) *looks* stronger in-txn, but the send is out-of-band, so its edge collapses.
- **Security (6):** (b) is strictly safest — no new HTTP surface, no new trust boundary. (c) extends `INTERNAL_API_SECRET` outside its loopback role.
- **Reuse (7):** (b) is the ONLY option where D3-T3 and D5-T6 fall out for free. Leads can't use a trigger (bot can't DDL `lead incoming`) or a CRM hook (same external blocker). Polling works uniformly for both consumers — a substantial architectural win.

## 5. Impact on D1-T4 (Task flag migration)

Beyond `ALTER TABLE "Task" ADD COLUMN "isFieldTask" BOOLEAN NOT NULL DEFAULT false;` the migration adds a partial index for the poll: `CREATE INDEX IF NOT EXISTS idx_task_field_task_open ON "Task"(id) WHERE "isFieldTask" = true;`. **NO** trigger, **NO** function, **NO** other change to `Task`.

K2 comment block at the top of the migration (per `TASKS.md:143`):

```sql
-- Migration 010: Task.isFieldTask flag — the single approved CRM-side additive
-- column per SPEC_FIELD_V2 §1. The ONE exception to "additive-only, zero
-- changes to CRM tables".
--
-- K2 mechanism: bot-side polling (option b). See
-- src/scheduler/jobs/taskFieldNotifier.ts. The bot polls "Task" every 2min for
-- rows where isFieldTask = true AND no matching "TaskField" exists; inserts
-- "TaskField" (UNIQUE(taskId) is natural dedup) and sends the §6 card to the
-- assigned worker. No DB trigger, no CRM outbound hook — "Task" itself is
-- untouched beyond this column.
-- Rollback: DROP COLUMN "isFieldTask"; disable taskFieldNotifier in
-- src/scheduler/index.ts.
```

## 6. Impact on D2-T2 (inspection card emitter)

**File:** new `src/services/inspections.ts` per `TASKS.md:203`. Consolidates all `TaskField` reads/writes. Export `sendInspectionCard(taskFieldId: string): Promise<void>`.

**Reads:** `TaskField` → `InspectionType` (family, labelHe) → `Customer` via `Task.customerId` → `User` (assignee) via `Task.ownerId` → `InspectionChecklist` WHERE `family = <family>` ORDER BY `sortOrder`.

**Sends:** `sendButtonMessage` (`src/whatsapp/sender.ts:62-83`) with the §6 body (type label, customer, address, date+time, contact, equipment list, navigation link) and 3 reply buttons with the deterministic payload IDs required by `TASKS.md:203`:

- `INSP_CONFIRM_<taskFieldId>`
- `INSP_DECLINE_<taskFieldId>`
- `INSP_NEED_INFO_<taskFieldId>`

Using `taskFieldId` (not `taskId`) is immune to future rekeying and directly names the row D2-T3 will UPDATE. Consumer: `src/routes/webhook.ts:162-170` interactive handler.

**Trigger point:** the polling job calls `sendInspectionCard(taskFieldId)` after a successful INSERT. On failure: audit-log to `WhatsappAuditLog`; the row is already persisted, so a `cardSentAt` retry re-fires without duplication.

## 7. Reusability for D3-T3 (lead-assignment alert)

**Yes — verbatim.** D3-T3 is structurally identical: poll `lead incoming` for `assignedTo` empty→user transitions, dedup on a bot-side ledger (per `TASKS.md:282` — no column on `lead incoming` itself, additive-only), send an alert. Polling loop, advisory lock, audit log, `ON CONFLICT DO NOTHING` dedup — identical. `TASKS.md:334-339` D5-T6 explicitly anticipates this shared template. Shipping K2 as (b) unblocks D5-T6 and de-risks D3-T3 the moment B2 lands. Leads ledger is a small bot-side table (`leadId text PRIMARY KEY, notifiedAt timestamptz`), separate from `TaskField` (whose `UNIQUE(taskId)` is its own ledger).

## 8. Open questions

1. **Poll cadence** — `*/2 * * * *` (matching `completionNotifier`) or `*/5 * * * *` (matching `digestDispatcher`)? Recommend 2min: office expects a prompt card after flipping the dropdown.
2. **`InspectionType` code miss** — if `Task.productName` matches no `InspectionType.code` (borderline B1 rows), does the poll skip+retry, INSERT with `family='general'`, or alert the office? Recommend skip+warn-log; escalate after N failures.
3. **`assignedAt` semantics** — set `TaskField.assignedAt = now()` (bot clock, actual send time) or `Task.updatedAt` (approximate CRM flip)? Recommend `now()` — matches what §7 reminders and §13 dashboards care about.
4. **Send-failure retry** — leave `TaskField` in place (manual retry), DELETE + re-poll, or add a `cardSentAt` column and poll on `cardSentAt IS NULL`? Recommend the `cardSentAt` ledger — safest, mirrors `completionNotifier`.
5. **Un-flagging** — if the office toggles `isFieldTask` true→false (correction), does the bot delete the `TaskField`, mark `CANCELED`, or ignore? Spec is silent. Recommend ignore for MVP; office can also mark `Task.status = CANCELED` which the bot mirrors per §4.
