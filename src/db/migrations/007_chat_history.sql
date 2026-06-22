-- Migration 007: short rolling chat history (per phone) for reference resolution
-- Additive only. Holds the last few turns so the AI can resolve "the third one",
-- "that task", "details on it". One row per phone; the app trims to the window size.

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappChatHistory" (
  phone       text        PRIMARY KEY,
  messages    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "expiresAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "WhatsappChatHistory" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappChatHistory' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappChatHistory" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
