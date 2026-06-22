-- Migration 002: CRM-completion notification tracking table
-- Additive only. Tracks which DONE tasks have already been notified to managers,
-- so the polling job never sends the same alert twice.

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappCompletionNotification" (
  "taskId"     text        PRIMARY KEY REFERENCES "Task"(id),
  "notifiedAt" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "WhatsappCompletionNotification" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappCompletionNotification' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappCompletionNotification" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
