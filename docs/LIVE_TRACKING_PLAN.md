# Live Tracking — Implementation Plan (Wolt-lite foundation)

**Status:** APPROVED — implementation in progress. Do NOT run migration or
deploy without explicit user approval.
**Predecessor:** `docs/POC_OWNTRACKS.md` (append-only OwnTracks GPS POC).
**Scope of this step:** backend foundation only — latest live location per worker, one
tracking session per TaskField, session lifecycle driven by the existing "יצאתי /
הגעתי / סיימתי" flow, and a minimal public JSON endpoint. No Google ETA, no
WebSocket, no geofence, no customer WhatsApp template, no customer UI page.

Migration numbering: the next migration is **`016_live_tracking.sql`**.

---

## 1. What exists today (OwnTracks + activeInspection)

### 1.1 OwnTracks route — `src/routes/owntracksPoc.ts`

- `POST /owntracks` — public, HTTP Basic auth, allowlist from env
  `POC_OWNTRACKS_USERS` (format `danny:secret1,yossi:secret2`).
- `workerKey` = the Basic-auth **username** (not payload-trusted, not linked to
  `User.id`).
- Appends one row per ping to `PocLocationPing`, always acks `[]`.
- `GET /owntracks/poc/debug` — `x-internal-secret` guarded, aggregates latest +
  staleness + gap stats.
- No test file yet.

### 1.2 POC table — `src/db/migrations/013_owntracks_poc.sql`

- `PocLocationPing` (`uuid PK, workerKey, deviceId, tid, lat, lng, accuracy,
  speed, battery, trigger, recordedAt, receivedAt, raw jsonb`).
- Index: `("workerKey", "receivedAt" DESC)`.
- **Append-only.** No worker↔`User.id` mapping. RLS deny-all (service-role
  bypass).

### 1.3 Phase 1 "יצאתי" flow

- Intent: `src/ai/intentParser.ts:53` — `יצאתי / בדרך / בדרכי / …` →
  `set_field_status` + `transition=DEPARTED`.
- Router: `src/ai/router.ts:1185` → `runAdvanceStatusDirect()` →
  `performTransition()` at `src/ai/router.ts:2342`.
- Status write: `advanceFieldStatus()` in `src/services/inspections.ts:475` —
  one `UPDATE "TaskField"` per transition (`CONFIRM | DEPARTED | ARRIVED |
  FINISHED`).
- On `DEPARTED`: `setActiveInspection()` stores
  `{ taskFieldId, departedAt, expiresAt (dep+4h), etaMinutes? }` in
  `WhatsappConversationContext.state`.
- On `ARRIVED`: `setActiveInspection` re-anchored,
  `awaiting = idle_active_inspection`.
- On `FINISHED`: pointer dropped, `finished_followup` menu shown.
- `CANCELED / DECLINED` go through **different** code paths (button/decline
  flow, not `performTransition`).
- `TaskField.travelEtaMinutes` + `expectedArrivalAt` already exist (migration
  014).

### 1.4 Worker ↔ identity model

- `User` table is **CRM-owned** — has `id`, `phone`, `role`
  (`FIELD_WORKER | MANAGER | ADMIN`). We cannot add columns (project rule §6).
- No `ownTracksDeviceId` field anywhere.
- Today the OwnTracks POC has **no way** to tell which `User.id` a ping belongs
  to. Only `workerKey` (basic-auth username, human-picked string).

### 1.5 No existing tracking-session infrastructure

- Zero matches for `TrackingSession`, `publicToken`, `/tracking/:token`,
  `trackingToken`. Greenfield.

---

## 2. What needs to be added

Three concerns, four files of substance, one migration:

