-- Migration 004: Short-lived conversation context for the AI clarification loop
-- Keyed by WhatsApp phone. Holds a partially-resolved intent while the bot asks
-- the user for missing fields / intent confirmation / task disambiguation.
-- Rows expire via "expiresAt"; the AI router prunes/ignores expired rows.

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappConversationContext" (
  phone        text        PRIMARY KEY,
  state        jsonb       NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wcc_expires_at
  ON "WhatsappConversationContext"("expiresAt");

ALTER TABLE "WhatsappConversationContext" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappConversationContext' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappConversationContext" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
