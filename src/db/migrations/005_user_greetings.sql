-- Migration 005: per-user daily greeting tracker
-- Lets the bot greet each user by name once per day (the first message of the day,
-- Asia/Jerusalem). Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS "WhatsappUserGreeting" (
  phone           text PRIMARY KEY,         -- WhatsApp number (E.164, no +)
  "lastGreetedOn" date NOT NULL             -- last calendar day we greeted (Asia/Jerusalem)
);

ALTER TABLE "WhatsappUserGreeting" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'WhatsappUserGreeting' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "WhatsappUserGreeting" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

COMMIT;