| # | Piece | New / edit | Purpose |
|---|---|---|---|
| A | `WorkerDeviceIdentity` table | new (migration 016) | Bot-owned mapping `workerKey → User.id` so pings resolve to a worker without touching CRM |
| B | `WorkerLiveLocation` table | new (migration 016) | Latest-known-location upsert, one row per `workerUserId` |
| C | `TrackingSession` table | new (migration 016) | One active session per `TaskField`, holds `publicToken` and lifecycle |
| D | `src/services/tracking.ts` | new | `openTrackingSession()`, `markArrived()`, `closeSession()`, `getPublicView(token)` |
| E | `src/services/workerLocation.ts` | new | `upsertLiveLocation()`, `resolveWorkerFromKey()` |
| F | `src/routes/owntracksPoc.ts` | edit | After `INSERT PocLocationPing`, upsert `WorkerLiveLocation`; if worker has ACTIVE session, bump `lastLocationAt`. **Keep** `PocLocationPing` (diagnostic value). |
| G | `src/routes/tracking.ts` | new | `GET /tracking/:token` (public), `GET /tracking/debug/sessions` (internal) |
| H | `src/ai/router.ts` `performTransition` | edit | On DEPARTED → `openTrackingSession`; on ARRIVED → `markArrived`; on FINISHED → `closeSession('FINISHED')` |
| I | `src/index.ts` / server bootstrap | edit | Register the new `/tracking` plugin |
| J | Decline / cancel handlers | edit *(same PR, small)* | `closeSession('CANCELED')` when a worker declines or a manager cancels the TaskField |

Explicitly **not now**: Google ETA, WebSocket, geofence, customer WhatsApp
template on tracking-open, customer-facing UI page. `GET /tracking/:token` will
return JSON only for this iteration.

---

## 3. Proposed migration — `016_live_tracking.sql` (sketch)

```sql
-- 016_live_tracking.sql — additive.
BEGIN;

-- (A) Bot-owned OwnTracks identity → User.id mapping. Manually seeded.
CREATE TABLE IF NOT EXISTS "WorkerDeviceIdentity" (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workerKey"    text NOT NULL UNIQUE,        -- Basic-auth username in /owntracks
  "workerUserId" text NOT NULL,               -- User.id (CRM), no FK (CRM-owned table)
  "deviceLabel"  text,                        -- "Danny iPhone", free-form
  "isActive"     boolean NOT NULL DEFAULT true,
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workerdeviceidentity_user
  ON "WorkerDeviceIdentity"("workerUserId") WHERE "isActive";

-- (B) Latest location per worker. UPSERT on every ping.
CREATE TABLE IF NOT EXISTS "WorkerLiveLocation" (
  "workerUserId" text PRIMARY KEY,
  "workerKey"    text NOT NULL,
  "deviceId"     text,
  lat            double precision NOT NULL,
  lng            double precision NOT NULL,
  accuracy       real,
  speed          real,
  battery        real,
  "trigger"      text,
  "recordedAt"   timestamptz,
  "lastSeenAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now(),
  raw            jsonb
);

-- (C) Tracking session per TaskField. Enforces TWO invariants:
--   (1) at most ONE active session per worker at any time (SUPERSEDE on new "יצאתי")
--   (2) at most ONE active session per TaskField at any time
--
-- taskFieldId type MUST match TaskField.id (uuid, migration 009). See migration
-- 012 for the same FK pattern.
CREATE TABLE IF NOT EXISTS "TrackingSession" (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskFieldId"    uuid        NOT NULL REFERENCES "TaskField"(id),
  "workerUserId"   text        NOT NULL REFERENCES "User"(id),
  status           text        NOT NULL CHECK (status IN
                     ('ACTIVE','ARRIVED','FINISHED','CANCELED','EXPIRED','SUPERSEDED')),
  "publicToken"    text        NOT NULL UNIQUE,
  "startedAt"      timestamptz NOT NULL DEFAULT now(),
  "arrivedAt"      timestamptz,
  "endedAt"        timestamptz,
  "expiresAt"      timestamptz NOT NULL,
  "lastLocationAt" timestamptz,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now()
);
-- Primary invariant: one active session per worker.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trackingsession_active_per_worker
  ON "TrackingSession"("workerUserId") WHERE status IN ('ACTIVE','ARRIVED');
-- Secondary invariant: defense-in-depth, one active session per TaskField.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trackingsession_active_per_taskfield
  ON "TrackingSession"("taskFieldId") WHERE status IN ('ACTIVE','ARRIVED');

-- RLS deny-all on all three (service role bypasses) — mirrors 013.
-- [same DO $$ ... $$ block pattern as 013 for each table]

COMMIT;
```

