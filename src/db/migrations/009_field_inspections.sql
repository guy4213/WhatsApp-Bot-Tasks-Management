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
--   "TaskField"           — scheduled field visit / inspection appointment created
--                           from the CRM field scheduling form using an existing Task ID.
--                           One Task may have multiple TaskField rows. Static scheduling
--                           + site metadata, live fieldStatus, per-status timestamps,
--                           a single inline problem, and a missing-info flag.

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

-- ── 3. TaskField — scheduled field visit; one Task may have many rows ─

CREATE TABLE IF NOT EXISTS "TaskField" (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId"                text        NOT NULL REFERENCES "Task"(id),
  "inspectionTypeId"      uuid        NOT NULL REFERENCES "InspectionType"(id),
  family                  text        NOT NULL CHECK (family IN (   -- snapshot for fast checklist lookups
                            'radiation','noise','air','asbestos','radon','odor',
                            'water','soil','occupational','thermal','green','opinion','general')),
  -- scheduling metadata from the CRM field scheduling form
  "appointmentTitle"      text,
  "scheduledStartAt"      timestamptz NOT NULL,
  "scheduledEndAt"        timestamptz NOT NULL,
  "durationMinutes"       integer     NOT NULL CHECK ("durationMinutes" > 0),
  "workerNotifiedAt"      timestamptz,
  -- static site metadata (written once from the scheduling form)
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
  -- row creation / assignment time; scheduledStartAt is the planned field time
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
CREATE INDEX IF NOT EXISTS idx_taskfield_task_id ON "TaskField"("taskId");
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

-- ── D1-T7: Add isFieldInspection column (idempotent) ─────────────────────────
-- Column was omitted from the original CREATE TABLE above; added here via
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS so re-running is safe.

ALTER TABLE "InspectionType"
  ADD COLUMN IF NOT EXISTS "isFieldInspection" boolean NOT NULL DEFAULT true;

-- ── D1-T7: Seed InspectionType catalog — field-inspection rows only ───────────
-- Source: SPEC_FIELD_V2.md lines 416-571.
-- Only rows with isFieldInspection = true are inserted here.
-- Shielding rows (radiation מיגון), office-only rows (survey prep, reports,
-- calibration certs, thermal, opinion, general/logistics) are excluded.
-- Idempotent: ON CONFLICT (code) DO NOTHING — re-running leaves DB unchanged.

INSERT INTO "InspectionType" (code, "labelHe", family, "isFieldInspection", "isActive", "sortOrder") VALUES
-- ── איכות אוויר → air ─────────────────────────────────────────────────────────
  ('66',    'אוויר – בדיקת איכות אוויר סביבתית',                                 'air', true, true, 1),
  ('72',    'אוויר – בדיקת איכות אוויר תוך מבני',                                'air', true, true, 2),
  ('10046', 'אוויר – בדיקת איכות אוויר מתחבורה',                                 'air', true, true, 3),
  ('10072', 'אוויר – ניטור פורמלדהיד',                                           'air', true, true, 4),
  ('69',    'אוויר – דיגום עובשים באוויר – בדיקה ראשונה',                        'air', true, true, 5),
  ('10066', 'אוויר – דיגום עובשים באוויר – דיגום נוסף באתר',                     'air', true, true, 6),
  ('10073', 'אוויר – דיגום חיידקים באוויר – דיגום נוסף באתר',                    'air', true, true, 7),
  ('10126', 'אוויר – דיגום משטח עובשים – דיגום נוסף באתר',                       'air', true, true, 8),
  ('10078', 'אוויר – בדיקת איכות אוויר סביבתית – יום נוסף',                      'air', true, true, 9),
  ('10047', 'אוויר – תוספת אמוניה',                                              'air', true, true, 10),
  ('10127', 'איכות אוויר – תחנה לניטור אוויר – מזהמים כימיים',                   'air', true, true, 11),
  ('10159', 'איכות אוויר – תחנה לניטור אוויר – חודש נוסף – מזהמים כימיים',       'air', true, true, 12),
-- ── אסבסט → asbestos ──────────────────────────────────────────────────────────
  ('10023', 'אסבסט – ביצוע סקר אסבסט ע"י בודק מוסמך',                            'asbestos', true, true, 1),
  ('10026', 'אסבסט – זיהוי צובר אסבסט',                                          'asbestos', true, true, 2),
  ('10112', 'אסבסט – ניטור סיבי אסבסט באוויר – 2 דגימות',                        'asbestos', true, true, 3),
-- ── ראדון → radon (kits/detectors = field; calibration/cert = office — skipped) ─
  ('10044', 'ראדון – בדיקת גז ראדון קצרת טווח ע״י בודק מוסמך',                   'radon', true, true, 1),
  ('10017', 'ראדון – בדיקת גז ראדון ארוכת טווח ע״י בודק מוסמך',                  'radon', true, true, 2),
  ('61',    'ראדון – ערכה – בדיקת ראדון קצרת טווח',                              'radon', true, true, 3),
  ('10000', 'ראדון – ערכה לבדיקת גז ראדון ארוכת טווח',                           'radon', true, true, 4),
  ('87',    'ראדון – פרט ראדון',                                                 'radon', true, true, 5),
  ('10022', 'ראדון – RD200 גלאי ראדון רציף',                                     'radon', true, true, 6),
  ('10095', 'ראדון – RD200P Radon Eye +2 גלאי ראדון רציף',                       'radon', true, true, 7),
  ('10160', 'ראדון – RADELEC כולל לידר',                                         'radon', true, true, 8),
  ('10161', 'ראדון – גלאי אלקטרוני ארוך טווח חדש',                              'radon', true, true, 9),
  ('10162', 'ראדון – גלאי אלקטרוני קצר טווח חדש',                               'radon', true, true, 10),
  -- SKIPPED: ('70', ...) כיול מעבדה — isFieldInspection = false
  -- SKIPPED: ('10069', ...) הנפקת תעודת כיול — isFieldInspection = false
-- ── ריח → odor ────────────────────────────────────────────────────────────────
  ('10013', 'ריח – איתור וסילוק מטרד ריח',                                       'odor', true, true, 1),
  ('10003', 'ריח – בדיקת ריח ע״י צוות מריחים',                                   'odor', true, true, 2),
  ('10083', 'ריח – בדיקת ריח ע״י בודק ריח מוסמך',                                'odor', true, true, 3),
  -- SKIPPED: ('10055', ...) דוח סביבתי ריח – הערכת פיזור ריחות להגשה לרשויות — office report, isFieldInspection = false
-- ── מים → water ───────────────────────────────────────────────────────────────
  ('63',    'מים – בדיקה מיקרוביאלית מלאה, דיגום ראשון באתר',                    'water', true, true, 1),
  ('10076', 'מים – בדיקת מתכות חלקית, דיגום ראשון באתר',                         'water', true, true, 2),
  ('10120', 'מים – בדיקה מיקרוביאלית מלאה + בדיקת מתכות חלקית',                  'water', true, true, 3),
  ('10121', 'מים – בדיקת מתכות מלאה',                                            'water', true, true, 4),
  ('10122', 'מים – בדיקת מתכות ומיקרוביאלית מלאה',                               'water', true, true, 5),
  ('10075', 'מים – בדיקה מיקרוביאלית מלאה, דיגום נוסף באתר',                     'water', true, true, 6),
  ('10077', 'מים – בדיקת מתכות חלקית, דיגום נוסף באתר',                          'water', true, true, 7),
-- ── קרקע → soil (field sampling = field; office survey/plan prep = skipped) ───
  -- SKIPPED: ('10027', ...) הכנת סקר קרקע היסטורי — office survey, isFieldInspection = false
  -- SKIPPED: ('10050', ...) הכנת תוכנית דיגום לקרקע — office planning, isFieldInspection = false
  ('10087', 'קרקע – בדיקת רעידות ממכונות דחיקת צינור',                           'soil', true, true, 3),
  ('10102', 'קרקע – דיגום לקרקע ע״פ סעיף מס׳ 1',                                 'soil', true, true, 4),
  ('10103', 'קרקע – דיגום גז קרקע ע״פ סעיף מס׳ 1',                              'soil', true, true, 5),
  ('10088', 'קרקע – דיגום נוסף באתר חיידקים בחול תחת ריצוף',                     'soil', true, true, 6),
  ('10089', 'קרקע – פעימות וספיקת משאבות חיידקים בדגימת חול',                    'soil', true, true, 7),
-- ── גהות / רעש תעסוקתי → occupational (measurement = field; office rows skipped) ─
  ('62',    'גהות – בדיקת רעש תעסוקתית',                                         'occupational', true, true, 1),
  -- SKIPPED: ('98', ...) הכנת סקר מקדים — office survey, isFieldInspection = false
  -- SKIPPED: ('10084', ...) הכנת סקר מקדים חומרים כימיים ורעש — office survey, isFieldInspection = false
  ('10104', 'גהות – יום עבודה ניטור סביבתי תעסוקתי',                             'occupational', true, true, 4),
  -- SKIPPED: ('10105', ...) טופס מידע התקשרות עם הלקוח — form/admin, isFieldInspection = false
  -- SKIPPED: ('10137', ...) תסקיר סביבתי להיתר בנייה — office report, isFieldInspection = false
-- ── רעש → noise (measurement = field; consulting/forecast office rows skipped) ─
  ('73',    'רעש – בדיקת רעש סביבתית עפ״י סעיף 1',                               'noise', true, true, 1),
  ('10011', 'רעש – בדיקת רעש סביבתית רציפה עד 24 שעות',                          'noise', true, true, 2),
  ('10048', 'רעש – בדיקת רעש רציפה יום נוסף',                                    'noise', true, true, 3),
  ('10012', 'רעש – בדיקת רעש מתחבורה',                                           'noise', true, true, 4),
  ('10028', 'רעש – בדיקת רעש במשתחמים',                                          'noise', true, true, 5),
  ('10043', 'רעש – בדיקת רעש מציוד בנייה, השתל״ס 1979-1',                        'noise', true, true, 6),
  ('10085', 'רעש – בדיקת רעש מטוסים',                                            'noise', true, true, 7),
  ('10060', 'רעש – בדיקה אקוסטית לחדר קול נישא באוויר וקול הולם',                'noise', true, true, 8),
  ('10061', 'רעש – חדר נוסף קול נישא באוויר וקול הולם',                          'noise', true, true, 9),
  ('10058', 'רעש – בדיקה אקוסטית לחדר קול הולם',                                 'noise', true, true, 10),
  ('10059', 'רעש – בדיקה אקוסטית לחדר קול הולם חדר נוסף',                        'noise', true, true, 11),
  ('10070', 'רעש – בדיקה אקוסטית לחדר קול נישא באוויר',                          'noise', true, true, 12),
  ('10071', 'רעש – בדיקה אקוסטית לחדר קול נישא באוויר חדר נוסף',                 'noise', true, true, 13),
  ('10062', 'רעש – בדיקת רעש במסגרת ייעוץ אקוסטי למבנה בבנייה',                  'noise', true, true, 14),
  ('10042', 'רעש – סקר אקוסטי להפחתת מפלסי הרעידות',                             'noise', true, true, 15),
  ('10056', 'רעש – בדיקת רעש ממעלית',                                            'noise', true, true, 16),
  ('10123', 'רעש – בדיקת מעלית נוספת',                                           'noise', true, true, 17),
  -- SKIPPED: ('10037', ...) ייעוץ אקוסטי להפחתת רעש — office consulting, isFieldInspection = false
  ('10086', 'רעש אקוסטיקה – בדיקת רעידות',                                       'noise', true, true, 19),
  ('10079', 'רעש אקוסטיקה – מתן היתר לבריכה פרטית',                              'noise', true, true, 20),
  ('10125', 'רעש – הספק אקוסטי לאולם / פאב',                                     'noise', true, true, 21),
  ('10139', 'בדיקה אקוסטית – רעש מערכות',                                        'noise', true, true, 22),
  -- SKIPPED: ('10119', ...) ביצוע חיזוי רעש לכביש חדש — office noise forecast, isFieldInspection = false
-- ── קרינה → radiation : field measurement rows only ──────────────────────────
  ('9',     'קרינה – בדיקת קרינה אלקטרומגנטית מרשת החשמל',                       'radiation', true, true, 1),
  ('56',    'קרינה – בדיקת קרינה משולבת מדוח רשת החשמל',                         'radiation', true, true, 2),
  ('83',    'קרינה – בדיקת קרינה רציפה מרשת החשמל',                              'radiation', true, true, 3),
  ('10064', 'קרינה – בדיקת קרינה מרכב היברידי / חשמלי',                          'radiation', true, true, 4),
  ('002',   'RF – קרינה – בדיקת קרינה אלקטרומגנטית ממתקני שידור ואנטנות סלולריות', 'radiation', true, true, 5),
  ('10034', 'קרינה – בדיקת איפוס ואיזון הארקות אלקטרומגנטית',                    'radiation', true, true, 6),
  ('10036', 'קרינה – בדיקת קרינה רקע RF + ELF בתחילת הבנייה (ELF היתר)',         'radiation', true, true, 7),
  ('10165', 'בדיקת קרינה מרשת החשמל למתן היתר (ELF היתר)',                       'radiation', true, true, 8),
  ('10167', 'מדידת קרינה לפני ואחרי עבודות המיגון',                              'radiation', true, true, 9),
  ('10006', 'קרינה – ייעוץ ופיקוח עליון לאחר בנייה (ELF היתר)',                  'radiation', true, true, 10),
  -- SKIPPED: All radiation מיגון (shielding) rows (10166, 10041, 10082, 10081,
  --   10163, 10096, 10098, 10100, 10097, 10099, 10101, 10106, 10107, 10108,
  --   10109, 10110, 10111, 10093, 10094, 10144, 10152, 10153, 10154, 10116,
  --   10115, 10118, 10124, 10145, 10146, 10164, 10128, 10136, 10140, 10129,
  --   10130, 10131, 10133, 10134, 10135) — shielding products, isFieldInspection = false
-- ── בנייה ירוקה → green ───────────────────────────────────────────────────────
  -- SKIPPED: ('10148', ...) הכנת אוגדן מקדמי שלב א׳ — office work, isFieldInspection = false
  ('10149', 'בנייה ירוקה – הכנת אוגדן שלב ב׳ כולל ביקור בשטח והנחיות',           'green', true, true, 2)
  -- SKIPPED families (all rows isFieldInspection = false):
  --   thermal: 10156, 10157, 10158, 10150 — office thermal reports
  --   opinion: 10015 — office environmental opinion
  --   general: 10090, 10032, 10091, 10113, 82, 10117, 10092, 10142, 10143, 65, 10114 — logistics/admin
ON CONFLICT (code) DO NOTHING;

COMMIT;
