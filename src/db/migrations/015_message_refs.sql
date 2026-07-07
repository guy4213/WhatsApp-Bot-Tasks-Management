-- Migration 015: WhatsappMessageRef — general quoted-message context store (Phase 2).
-- Additive only — zero changes to existing CRM/bot tables.
--
-- When the bot sends a message that has a clear context (a TaskField card, an
-- equipment reminder, a daily digest, a menu, ...), we record the OUTBOUND Meta
-- message id (wamid) together with WHAT the message was about. When a worker later
-- swipe-replies (quotes) that message, Meta's inbound webhook carries
-- context.id = that wamid, and we resolve it back to the original context.
--
-- Deliberately GENERAL (not wamid→taskFieldId only): entityType/entityId/payload
-- describe any context; `taskFieldId` is a convenience FK populated only when
-- entityType='task_field'. First deterministic behavior: task_field status updates.
--
-- Convention mirrors 012/014: PascalCase quoted table, camelCase quoted columns,
-- text + CHECK (no PG enums), RLS enabled with a deny-all RESTRICTIVE policy (the
-- bot uses the service-role key which bypasses RLS).
--
-- Retention: `expiresAt` is nullable; the resolver treats NULL as "no expiry" and
-- ignores rows whose expiresAt has passed. TaskField refs are written with a real
-- expiresAt (default now()+30 days) so a very old quote can't accidentally act.

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappMessageRef" (
  wamid             text        PRIMARY KEY,          -- outbound Meta message id
  "recipientUserId" text        REFERENCES "User"(id),-- who we sent it to (nullable)
  "entityType"      text        NOT NULL CHECK ("entityType" IN (
                      'task_field','equipment_reminder','daily_digest',
                      'menu','task','lead','general')),
  "entityId"        text,                             -- natural id for the type (as text)
  "taskFieldId"     uuid        REFERENCES "TaskField"(id), -- convenience FK when task_field
  kind              text        NOT NULL,             -- pre_reminder / assignment_card / eta_prompt / status_confirm / ...
  payload           jsonb,                            -- richer per-type context
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "expiresAt"       timestamptz                       -- NULL = no expiry
);

CREATE INDEX IF NOT EXISTS idx_wa_msgref_taskfield
  ON "WhatsappMessageRef"("taskFieldId");
CREATE INDEX IF NOT EXISTS idx_wa_msgref_entity
  ON "WhatsappMessageRef"("entityType", "entityId");

ALTER TABLE "WhatsappMessageRef" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappMessageRef' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappMessageRef" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