Migration is **idempotent** (`IF NOT EXISTS` on tables, indices, RLS policies)
— matches existing convention.

---

## 4. Files that will change

| Path | Kind | Notes |
|---|---|---|
| `src/db/migrations/016_live_tracking.sql` | new | tables above |
| `src/services/workerLocation.ts` | new | `resolveWorkerFromKey(workerKey) → userId?`, `upsertLiveLocation(...)` |
| `src/services/tracking.ts` | new | `openTrackingSession`, `markArrived`, `closeSession`, `getPublicView(token)` |
| `src/routes/owntracksPoc.ts` | edit | after `INSERT PocLocationPing`: resolve `workerKey` → `userId`, upsert `WorkerLiveLocation`, bump `TrackingSession.lastLocationAt` if any ACTIVE/ARRIVED. Silent no-op if key unmapped. |
| `src/routes/tracking.ts` | new | `GET /tracking/:token` public JSON view; `GET /tracking/debug/sessions` internal (secret-guarded) |
| `src/index.ts` (or wherever `owntracksPocRoutes` is registered) | edit | register new plugin |
| `src/ai/router.ts` (`performTransition`) | edit | 3 lines each in DEPARTED / ARRIVED / FINISHED branches |
| `src/ai/router.ts` decline / cancel handler *(TBD file — Grep confirmed separate)* | edit | `closeSession('CANCELED')` on worker DECLINED |

No changes to `advanceFieldStatus` itself. No changes to CRM-owned tables. No
changes to `PocLocationPing` (kept for POC diagnostics).

---

## 5. Proposed tests

Colocated under `src/services/__tests__/` and `src/routes/__tests__/`,
following existing patterns.

1. `tracking.service.test.ts`
   - `openTrackingSession` creates a session with unique token, status=ACTIVE,
     `expiresAt` in future.
   - Re-opening on the same TaskField reuses / refreshes the same ACTIVE row
     (partial unique index invariant).
   - `markArrived` sets status=ARRIVED, `arrivedAt` stamped, session still
     queryable.
   - `closeSession('FINISHED')` sets `endedAt` + status; second call is a no-op
     (idempotent).
2. `workerLocation.service.test.ts`
   - `upsertLiveLocation` inserts on first ping, updates on second (single row
     per userId).
   - `resolveWorkerFromKey` returns userId for active mapping, null for
     inactive / missing.
3. `owntracksPoc.route.test.ts` (extend / create)
   - Unmapped `workerKey` still 200-acks and writes to `PocLocationPing`
     (backward compat).
   - Mapped key: `WorkerLiveLocation` upserted; if ACTIVE session exists,
     `lastLocationAt` bumped.
4. `tracking.route.test.ts`
   - Bad token → 404 (do not leak whether it ever existed vs never existed).
   - Valid ACTIVE token → returns
     `{ status, taskFieldStatus, lastLocation:{lat,lng,at}, etaMinutes?,
     updatedAt }` and **no** internal ids / phones.
   - EXPIRED / CANCELED → returns `{ status }` only, no location.
5. `router.performTransition.test.ts` (extend if exists, else new
   integration-lite)
   - DEPARTED opens a session; router still sends ETA prompt; `activeInspection`
     still stored.
   - ARRIVED marks session ARRIVED, does not clear pointer.
   - FINISHED closes session and drops pointer.
   - Worker DECLINE closes session.

