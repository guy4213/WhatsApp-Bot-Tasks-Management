-- Migration 013: OwnTracks GPS POC — single append-only location-ping table.
-- Additive only — zero changes to existing CRM/bot tables.
--
-- Purpose: prove OwnTracks works as a live GPS source for the customer arrival-
-- tracking feature ("Wolt-lite"). This POC ONLY receives and stores raw location
-- pings from the OwnTracks apps (HTTP mode) so we can measure real-world update
-- frequency (Android vs iPhone, background, screen-off, in-pocket, while Waze is
-- navigating). See docs/POC_OWNTRACKS.md.
--
-- NOT part of the full feature: no WorkerDevice / WorkerLiveLocation /
-- TaskFieldTracking / geocode cache — those come later, only if the POC passes.
--
-- Convention mirrors the existing bot tables (008/010/012): PascalCase quoted
-- table name, camelCase quoted columns, uuid PK with gen_random_uuid(),
-- timestamptz default now(), RLS enabled with a deny-all RESTRICTIVE policy (the
-- bot connects with the service-role key which bypasses RLS; anon/authenticated
-- clients get nothing).
--
-- Append-only: every POST from OwnTracks inserts one row. "Latest location" is a
-- DISTINCT ON ("workerKey") ... ORDER BY "receivedAt" DESC query; update-frequency
-- is the gap between consecutive "receivedAt" values per workerKey; "stale" is
-- now() - MAX("receivedAt") > threshold. workerKey is the Basic-auth username the
-- OwnTracks app authenticated with (the POC's worker identity) — validated against
-- the POC_OWNTRACKS_USERS allowlist in the route, NOT trusted from the payload.

BEGIN;

CREATE TABLE IF NOT EXISTS "PocLocationPing" (
  id           uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  "workerKey"  text             NOT NULL,               -- Basic-auth username = POC worker identity
  "deviceId"   text,                                    -- X-Limit-D header / config, informational only
  tid          text,                                    -- OwnTracks tracker id, informational only
  lat          double precision,
  lng          double precision,
  accuracy     real,                                    -- OwnTracks `acc` (metres)
  speed        real,                                    -- OwnTracks `vel`
  battery      real,                                    -- OwnTracks `batt`
  "trigger"    text,                                    -- OwnTracks `t` (auto/manual/beacon/...)
  "recordedAt" timestamptz,                             -- from OwnTracks `tst` (epoch seconds)
  "receivedAt" timestamptz      NOT NULL DEFAULT now(), -- server receive time (frequency + staleness basis)
  raw          jsonb                                    -- full payload, for debugging
);

CREATE INDEX IF NOT EXISTS idx_poclocationping_worker_received
  ON "PocLocationPing"("workerKey", "receivedAt" DESC);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The bot connects with the service-role key which bypasses RLS entirely. Enable
-- RLS with no permissive policies so anon/authenticated clients cannot read or
-- write this table directly. (Mirrors 008/010/012.)

ALTER TABLE "PocLocationPing" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'PocLocationPing' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "PocLocationPing" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
