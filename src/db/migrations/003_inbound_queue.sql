-- Migration 003: Durable inbound message queue (+ dedup)
-- Persists every inbound WhatsApp message BEFORE the webhook ACKs 200, so a
-- crash mid-processing never loses the message — a startup recovery sweep
-- reprocesses anything still 'pending'.
--
-- The "msgId" PRIMARY KEY also serves as the dedup key: a re-delivered message
-- hits ON CONFLICT DO NOTHING and is skipped.

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappInboundQueue" (
  "msgId"       text        PRIMARY KEY,          -- Meta message id (also the dedup key)
  "fromPhone"   text        NOT NULL,
  payload       jsonb       NOT NULL,             -- the raw message object
  status        text        NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  attempts      integer     NOT NULL DEFAULT 0,
  error         text,
  "receivedAt"  timestamptz NOT NULL DEFAULT now(),
  "processedAt" timestamptz
);

CREATE INDEX IF NOT EXISTS idx_wiq_status
  ON "WhatsappInboundQueue"(status, "receivedAt");

ALTER TABLE "WhatsappInboundQueue" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappInboundQueue' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappInboundQueue" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
