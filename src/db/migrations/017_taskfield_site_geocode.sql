-- Migration 017: Cache geocoded site coordinates on TaskField.
-- Additive only — five nullable columns on the existing bot-owned "TaskField"
-- table (see migration 009). No CRM-owned table is touched.
--
-- Motivation (see docs/CUSTOMER_TRACKING_PAGE_DESTINATION.md, approved
-- 2026-07-08): the customer tracking page needs a destination marker + a
-- line from the worker to the site. Geocoding the address on every page
-- refresh would be wasteful and would violate Nominatim's fair-use terms;
-- caching the result on the TaskField row itself is the smallest possible
-- surface (no new table, no separate cache keying).
--
-- Column semantics:
--   siteLat / siteLng     — the geocoded destination. Both null OR both non-null.
--   siteGeocodedAt        — server time we last called the geocoder.
--   siteGeocodeSource     — a free-form label. Current values:
--                             'nominatim'          — actual hit stored.
--                             'nominatim:no_hit'   — Nominatim returned EMPTY
--                                                    for this exact query.
--                                                    Sticky until the address
--                                                    changes (transient network
--                                                    failures do NOT write this).
--                             'manual'             — reserved for future ops UI.
--   siteGeocodeQuery      — the exact string we sent (normalized: trimmed +
--                           lowercased). When siteAddress/siteCity change,
--                           the recomputed query differs → cache-bust.
--
-- Idempotent (IF NOT EXISTS on every column). No new index — reads are keyed
-- by TaskField.id (already the primary key).

BEGIN;

ALTER TABLE "TaskField"
  ADD COLUMN IF NOT EXISTS "siteLat"           double precision,
  ADD COLUMN IF NOT EXISTS "siteLng"           double precision,
  ADD COLUMN IF NOT EXISTS "siteGeocodedAt"    timestamptz,
  ADD COLUMN IF NOT EXISTS "siteGeocodeSource" text,
  ADD COLUMN IF NOT EXISTS "siteGeocodeQuery"  text;

COMMIT;
