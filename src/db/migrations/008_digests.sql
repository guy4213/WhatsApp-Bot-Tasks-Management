-- Migration 008: per-user scheduled digests
-- Additive only — zero changes to existing CRM tables.
-- Convention mirrors the CRM / earlier migrations: PascalCase quoted table names +
-- camelCase quoted columns, RLS enabled with a deny-all RESTRICTIVE policy (the bot
-- connects with the service-role key, which bypasses RLS; anon/authenticated clients
-- get nothing).
--
-- Two tables:
--   "UserDigestPreference"  — per-user morning/evening enable flags + local times +
--                             timezone. Rows are created LAZILY (only when a user
--                             changes a setting); the dispatcher LEFT JOINs and
--                             COALESCEs a missing row to these same defaults, so every
--                             active user is effectively ON without any seeding.
--   "WhatsappDigestSendLog" — dedup ledger (mirrors "WhatsappReminderLog"): the
--                             (userId, digestType, localDate) PK guarantees at most one
--                             morning + one evening per user per local day, even across
--                             restarts / overlapping instances.

BEGIN;

-- ── UserDigestPreference ──────────────────────────────────────────────────────
-- timezone lives here because the CRM "User" table has no tz column.

CREATE TABLE IF NOT EXISTS "UserDigestPreference" (
  "userId"         text        PRIMARY KEY REFERENCES "User"(id),
  "morningEnabled" boolean     NOT NULL DEFAULT true,            -- default ON
  "morningTime"    text        NOT NULL DEFAULT '08:00',         -- 'HH:MM' local
  "eveningEnabled" boolean     NOT NULL DEFAULT true,            -- default ON
  "eveningTime"    text        NOT NULL DEFAULT '17:00',         -- 'HH:MM' local
  "timezone"       text        NOT NULL DEFAULT 'Asia/Jerusalem',
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now()
);

-- ── WhatsappDigestSendLog ─────────────────────────────────────────────────────
-- One row per (user, digestType, localDate). INSERT-first dedup: the PK conflict
-- tells a second sender the digest already went out today.

CREATE TABLE IF NOT EXISTS "WhatsappDigestSendLog" (
  "userId"     text        NOT NULL REFERENCES "User"(id),
  "digestType" text        NOT NULL,                 -- 'MORNING' | 'EVENING'
  "localDate"  date        NOT NULL,                 -- date in the user's tz
  "sentAt"     timestamptz NOT NULL DEFAULT now(),
  "status"     text        NOT NULL DEFAULT 'SENT',  -- SENT | FAILED
  PRIMARY KEY ("userId", "digestType", "localDate")
);

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE "UserDigestPreference"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsappDigestSendLog" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'UserDigestPreference' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "UserDigestPreference" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappDigestSendLog' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappDigestSendLog" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
