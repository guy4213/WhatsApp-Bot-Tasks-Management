-- Migration 012: customer-facing WhatsApp notification dedup ledger.
-- Additive only — zero changes to existing CRM/bot tables.
--
-- Convention mirrors the existing send-log tables (WhatsappDigestSendLog / 008,
-- WhatsappLeadNotification / 010): PascalCase quoted table name, camelCase
-- quoted columns, text status with CHECK, RLS enabled with deny-all RESTRICTIVE
-- policy (bot uses service-role key which bypasses RLS).
--
-- First user of this table: WORKER_EN_ROUTE — the customer is notified when
-- the assigned worker flips TaskField.fieldStatus to EN_ROUTE (spec §7 /
-- advanceFieldStatus DEPARTED). Sent via the approved `customer_worker_en_route`
-- UTILITY template because the customer is (almost always) OUTSIDE the 24h
-- WhatsApp service window.
--
-- Dedup key: UNIQUE ("taskFieldId", "notificationType") — one row per TaskField
-- per notification type ever. Prevents double-notify if the worker taps
-- "יצאתי" twice or the router replays the intent.
--
-- workerFeedbackSentAt: timestamp of the freeform follow-up sent BACK to the
-- worker ("✅ עודכן ללקוח" / "⚠️ נכשל — התקשר ידנית"). NULL when the feedback
-- hasn't been sent (e.g. the send crashed or the worker phone was missing).

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappCustomerNotification" (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskFieldId"            uuid        NOT NULL REFERENCES "TaskField"(id),
  "notificationType"       text        NOT NULL CHECK ("notificationType" IN ('WORKER_EN_ROUTE')),
  "recipientPhone"         text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','FAILED')),
  "errorMessage"           text,
  "workerFeedbackSentAt"   timestamptz,
  "sentAt"                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("taskFieldId", "notificationType")
);

CREATE INDEX IF NOT EXISTS idx_wa_customer_notif_taskfield
  ON "WhatsappCustomerNotification"("taskFieldId");

ALTER TABLE "WhatsappCustomerNotification" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappCustomerNotification' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappCustomerNotification" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
