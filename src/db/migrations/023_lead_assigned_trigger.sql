-- Migration 023: Postgres trigger → HTTP POST on the SPECIFIC transition only.
--
-- Motivation: migration 022 introduced a Supabase Database Webhook to deliver
-- worker-assignment alerts within ~1 second of a CRM claim. That webhook fires
-- on EVERY UPDATE of `IncomingLead`. At today's volume that is a rounding
-- error, but with growth in leads (both in raw count and in the number of
-- UPDATEs per lead — taskId, notifiedAt, transferredToId, …) the bot would
-- absorb thousands of irrelevant HTTP calls per day. This migration replaces
-- the Dashboard-managed webhook with a Postgres trigger that fires ONLY on
-- the transition we care about — no wasted HTTP calls, no wasted bot
-- invocations, no wasted Supabase webhook quota.
--
-- Transition predicate — fire when EITHER:
--   (a) status just flipped NEW → ACTIVE, or
--   (b) ownerId just filled on an already-ACTIVE row (the CRM's split-write
--       race between the two columns; we saw this in prod and it's why the
--       app-side webhook also matched on this case).
-- Both conditions are safe to fire on — the bot's `tryClaimLeadNotification`
-- atomic INSERT dedups any duplicate transitions and the poller safety net
-- catches the rest.
--
-- Delivery mechanism: `net.http_post` from the `pg_net` extension. `pg_net`
-- enqueues the request in `net.http_request_queue` inside the CALLING
-- transaction and a background worker fans it out asynchronously — so
-- (a) the CRM UPDATE is never blocked waiting on HTTP, and
-- (b) a rolled-back CRM UPDATE will not deliver a stale notification (the
--     enqueue itself is rolled back with the transaction).
--
-- Config: bot host URL + shared secret live in `bot_webhook_config` — a
-- one-row-per-key table. Read once per trigger fire. Deploy sets the values
-- via UPDATE (see README of this migration file below). RLS deny-all-public
-- prevents anon/service-role-anon exposure of the secret.
--
-- Interaction with migration 022 / the app-side webhook route: the
-- `POST /webhooks/supabase/lead-assigned` endpoint is UNCHANGED. This trigger
-- posts to that same URL with the same payload shape. If the DB webhook was
-- previously configured in the Supabase Dashboard UI, DELETE it there — the
-- trigger replaces it. Running both would double every notification.

BEGIN;

-- 1. Extension — Supabase provisions pg_net in the `extensions` schema.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 2. Config table — one row per key. Stores the bot host URL + the shared
--    secret the endpoint validates via x-webhook-secret. The secret MUST
--    match the SUPABASE_LEAD_WEBHOOK_SECRET env var on the bot host.
CREATE TABLE IF NOT EXISTS "BotWebhookConfig" (
  "key"       text        PRIMARY KEY,
  "value"     text        NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "BotWebhookConfig" ENABLE ROW LEVEL SECURITY;

-- Deny everything to PUBLIC (including anon + authenticated). Only the DB
-- owner (service_role bypasses RLS) can read/write. The trigger function is
-- SECURITY DEFINER so it runs as the owner and can read the config even
-- when fired by a role that has no access to this table.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'BotWebhookConfig' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "BotWebhookConfig" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

-- Seed placeholder rows so the operator's post-migration step is a plain
-- UPDATE (not "did I miss an INSERT?"). Placeholder values disable the
-- trigger (see the LIKE '%REPLACE-ME%' guard below) so a half-configured
-- deployment is a no-op, never a broken delivery.
INSERT INTO "BotWebhookConfig" ("key", "value") VALUES
  ('lead_assigned_url',    'https://REPLACE-ME/webhooks/supabase/lead-assigned'),
  ('lead_assigned_secret', 'REPLACE-ME')
ON CONFLICT ("key") DO NOTHING;

-- 3. Trigger function. SECURITY DEFINER so it can read config even when the
--    UPDATE was made by a role that has no access to BotWebhookConfig.
--    SET search_path pinned defensively (SECURITY DEFINER + mutable
--    search_path is a well-known privilege-escalation vector).
CREATE OR REPLACE FUNCTION public.notify_lead_assigned_worker()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  cfg_url    text;
  cfg_secret text;
  payload    jsonb;
BEGIN
  SELECT "value" INTO cfg_url    FROM "BotWebhookConfig" WHERE "key" = 'lead_assigned_url';
  SELECT "value" INTO cfg_secret FROM "BotWebhookConfig" WHERE "key" = 'lead_assigned_secret';

  -- Missing / placeholder config → silent no-op. The bot's own poller safety
  -- net (every 15 min) still delivers the alert, just not instantly.
  IF cfg_url IS NULL OR cfg_url = '' OR cfg_url LIKE '%REPLACE-ME%' THEN
    RETURN NEW;
  END IF;

  -- Payload matches the shape the app-side endpoint expects (see
  -- src/routes/supabaseLeadWebhook.ts). This is the SAME shape Supabase
  -- Dashboard Webhooks produce, so the endpoint code does not need to
  -- distinguish the caller.
  payload := jsonb_build_object(
    'type',       'UPDATE',
    'table',      'IncomingLead',
    'schema',     'public',
    'record',     jsonb_build_object(
                    'id',      NEW.id,
                    'status',  NEW.status,
                    'ownerId', NEW."ownerId"
                  ),
    'old_record', jsonb_build_object(
                    'id',      OLD.id,
                    'status',  OLD.status,
                    'ownerId', OLD."ownerId"
                  )
  );

  -- Enqueue the HTTP POST. pg_net is async — this returns immediately and
  -- the actual send happens on a background worker after this transaction
  -- commits. Failures are surfaced in net._http_response for debugging.
  PERFORM net.http_post(
    url     := cfg_url,
    body    := payload,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', cfg_secret
    )
  );

  RETURN NEW;
END;
$$;

-- 4. Trigger — the WHEN clause is the WHOLE POINT of this migration. Postgres
--    evaluates it against OLD/NEW and only invokes the function when the
--    predicate is true. Every unrelated UPDATE (taskId set, notifiedAt bump,
--    transferredToId change, …) is filtered out at the DB level with ZERO
--    HTTP calls, ZERO bot invocations.
DROP TRIGGER IF EXISTS trg_lead_assigned_worker ON "IncomingLead";
CREATE TRIGGER trg_lead_assigned_worker
AFTER UPDATE ON "IncomingLead"
FOR EACH ROW
WHEN (
  NEW.status = 'ACTIVE'
  AND (
    OLD.status IS DISTINCT FROM 'ACTIVE'
    OR (NEW."ownerId" IS NOT NULL AND OLD."ownerId" IS NULL)
  )
)
EXECUTE FUNCTION public.notify_lead_assigned_worker();

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- POST-MIGRATION STEP (do this ONCE per environment, in Supabase SQL Editor):
--
--   UPDATE "BotWebhookConfig"
--   SET "value" = 'https://<your-bot-host>/webhooks/supabase/lead-assigned',
--       "updatedAt" = now()
--   WHERE "key" = 'lead_assigned_url';
--
--   UPDATE "BotWebhookConfig"
--   SET "value" = '<the SAME value as SUPABASE_LEAD_WEBHOOK_SECRET on the bot>',
--       "updatedAt" = now()
--   WHERE "key" = 'lead_assigned_secret';
--
-- After this, assign an IncomingLead in the CRM (or run:
--   UPDATE "IncomingLead" SET status = 'ACTIVE', "ownerId" = '<user-id>'
--   WHERE id = '<lead-id>';)
-- and check net._http_response for the delivery status.
-- ─────────────────────────────────────────────────────────────────────────────
