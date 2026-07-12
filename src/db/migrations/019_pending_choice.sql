-- Migration 019: PendingChoice — number→command mapping for Green API numbered menus.
--
-- Green API (the temporary WhatsApp-Web transport) cannot render Meta's native
-- interactive reply-buttons / list messages. Under Green API those surfaces are
-- sent as NUMBERED TEXT ("1. כן  /  2. לא") and this table records, per phone,
-- which command id each number stands for — so an inbound numeric reply ("2") is
-- translated back to the exact text command ("לא <uuid>") the router already
-- understands, BEFORE the message is enqueued. One row per phone: the latest
-- numbered prompt wins (a new prompt upserts). Entries expire after 60 minutes,
-- enforced at read time (see src/services/pendingChoice.ts).
--
-- Meta is unaffected: under Meta, buttons/lists are native and this table is
-- never written or read. Additive only, idempotent, RLS deny-all — convention
-- mirrors migration 003 (WhatsappInboundQueue).

BEGIN;

CREATE TABLE IF NOT EXISTS "PendingChoice" (
  phone       text        PRIMARY KEY,            -- normalized recipient, e.g. 972501234567
  mapping     jsonb       NOT NULL,               -- { "1": "כן <uuid>", "2": "לא <uuid>" }
  "expiresAt" timestamptz NOT NULL,               -- write time + 60 min
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

-- Read filter / optional sweep support on expiry.
CREATE INDEX IF NOT EXISTS idx_pendingchoice_expires
  ON "PendingChoice"("expiresAt");

ALTER TABLE "PendingChoice" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'PendingChoice' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "PendingChoice" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
