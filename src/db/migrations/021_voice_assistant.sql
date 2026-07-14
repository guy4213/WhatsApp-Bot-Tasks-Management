-- Migration 021: Hebrew voice assistant ("העוזרת הקולית") access + audit tables.
-- Additive only — zero changes to any existing table.
-- Convention mirrors earlier migrations (009, 013, 016, 019, 020): PascalCase
-- quoted table names, camelCase quoted columns, uuid PKs with gen_random_uuid(),
-- timestamptz NOT NULL DEFAULT now(), FK to "User"(id) ON DELETE CASCADE,
-- RLS enabled with deny-all RESTRICTIVE policy, idempotent throughout.
--
-- Two tables:
--   "VoiceAccessToken" — one row per personal voice-page link. The RAW token is
--                        shown once in the magic URL (/voice?u=<token>) and only
--                        its SHA-256 hex digest rests here. Revocable, expiring.
--   "VoiceToolCall"    — append-only audit of every tool execution the voice
--                        assistant performed (who, which tool, args, outcome).

BEGIN;

-- ── 1. VoiceAccessToken ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "VoiceAccessToken" (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "User"."id" is text in this DB (see migrations 001, 008, 009, 016, 020).
  "userId"     text        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  -- SHA-256 hex digest (64 chars) of the raw URL token. Raw token never rests.
  "tokenHash"  text        NOT NULL UNIQUE,
  -- Free-text label shown in admin listings, e.g. "קישור של אורי".
  label        text,
  "expiresAt"  timestamptz NOT NULL,
  "revokedAt"  timestamptz,
  "lastUsedAt" timestamptz,
  "createdAt"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voiceaccesstoken_user
  ON "VoiceAccessToken"("userId");

-- ── 2. VoiceToolCall (append-only audit) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS "VoiceToolCall" (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"     text        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "toolName"   text        NOT NULL,
  -- JSON string of the tool arguments, truncated by the writer to a sane size.
  "argsJson"   text,
  ok           boolean     NOT NULL,
  -- Short outcome summary (Hebrew) or error message — never full payloads.
  summary      text,
  "latencyMs"  integer,
  "createdAt"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voicetoolcall_user_created
  ON "VoiceToolCall"("userId", "createdAt" DESC);

-- ── RLS: deny-all RESTRICTIVE (service-role bypasses; mirrors migration 020) ──

ALTER TABLE "VoiceAccessToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VoiceToolCall"    ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'VoiceAccessToken' AND policyname = 'deny_all_voiceaccesstoken'
  ) THEN
    CREATE POLICY deny_all_voiceaccesstoken ON "VoiceAccessToken"
      AS RESTRICTIVE FOR ALL USING (false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'VoiceToolCall' AND policyname = 'deny_all_voicetoolcall'
  ) THEN
    CREATE POLICY deny_all_voicetoolcall ON "VoiceToolCall"
      AS RESTRICTIVE FOR ALL USING (false);
  END IF;
END $$;

COMMIT;