Tests must be behavioral (project rule §5.4), not "function returns something".

---

## 6. Edge cases

- **Unmapped OwnTracks key**: ping still 200s and lands in `PocLocationPing`;
  no live-location, no session update. Diagnostic-only until manually seeded.
- **Worker rotates phones**: mark old `WorkerDeviceIdentity` row
  `isActive=false`; add new row with new `workerKey`. `WorkerLiveLocation`
  continues to be per `userId`, latest wins.
- **Two `TaskField`s DEPARTED in a row** (worker re-taps or heads to a second
  customer without arriving at the first): a worker can have **only one**
  ACTIVE / ARRIVED session at a time. `openTrackingSession` for a new
  TaskField must first mark any prior worker session as `SUPERSEDED`
  (`endedAt = now()`), then open the new one. Enforced by
  `uniq_trackingsession_active_per_worker` and by explicit code in the service
  (belt + suspenders).
- **Session `expiresAt`**: default `startedAt + 4h`, matches `activeInspection`
  window. If no `ARRIVED` by then, cron (future) sets `EXPIRED`. Not scheduled
  in this iteration — `expiresAt` is stored but not enforced by a job yet;
  `getPublicView` will treat `now > expiresAt` as `EXPIRED` on read.
- **Public token entropy**: `crypto.randomBytes(24).toString('base64url')`
  (32 chars, ~192 bits). Enough for URL-shared links.
- **Public endpoint leakage**: return only
  `{ status, taskFieldStatus, lastLocation:{lat,lng,at}, updatedAt,
  etaMinutes? }`. No `taskFieldId`, no `workerUserId`, no phones, no customer
  name. (User can approve including destination address later.)
- **Ping without ACTIVE session**: normal, most pings are like this — just
  updates `WorkerLiveLocation`.
- **DEPARTED → ARRIVED → re-DEPARTED** (e.g., worker mistake): re-DEPARTED on
  the same TaskField should reactivate the same row (`status = ACTIVE`, clear
  `arrivedAt`, refresh `expiresAt`). Partial unique index still holds because
  it covers both ACTIVE and ARRIVED.
- **Cancel path**: canceled TaskField needs `closeSession('CANCELED')`.
  Failing to hook this leaves stale ACTIVE sessions — enumerate every cancel /
  decline call site during implementation.
- **Retention**: `PocLocationPing` grows unbounded today. Not this PR — flag as
  follow-up.

---

## 7. MVP tracking flow in plain language

1. Ops person adds row in `WorkerDeviceIdentity`: `workerKey='danny'` →
   `workerUserId='<Danny's User.id>'`. (Done once per phone.)
2. Danny's phone sends OwnTracks pings every ~1 min → server upserts
   `WorkerLiveLocation` for Danny's user id. `PocLocationPing` still appends
   for diagnostics.
3. Danny sends **"יצאתי"** for TaskField X → existing router flow runs
   (`advanceFieldStatus DEPARTED`, `activeInspection` pointer stored, ETA
   prompt sent). **New:** `openTrackingSession(taskFieldId=X,
   workerUserId=Danny.id)` returns a `publicToken`.
4. Any subsequent OwnTracks ping from Danny → still upserts
   `WorkerLiveLocation`; **also** bumps `TrackingSession.lastLocationAt` for
   the active session on X.
5. Anyone with the tracking URL
   `https://bot.example.com/tracking/<token>` gets JSON
   `{ status:'ACTIVE', taskFieldStatus:'EN_ROUTE',
   lastLocation:{lat,lng,at}, etaMinutes: 25, updatedAt }`.
6. Danny sends **"הגעתי"** → `markArrived`, JSON now returns
   `status:'ARRIVED'`.
7. Danny sends **"סיימתי"** → `closeSession('FINISHED')`, JSON returns
   `status:'FINISHED'` with no location. Future page can render
   "הבודק סיים".

