-- Migration 009: field-worker (Galit v2) inspection layer — 3 tables, no photos.
-- Additive only — zero changes to existing CRM tables.
-- Convention mirrors the CRM / earlier migrations: PascalCase quoted table names +
-- camelCase quoted columns, uuid PKs with gen_random_uuid(), text FKs to the CRM
-- (User/Task ids are text), text + CHECK instead of PG enums, timestamptz default
-- now(), RLS enabled with a deny-all RESTRICTIVE policy (the bot connects with the
-- service-role key, which bypasses RLS; anon/authenticated clients get nothing).
--
-- Status ownership: the CRM owns "Task".status — the bot NEVER writes it. The live
-- operational status lives ONLY in "TaskField"."fieldStatus" (10 values, no STARTED).
--
-- Three tables:
--   "InspectionType"      — dictionary of inspection types keyed by מק"ט (code), with
--                           a Hebrew label and one of 13 inspection families. `code`
--                           matches "Task"."productName". Catalog seed (~150 rows) is a
--                           later migration (B1-blocked) — this file only creates it.
--   "InspectionChecklist" — required equipment PER FAMILY (defined once per family,
--                           not per מק"ט). Seeded below for 4 families (17 rows).
--   "TaskField"           — 1:1 with "Task" (taskId UNIQUE). A Task is a field
--                           inspection IFF a row exists here. Static site metadata +
--                           the live fieldStatus + per-status timestamps + a single
--                           inline problem + a missing-info flag.

BEGIN;

-- ── 1. InspectionType — dictionary keyed by מק"ט ──────────────────────────────

CREATE TABLE IF NOT EXISTS "InspectionType" (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL UNIQUE,            -- the מק"ט; matches Task."productName"
  "labelHe"   text        NOT NULL,
  family      text        NOT NULL CHECK (family IN (
                'radiation','noise','air','asbestos','radon','odor',
                'water','soil','occupational','thermal','green','opinion','general')),
  "isActive"  boolean     NOT NULL DEFAULT true,
  "sortOrder" integer     NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inspectiontype_family ON "InspectionType"(family);

-- ── 2. InspectionChecklist — equipment only, PER FAMILY (no `kind` column) ─────

CREATE TABLE IF NOT EXISTS "InspectionChecklist" (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family       text        NOT NULL CHECK (family IN (
                 'radiation','noise','air','asbestos','radon','odor',
                 'water','soil','occupational','thermal','green','opinion','general')),
  code         text        NOT NULL,                  -- machine code, e.g. noise_meter
  "labelHe"    text        NOT NULL,
  "isRequired" boolean     NOT NULL DEFAULT true,
  "sortOrder"  integer     NOT NULL DEFAULT 0,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, code)
);
CREATE INDEX IF NOT EXISTS idx_checklist_family ON "InspectionChecklist"(family);

-- ── 3. TaskField — 1:1 with Task. A Task is an inspection IFF a row exists here ─

CREATE TABLE IF NOT EXISTS "TaskField" (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId"                text        NOT NULL UNIQUE REFERENCES "Task"(id),
  "inspectionTypeId"      uuid        NOT NULL REFERENCES "InspectionType"(id),
  family                  text        NOT NULL CHECK (family IN (   -- snapshot for fast checklist lookups
                            'radiation','noise','air','asbestos','radon','odor',
                            'water','soil','occupational','thermal','green','opinion','general')),
  -- static metadata (written once at assignment)
  "siteAddress"           text,
  "siteCity"              text,
  "fieldContactName"      text,
  "fieldContactPhone"     text,
  "navigationUrl"         text,
  "specialInstructions"   text,
  -- live operational status (no STARTED) — the bot owns this, the CRM owns Task.status
  "fieldStatus"           text        NOT NULL DEFAULT 'ASSIGNED' CHECK ("fieldStatus" IN (
    'ASSIGNED','CONFIRMED','DECLINED','NEEDS_MORE_INFO','EN_ROUTE',
    'ARRIVED','FINISHED_FIELD','WAITING_FOR_INFO','HAS_PROBLEM','CANCELED')),
  "assignedAt"            timestamptz NOT NULL DEFAULT now(),
  "confirmedAt"           timestamptz,
  "declinedAt"            timestamptz,
  "declinedReason"        text,
  "departedAt"            timestamptz,
  "arrivedAt"             timestamptz,
  "finishedAt"            timestamptz,
  -- field notes + single inline problem (structured TaskFieldEntry deferred)
  "fieldNotes"            text,
  "problemType"           text        CHECK ("problemType" IS NULL OR "problemType" IN (
    'CUSTOMER_NOT_ANSWERING','NO_ACCESS','CUSTOMER_NOT_PRESENT',
    'MISSING_EQUIPMENT','CANNOT_PERFORM','PROFESSIONAL_ISSUE','OTHER')),
  "problemNote"           text,
  "hasOpenProblem"        boolean     NOT NULL DEFAULT false,
  "missingReportInfo"     boolean     NOT NULL DEFAULT false,
  "missingReportInfoNote" text,
  "managerNotifiedAt"     timestamptz,
  "updatedByUserId"       text        REFERENCES "User"(id),
  "createdAt"             timestamptz NOT NULL DEFAULT now(),
  "updatedAt"             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_taskfield_status ON "TaskField"("fieldStatus");
CREATE INDEX IF NOT EXISTS idx_taskfield_open_problem
  ON "TaskField"("taskId") WHERE "hasOpenProblem" = true;

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The bot connects with the service-role key which bypasses RLS entirely. We still
-- enable RLS with no permissive policies so anon/authenticated clients cannot read
-- or write these tables directly. (Mirrors 001/008.)

ALTER TABLE "InspectionType"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InspectionChecklist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskField"           ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'InspectionType' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "InspectionType" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'InspectionChecklist' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "InspectionChecklist" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'TaskField' AND policyname = 'deny_all_public'
  ) THEN
    CREATE POLICY deny_all_public ON "TaskField" AS RESTRICTIVE
      FOR ALL TO PUBLIC USING (false);
  END IF;
END $$;

-- ── SEED: InspectionChecklist — equipment for the 4 declared families (17 rows) ─
-- Idempotent: ON CONFLICT (family, code) DO NOTHING so re-running the migration
-- leaves exactly these 17 rows.

INSERT INTO "InspectionChecklist" (family, code, "labelHe", "sortOrder") VALUES
  ('radiation','elf_meter','מד ELF',1),
  ('radiation','rf_meter','מד RF',2),
  ('radiation','tripod','חצובה',3),
  ('radiation','field_form','טופס שטח',4),
  ('noise','noise_meter','מד רעש',1),
  ('noise','calibrator','קליברטור',2),
  ('noise','tripod','חצובה',3),
  ('noise','windscreen','מגן רוח',4),
  ('noise','batteries','סוללות',5),
  ('asbestos','protection','ציוד מיגון',1),
  ('asbestos','sample_bags','שקיות דגימה',2),
  ('asbestos','sample_form','טופס דגימה',3),
  ('asbestos','marking','מדבקות סימון',4),
  ('radon','detector','גלאי ראדון',1),
  ('radon','placement_form','טופס הצבה',2),
  ('radon','collection_form','טופס איסוף',3),
  ('radon','marking','מדבקות סימון',4)
ON CONFLICT (family, code) DO NOTHING;

COMMIT;
