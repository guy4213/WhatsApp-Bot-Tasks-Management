-- Migration 010: bot-side dedup ledger for IncomingLead notifications.
-- Additive only — zero changes to existing CRM tables (`IncomingLead` remains
-- read-only from the bot's perspective, matching the constraint that the bot
-- does not write CRM-owned tables). This table mirrors
-- `WhatsappCompletionNotification` (migration 002): the presence of a row
-- prevents a second notification for the same (leadId, eventKind).
--
-- Two event kinds are used today:
--   ASSIGNED_TO_WORKER — D3-T3: IncomingLead.ownerId flipped null → user id;
--                        the assigned worker receives one alert.
--   ESCALATED_1H       — D3-T4: still-unassigned daytime lead > 1 hour old;
--                        Sasha receives one escalation.
-- The Sasha 09:30 morning digest (D3-T2) has its OWN dedup row in
-- `WhatsappDigestSendLog` under digestType='LEADS_MORNING' — no row here.
--
-- `leadId` is stored as text (not FK) because `IncomingLead` is a CRM-owned
-- table and cross-schema FKs are avoided per the additive-only rule. A stale
-- leadId (row deleted in the CRM) is harmless — nothing joins on it.

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappLeadNotification" (
  "leadId"     text        NOT NULL,
  "eventKind"  text        NOT NULL CHECK ("eventKind" IN (
                 'ASSIGNED_TO_WORKER', 'ESCALATED_1H')),
  "notifiedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("leadId", "eventKind")
);

ALTER TABLE "WhatsappLeadNotification" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappLeadNotification' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappLeadNotification" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