The customer-facing WhatsApp message with the tracking link is **out of scope**
for this step (opt-in switch later).

---

## 8. Answers locked in (2026-07-08)

- **Q1** — bot-owned `WorkerDeviceIdentity` table: **APPROVED**.
- **Q2** — keep `PocLocationPing`: **APPROVED**.
- **Q3** — public endpoint stays minimal (no address yet): **APPROVED**.
- **Q4** — decline / cancel closes tracking session in same PR: **APPROVED**.
- **Q5** — lazy expiry on read (no cron this PR): **APPROVED**.
- **Q6** — same Fastify app (`src/app.ts`): **APPROVED**.
- **Q7** — `activeInspection` untouched, `TrackingSession` is a separate
  persistent record: **APPROVED**.

**Additional refinements from user:**
- Only ONE active `TrackingSession` per worker at any time. New "יצאתי" on a
  new TaskField must **auto-close** the prior worker session as `SUPERSEDED`
  (`endedAt = now()`), then open the new one. Enforced by a partial unique
  index on `workerUserId` and by explicit code in
  `openTrackingSession`.
- `taskFieldId` type must match `TaskField.id` (verified: **`uuid`** in
  migration 009:62). `workerUserId` type matches `User.id`
  (verified: **`text`** in migration 009:103).

---

## 8b. Original questions log (for history)

- **Q1 — Worker ↔ OwnTracks identity model.** Proposing bot-owned table
  `WorkerDeviceIdentity(workerKey UNIQUE → workerUserId)`, seeded manually per
  phone. Alternative: overload `POC_OWNTRACKS_USERS` env with
  `workerKey=User.id` shape. Recommendation: the table (rotation, audit, no
  redeploy to add a worker). **OK?**
- **Q2 — Keep `PocLocationPing` too, or drop it?** Recommendation: **keep**
  (diagnostic value; 013 code path unchanged). Drop later once we're
  confident.
- **Q3 — Public endpoint fields.** Proposed minimum: `status`,
  `taskFieldStatus`, `lastLocation{lat,lng,at}`, `etaMinutes`, `updatedAt`.
  Explicitly excluded: `taskFieldId`, `workerUserId`, worker name, customer
  name, phones, address. Should destination address (from TaskField site
  metadata) be included so a future page can render it, or wait?
- **Q4 — Cancel / decline hookup.** The DECLINE and manager-cancel paths do
  **not** go through `performTransition`. Also add `closeSession('CANCELED')`
  to those call sites in the same PR (small, but touches `router.ts`).
  **Confirm in same PR.**
- **Q5 — Expiry enforcement.** No cron this PR. Sessions are marked `EXPIRED`
  lazily on `GET /tracking/:token` when `now > expiresAt`. **OK, or want an
  actual scheduler job now?**
- **Q6 — Register `/tracking` plugin.** Same server as `/owntracks`?
  (Assumed: yes — one Fastify app.)
- **Q7 — Where does `getContext(user.phone)` fit in?** Not touching it —
  `activeInspection` stays exactly as-is. The tracking session is a
  **separate** persistent record. Confirming this is desired
  (`activeInspection` = worker-facing pointer; `TrackingSession` =
  customer-facing artifact).

---

## 9. Model recommendation

Opus — new subsystem touching router + services + migrations + public API
together, plus a mapping-identity decision. Switch with `/model <name>`, or
say "go".

---

## 10. Guardrails during implementation

- No Supabase migration will be applied and nothing will be deployed to Render
  without explicit go-ahead.
- No writes to CRM-owned tables (`User`, `Task`, `IncomingLead`, etc.). All
  new tables are bot-owned.
- `advanceFieldStatus()` is not touched; tracking hooks live in
  `performTransition` only.
- All new tables get RLS deny-all (service-role bypass), mirroring
  `013_owntracks_poc.sql`.
