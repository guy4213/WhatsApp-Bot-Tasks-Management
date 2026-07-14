-- Migration 020: Microsoft Graph / Outlook Calendar integration tables.
-- Additive only — zero changes to any existing table.
-- Convention mirrors earlier migrations (009, 013, 016, 019): PascalCase quoted
-- table names, camelCase quoted columns, uuid PKs with gen_random_uuid(),
-- timestamptz NOT NULL DEFAULT now(), FK to "User"(id) ON DELETE CASCADE,
-- RLS enabled with deny-all RESTRICTIVE policy, idempotent throughout.
--
-- Three tables:
--   "MicrosoftAccount"            — one row per bot-user who linked an Outlook
--                                   account; stores the AES-256-GCM encrypted
--                                   refresh token + IV + auth-tag.
--   "MicrosoftGraphSubscription"  — active Graph change-notification subscriptions;
--                                   a cron renews rows before `expiresAt`.
--   "MicrosoftGraphEventLog"      — append-only log of every incoming webhook
--                                   notification plus the fetched event snapshot.
--                                   Data-exploration table; nothing is updated here.

BEGIN;

-- ── 1. MicrosoftAccount ──────────────────────────────────────────────────────
-- One Microsoft/Outlook account per bot-user (UNIQUE on userId).
-- The raw refresh token NEVER rests in plaintext: it is AES-256-GCM encrypted,
-- with the IV (12 bytes) and auth tag (16 bytes) stored alongside the ciphertext.
-- All three values are base64-encoded text columns.

CREATE TABLE IF NOT EXISTS "MicrosoftAccount" (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "User"."id" is text in this DB (Supabase auth uid stored as text). All
  -- existing FKs to "User"(id) use text (see migrations 001, 008, 009, 016).
  "userId"                 text        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "msTenantId"             text        NOT NULL,
  "msObjectId"             text        NOT NULL,   -- /me `id` (oid in the token)
  upn                      text        NOT NULL,   -- userPrincipalName / primary email
  "encryptedRefreshToken"  text        NOT NULL,   -- base64 AES-256-GCM ciphertext
  "tokenIv"                text        NOT NULL,   -- base64 12-byte GCM IV
  "tokenAuthTag"           text        NOT NULL,   -- base64 16-byte GCM auth tag
  scopes                   text        NOT NULL,   -- space-separated granted scopes
  "linkedAt"               timestamptz NOT NULL DEFAULT now(),
  "updatedAt"              timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId")                                -- one MS account per bot-user for now
);

CREATE INDEX IF NOT EXISTS idx_microsoftaccount_ms_object_id
  ON "MicrosoftAccount"("msObjectId");

-- ── 2. MicrosoftGraphSubscription ────────────────────────────────────────────
-- Tracks active Graph change-notification subscriptions so a renewal cron can
-- find rows approaching expiry via the `expiresAt` index.

CREATE TABLE IF NOT EXISTS "MicrosoftGraphSubscription" (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- text FK to "User"(id) — see comment on MicrosoftAccount."userId".
  "userId"         text        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "subscriptionId" text        NOT NULL UNIQUE,    -- the id Graph returns on POST /subscriptions
  resource         text        NOT NULL,           -- e.g. "me/events"
  "changeType"     text        NOT NULL,           -- e.g. "created,updated,deleted"
  "expiresAt"      timestamptz NOT NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_microsoftgraphsubscription_expires_at
  ON "MicrosoftGraphSubscription"("expiresAt");

CREATE INDEX IF NOT EXISTS idx_microsoftgraphsubscription_user_id
  ON "MicrosoftGraphSubscription"("userId");

-- ── 3. MicrosoftGraphEventLog ─────────────────────────────────────────────────
-- Append-only log written by the /webhook/microsoft-graph handler.
-- `rawNotification` holds the exact payload from Graph.
-- `rawEventSnapshot` is populated after a subsequent GET to the Graph API;
--   it is NULL for `deleted` events or when the fetch fails.
-- `fetchError` captures the error text when the GET fails.
-- `clientStateOk` flags whether the notification's clientState matched.

CREATE TABLE IF NOT EXISTS "MicrosoftGraphEventLog" (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "receivedAt"        timestamptz NOT NULL DEFAULT now(),
  "subscriptionId"    text,                        -- nullable: bad clientState may not resolve
  "changeType"        text        NOT NULL,
  resource            text        NOT NULL,
  "graphEventId"      text,                        -- parsed from resource when possible
  "clientStateOk"     boolean     NOT NULL,
  "rawNotification"   jsonb       NOT NULL,
  "rawEventSnapshot"  jsonb,                       -- NULL for deleted / fetch failure
  "fetchError"        text                         -- NULL when fetch succeeded
);

CREATE INDEX IF NOT EXISTS idx_microsoftgrapheventlog_received_at
  ON "MicrosoftGraphEventLog"("receivedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_microsoftgrapheventlog_graph_event_id
  ON "MicrosoftGraphEventLog"("graphEventId");

CREATE INDEX IF NOT EXISTS idx_microsoftgrapheventlog_subscription_id
  ON "MicrosoftGraphEventLog"("subscriptionId");

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The bot connects with the service-role key which bypasses RLS entirely. RLS is
-- still enabled with no permissive policies so anon/authenticated clients cannot
-- read or write these tables directly. Pattern mirrors migrations 009 and 019.

ALTER TABLE "MicrosoftAccount"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MicrosoftGraphSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MicrosoftGraphEventLog"     ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'MicrosoftAccount' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "MicrosoftAccount" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'MicrosoftGraphSubscription' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "MicrosoftGraphSubscription" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'MicrosoftGraphEventLog' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "MicrosoftGraphEventLog" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
