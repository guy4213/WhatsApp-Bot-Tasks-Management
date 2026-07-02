-- Migration 011: pre-inspection 60-minute reminder column on TaskField.
-- Additive only — one nullable timestamp column so the polling job can track
-- whether the reminder has been sent. The column is NULL by default (not yet
-- sent) and is stamped to now() by `sendAndStampPreReminder` after a
-- successful WhatsApp send. The scheduler polls every 2 min and fires for
-- every row where `preReminderSentAt IS NULL` and
-- `scheduledStartAt <= now() + 60 min`.
--
-- Idempotent via `ADD COLUMN IF NOT EXISTS`.

BEGIN;

ALTER TABLE "TaskField"
  ADD COLUMN IF NOT EXISTS "preReminderSentAt" timestamptz NULL;

COMMIT;
