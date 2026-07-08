-- Migration 016: Live tracking foundation (Wolt-lite).
-- Additive only — zero changes to existing CRM/bot tables. See
-- docs/LIVE_TRACKING_PLAN.md for the full plan (approved 2026-07-08).
--
-- Three new bot-owned tables:
--
--   1. WorkerDeviceIdentity   maps the OwnTracks Basic-auth username
--                             (workerKey) to a bot-known User.id. Manually
--                             seeded per phone. No FK to User? — we DO add
--                             one, per 012/015 convention (`User` is CRM-owned
--                             but has a stable text id we already reference).
--
--   2. WorkerLiveLocation     latest known GPS fix per worker. UPSERT on every
--                             OwnTracks ping. One row per workerUserId (PK on
--                             the user id — cheapest possible "latest" query).
--                             Does NOT replace PocLocationPing; the POC table
--                             stays for append-only diagnostics.
--
--   3. TrackingSession        one customer-facing tracking session for a
--                             TaskField, opened at "יצאתי", closed at
--                             "סיימתי" / cancel / decline. Enforces TWO
--                             invariants via partial unique indices:
--                               (a) at most ONE active session per WORKER
--                                   ("יצאתי" on a new TaskField auto-supersedes
--                                    the prior session — SUPERSEDED status)
--                               (b) at most ONE active session per TaskField
--                                   (defense-in-depth against races)
--                             taskFieldId is `uuid` to match TaskField.id
--                             (migration 009:62). workerUserId is `text` to
--                             match User.id (migration 009:103).
--
-- Convention mirrors 012/013/015: PascalCase quoted table name, camelCase
-- quoted columns, uuid PK with gen_random_uuid(), timestamptz default now(),
-- RLS enabled with a deny-all RESTRICTIVE policy (bot uses the service-role
-- key which bypasses RLS; anon/authenticated clients get nothing).
--
-- Idempotent: safe to re-run on partially-applied state.

BEGIN;

-- ── 1. WorkerDeviceIdentity ────────────────────────────────────────────────
-- Maps OwnTracks basic-auth username → bot-known worker (User.id). Rows are
-- inserted manually (or by a small admin flow later). Marking a row inactive
-- via isActive=false is how we handle phone rotation — the mapping table stays
-- append-only in spirit even though rows are mutable.

CREATE TABLE IF NOT EXISTS "WorkerDeviceIdentity" (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "workerKey"    text        NOT NULL UNIQUE,      -- Basic-auth username in POST /owntracks
  "workerUserId" text        NOT NULL REFERENCES "User"(id),
  "deviceLabel"  text,                             -- free-form ("Danny iPhone"), operator note only
  "isActive"     boolean     NOT NULL DEFAULT true,
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup "who is the active mapping for this user" (rare but tidy).
CREATE INDEX IF NOT EXISTS idx_workerdeviceidentity_user_active
  ON "WorkerDeviceIdentity"("workerUserId") WHERE "isActive";

-- ── 2. WorkerLiveLocation ──────────────────────────────────────────────────
-- One row per worker, UPSERTed on every ping. PK on workerUserId → the "latest
-- location for worker X" query is a single-row PK lookup. History lives in
-- PocLocationPing (append-only, migration 013) — this table is intentionally
-- overwritten, not append-only.

CREATE TABLE IF NOT EXISTS "WorkerLiveLocation" (
  "workerUserId" text             PRIMARY KEY REFERENCES "User"(id),
  "workerKey"    text             NOT NULL,                    -- who wrote the last ping (for diagnostics)
  "deviceId"     text,
  lat            double precision NOT NULL,
  lng            double precision NOT NULL,
  accuracy       real,
  speed          real,
  battery        real,
  "trigger"      text,                                         -- OwnTracks `t` (auto/manual/beacon/...)
  "recordedAt"   timestamptz,                                  -- OwnTracks `tst` (epoch → tstz)
  "lastSeenAt"   timestamptz      NOT NULL DEFAULT now(),      -- server receive time; basis for staleness
  "updatedAt"    timestamptz      NOT NULL DEFAULT now(),
  raw            jsonb                                         -- last payload, for debugging
);

-- ── 3. TrackingSession ─────────────────────────────────────────────────────
-- One session per TaskField-departure. Lifecycle:
--   ACTIVE     — created at "יצאתי" (DEPARTED). Worker is en route.
--   ARRIVED    — worker sent "הגעתי" (ARRIVED). Session still exists — a future
--                customer page can render "הבודק הגיע".
--   FINISHED   — worker sent "סיימתי". Terminal.
--   CANCELED   — worker declined the TaskField or a manager canceled it.
--   EXPIRED    — expiresAt < now() and no ARRIVED. Set lazily on read for now;
--                a cron sweep can be added later.
--   SUPERSEDED — worker "יצאתי" on a NEW TaskField while a prior session was
--                still ACTIVE/ARRIVED. Prior session is closed with endedAt=now(),
--                new session opened. Enforces the single-active-per-worker rule.

CREATE TABLE IF NOT EXISTS "TrackingSession" (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskFieldId"    uuid        NOT NULL REFERENCES "TaskField"(id),
  "workerUserId"   text        NOT NULL REFERENCES "User"(id),
  status           text        NOT NULL CHECK (status IN
                     ('ACTIVE','ARRIVED','FINISHED','CANCELED','EXPIRED','SUPERSEDED')),
  "publicToken"    text        NOT NULL UNIQUE,               -- crypto.randomBytes(24).toString('base64url')
  "startedAt"      timestamptz NOT NULL DEFAULT now(),
  "arrivedAt"      timestamptz,
  "endedAt"        timestamptz,
  "expiresAt"      timestamptz NOT NULL,                      -- default startedAt + 4h (matches activeInspection window)
  "lastLocationAt" timestamptz,                               -- bumped by every OwnTracks ping while ACTIVE|ARRIVED
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now()
);

-- Primary invariant: at most ONE active session per worker. The service closes
-- any prior worker session as SUPERSEDED before opening a new one; this index
-- is the belt-and-suspenders guarantee against races.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trackingsession_active_per_worker
  ON "TrackingSession"("workerUserId") WHERE status IN ('ACTIVE','ARRIVED');

-- Defense-in-depth: at most ONE active session per TaskField. Should be
-- transitively guaranteed by the per-worker rule (a TaskField is owned by one
-- worker), but keep this in case ownership ever transfers.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trackingsession_active_per_taskfield
  ON "TrackingSession"("taskFieldId") WHERE status IN ('ACTIVE','ARRIVED');

-- Debug endpoint scans by status; keeps a small index on the hot filter.
CREATE INDEX IF NOT EXISTS idx_trackingsession_status
  ON "TrackingSession"(status);

-- ── Row Level Security ────────────────────────────────────────────────────
-- Same pattern as 013: bot connects with the service-role key which bypasses
-- RLS. Enable RLS with a deny-all RESTRICTIVE policy so anon/authenticated
-- clients cannot touch these tables directly. Wrapped in DO $$ ... $$ so the
-- migration is idempotent (re-running does not error on the existing policy).

ALTER TABLE "WorkerDeviceIdentity" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WorkerDeviceIdentity' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WorkerDeviceIdentity" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

ALTER TABLE "WorkerLiveLocation" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WorkerLiveLocation' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WorkerLiveLocation" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

ALTER TABLE "TrackingSession" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'TrackingSession' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "TrackingSession" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
