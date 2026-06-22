-- Migration 006: reminder de-duplication table
-- Additive only. Tracks which (task, reminder-kind) pairs have already been sent
-- so the hourly due-date reminder and the deadline-exceeded alert never fire the
-- same notification twice (e.g. across a server restart inside the reminder window).

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappReminderLog" (
  "taskId" text        NOT NULL REFERENCES "Task"(id),
  "kind"   text        NOT NULL,           -- e.g. 'DUE_1H', 'DEADLINE_EXCEEDED'
  "sentAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId", "kind")
);

ALTER TABLE "WhatsappReminderLog" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappReminderLog' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappReminderLog" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
