-- Migration 022: add PENDING/SENT state to WhatsappLeadNotification.
--
-- Motivation: the D3-T3 dedup layer originally used "row exists" as the sole
-- signal that a notification was sent. That is check-then-act — two threads
-- (the poller and the new Supabase webhook, introduced in the same commit)
-- can both pass the pre-check, both send WhatsApp, and only afterwards race
-- on the INSERT. To make the claim ATOMIC, we now INSERT the row FIRST with
-- status='PENDING', send the WhatsApp only if we won the INSERT, then UPDATE
-- the row to status='SENT'. Send failures release the claim (DELETE) so the
-- next tick can retry.
--
-- Stale-PENDING recovery: if a process crashes between claim and mark-sent,
-- the row is stuck as PENDING and the lead would never be retried. Callers
-- treat PENDING rows older than 5 minutes as reclaimable; the pre-filter in
-- findNewlyAssignedLeads mirrors that. Five minutes is generous — WhatsApp
-- sends complete in seconds — while giving webhook + poller enough breathing
-- room to never collide on a happy-path claim.
--
-- Backfill: existing rows predate the new state machine and represent
-- successful sends (they were only ever INSERTed after a successful WhatsApp
-- delivery). Default 'SENT' captures that intent without a data migration.
--
-- Applies to BOTH event kinds (ASSIGNED_TO_WORKER and ESCALATED_1H) — the
-- column lives on the table itself, not per kind. The ESCALATED_1H flow
-- reuses the same claim/mark/release helpers for the same race-safety
-- reasons.

BEGIN;

ALTER TABLE "WhatsappLeadNotification"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'SENT'
    CHECK ("status" IN ('PENDING', 'SENT'));

COMMIT;
