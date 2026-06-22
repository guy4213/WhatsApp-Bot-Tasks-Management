-- Migration 001: WhatsApp bot side-tables
-- Additive only — zero changes to existing CRM tables.
-- Convention mirrors the CRM: PascalCase quoted table names + camelCase quoted columns.
-- Run via: Supabase Dashboard → SQL Editor → Run  (recommended)
--      or: npm run migrate  (requires DATABASE_URL in .env)

BEGIN;

-- State enum for pending actions
DO $$ BEGIN
  CREATE TYPE "WhatsappActionState" AS ENUM (
    'PENDING_EMPLOYEE_CONFIRM',
    'PENDING_MANAGER_APPROVAL',
    'APPROVED',
    'REJECTED',
    'EXECUTED',
    'EXPIRED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── WhatsappPendingAction ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "WhatsappPendingAction" (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "requesterUserId" text        NOT NULL REFERENCES "User"(id),
  "actionType"      text        NOT NULL,          -- CREATE_TASK | EDIT_FIELD | EDIT_DUEDATE | REASSIGN | EDIT_LINK
  "targetTaskId"    text        REFERENCES "Task"(id),
  payload           jsonb       NOT NULL,           -- {field, old_value, new_value} or full new-task fields
  state             "WhatsappActionState" NOT NULL DEFAULT 'PENDING_EMPLOYEE_CONFIRM',
  "approverUserId"  text        REFERENCES "User"(id),
  "expiresAt"       timestamptz NOT NULL,
  "resolvedAt"      timestamptz,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wpa_state
  ON "WhatsappPendingAction"(state);

CREATE INDEX IF NOT EXISTS idx_wpa_requester
  ON "WhatsappPendingAction"("requesterUserId");

-- ── WhatsappAuditLog ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "WhatsappAuditLog" (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"             text        REFERENCES "User"(id),
  "whatsappNumber"     text        NOT NULL,
  "originalMessage"    text,
  "transcribedMessage" text,
  "detectedIntent"     text,
  "detectedAction"     text,
  confidence           numeric,
  "targetTaskId"       text        REFERENCES "Task"(id),
  "oldValues"          jsonb,
  "newValues"          jsonb,
  "confirmationStatus" text,       -- CONFIRMED | DECLINED | NONE
  "approvalStatus"     text,       -- NOT_REQUIRED | PENDING | APPROVED | REJECTED
  "approverUserId"     text        REFERENCES "User"(id),
  "managerNotified"    boolean     DEFAULT false,
  "executionStatus"    text,       -- SUCCESS | FAILED | SKIPPED
  "errorMessage"       text,
  "pendingActionId"    uuid        REFERENCES "WhatsappPendingAction"(id),
  "createdAt"          timestamptz NOT NULL DEFAULT now()
);

-- ── WhatsappNotificationRecipient ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "WhatsappNotificationRecipient" (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"     text    NOT NULL REFERENCES "User"(id),
  "eventTypes" text[]  NOT NULL,   -- {DUEDATE_APPROVAL, DEADLINE_EXCEEDED, TASK_COMPLETED, ...}
  "isActive"   boolean NOT NULL DEFAULT true,
  "createdAt"  timestamptz NOT NULL DEFAULT now()
);

-- ── Row Level Security (Supabase) ─────────────────────────────────────────────
-- The bot connects with the service-role key which bypasses RLS entirely.
-- We still enable RLS with no permissive policies so anon/authenticated clients
-- cannot read or write these tables directly.

ALTER TABLE "WhatsappPendingAction"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsappAuditLog"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsappNotificationRecipient" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappPendingAction' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappPendingAction" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappAuditLog' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappAuditLog" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappNotificationRecipient' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappNotificationRecipient" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
