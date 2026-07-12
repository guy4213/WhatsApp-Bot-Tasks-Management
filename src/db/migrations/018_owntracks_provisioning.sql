-- Migration 018: OwnTracks auto-provisioning fields on WorkerDeviceIdentity.
-- Additive only — extends the existing table from migration 016. Zero changes
-- to existing rows: all new columns are nullable so the row seeded by
-- scripts/seedWorkerDeviceIdentity.ts (workerKey='guy') continues to work
-- against POC_OWNTRACKS_USERS via the ENV fallback until re-provisioned.
--
-- Goal (see docs/OWNTRACKS_PROVISIONING.md and TASKS.md §4.20): move OwnTracks
-- device credentials from POC_OWNTRACKS_USERS (env, static, redeploy per user)
-- to a DB-backed per-User provisioning flow. A manager triggers "enable
-- location tracking for worker X"; the bot generates a one-time provisioning
-- token, sends a Magic Link to the worker's phone (from User.phone), the
-- OwnTracks app fetches its .otrc config from the server on first tap, and
-- from then on authenticates with a per-worker workerKey + password whose
-- bcrypt hash lives here.
--
-- Password rule: the raw password NEVER lives at rest. It is generated in
-- memory at consume-time (GET /owntracks/config/:token), hashed with bcrypt,
-- the hash is persisted here, the plaintext is emitted once in the .otrc
-- response, then discarded.
--
-- Convention mirrors 013/016: PascalCase quoted table, camelCase quoted
-- columns, timestamptz. Idempotent — safe to re-run on partially-applied
-- state.

BEGIN;

-- Provisioning credential columns (bcrypt hash, per-worker tracker id).
ALTER TABLE "WorkerDeviceIdentity"
  ADD COLUMN IF NOT EXISTS "passwordHash" text,
  ADD COLUMN IF NOT EXISTS "trackerId"    text;

-- One-time provisioning token + expiry. Cleared on consume; nullable when the
-- device is already provisioned or has never been provisioned.
ALTER TABLE "WorkerDeviceIdentity"
  ADD COLUMN IF NOT EXISTS "provisioningToken"     text,
  ADD COLUMN IF NOT EXISTS "provisioningExpiresAt" timestamptz;

-- Lifecycle timestamps. `provisionedAt` = first successful .otrc consume;
-- `revokedAt` = manager-initiated revoke (isActive also flipped to false).
ALTER TABLE "WorkerDeviceIdentity"
  ADD COLUMN IF NOT EXISTS "provisionedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "revokedAt"     timestamptz;

-- Uniqueness on the provisioning token — only while it exists. Two devices
-- pending provisioning can share NULL (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_workerdeviceidentity_prov_token
  ON "WorkerDeviceIdentity"("provisioningToken")
  WHERE "provisioningToken" IS NOT NULL;

-- Fast auth path lookup: (workerKey) WHERE isActive AND passwordHash NOT NULL.
-- Ordinary workerKey already has a UNIQUE constraint from migration 016.
-- This partial index just narrows the working set the hot path scans.
CREATE INDEX IF NOT EXISTS idx_workerdeviceidentity_active_provisioned
  ON "WorkerDeviceIdentity"("workerKey")
  WHERE "isActive" = true AND "passwordHash" IS NOT NULL;

COMMIT;
