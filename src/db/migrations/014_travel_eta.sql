-- Migration 014: optional worker-declared travel ETA on a field visit.
-- Additive only — zero changes to existing CRM tables, no CRM writes.
--
-- Part of the "active-task context after יצאתי" feature (Phase 1). When a worker
-- reports "יצאתי" (fieldStatus → EN_ROUTE) the bot asks for an estimated travel
-- time. It is OPTIONAL (never a condition for keeping the active-task context),
-- but when supplied it is stored here so it can later feed the customer-facing
-- ETA in the arrival-tracking feature.
--
--   "travelEtaMinutes"  — the worker's stated drive time in minutes.
--   "expectedArrivalAt" — departedAt + travelEtaMinutes, precomputed for display.
--
-- The active-task pointer itself lives in WhatsappConversationContext (no new
-- table); only these two durable columns are added here. Idempotent:
-- ADD COLUMN IF NOT EXISTS so re-running is safe.

BEGIN;

ALTER TABLE "TaskField"
  ADD COLUMN IF NOT EXISTS "travelEtaMinutes"  integer,
  ADD COLUMN IF NOT EXISTS "expectedArrivalAt" timestamptz;

COMMIT;
