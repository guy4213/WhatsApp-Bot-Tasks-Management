You're right. Here's the full spec translated to English, nothing omitted, examples left as they are.

---

Everything's locked. Two streams under one bot: **field** (for the worker + Yoram sees it in reports) and **leads** (for Sasha). Here's the spec rewritten end to end, followed by the updated migration. All inline as usual.

First the locked decision log — this is the contract everything was written against:

- One bot, same number and same code; worker/manager/Sasha distinction by the ROLE that already exists.
- Hybrid interaction: menu + free text + voice messages. Clean output, almost no emojis.
- **Photos dropped entirely** — no upload, no completion gate, no `TaskPhotoMeta`. 3 field tables remain.
- "Finished" is unconditional. "Missing info for report" = a textual detail/form the office needs for the report → `WAITING_FOR_INFO` + alert.
- STARTED dropped — arrival = start of inspection. The flow: departed → arrived → finished.
- `InspectionType` = a dictionary keyed by מק"ט (`code` = `productName`) with `family`; `InspectionChecklist` = equipment only, by family.
- A Task becomes an inspection via a dropdown in the CRM that writes a flag field on `Task` → a `TaskField` row is created automatically.
- Leads: source = the `IncomingLead` table (not the CRM's `Lead`). Assignment field: `ownerId` (UUID FK). No phone column — display `fromName`/`fromEmail`/`subject`/`body`. The worker **does not touch the lead from the bot** — receives an alert only; all handling is done in the CRM. Sasha (MANAGER permission) performs the assignments. Yoram sees leads in the morning and evening summary.

═══════════════════════════════════════

# Spec — Galit bot (tightened version, no photos)

## 1. Core principles

1. **Additive-only** — zero changes to CRM tables, except for one approved exception: a single flag field on `Task` that marks "field task".
2. **The CRM is the owner of the real state** — not the `Task.status` of an inspection, and not the handling of a lead. The bot never changes them; it is a window and an alert voice.
3. **Separate operational status** — the field track lives in `TaskField.fieldStatus`. The worker marks that they finished in the field, doesn't "close" the inspection.
4. **One bot, role determines the display** — identification by phone → ROLE. A worker sees their inspections; Yoram sees exceptions + leads in reports; Sasha handles leads.
5. **Exceptions only for the manager** — professional problem, no access, missing equipment, waiting for info, whoever didn't close their day. Not "departed/arrived".

## 2. Identity and roles

Identification by phone against `User` → ROLE. No separate screen; the same entry and the display branches:
- **Field worker** — their inspections, status updates, assigned-lead alert.
- **Yoram (CEO)** — morning and evening summaries including field exceptions + leads. Views, doesn't handle leads.
- **Sasha** — MANAGER permission in the DB. Receives the leads digest and escalations, and performs assignments in the CRM.

## 3. The data model (3 field tables)

**InspectionType** — a dictionary of all inspection types by מק"ט. `code` = the מק"ט (9, 002, 66...), `family` = the inspection family. This is the table you assign to, and `productName` points at it.

**InspectionChecklist** — required equipment only, **per family**. A record for each equipment item a family needs. Defined once per family instead of per 150 מק"טים.

**TaskField** — 1:1 with `Task` (`taskId` unique). Static metadata (address, contact, navigation) + the live operational status + an inline note/problem + a "missing info" flag. **A Task is a field inspection if and only if it has a row here.**

Leads don't require a table on our side — reading from the existing `IncomingLead` table + alerts.

**How a Task becomes an inspection:**
1. In the office they choose the dropdown "field task = yes".
2. A flag field is written on `Task` → a `TaskField` row is created automatically.
3. `productName` (the מק"ט) → `InspectionType.code` → determines `inspectionTypeId` and `family`.
4. The Task's `ownerId` = the assigned worker → the bot sends them the inspection card.

## 4. The status model

Two separate layers:

| Layer | Owner | Who moves it |
|---|---|---|
| `Task.status` (CRM) — OPEN / IN_PROGRESS / DONE / CANCELED | The office | Office only |
| `TaskField.fieldStatus` (field) — 10 values | The bot | The worker (most transitions) |

**The 10 operational statuses:**
`ASSIGNED` · `CONFIRMED` · `DECLINED` · `NEEDS_MORE_INFO` · `EN_ROUTE` · `ARRIVED` · `FINISHED_FIELD` · `WAITING_FOR_INFO` · `HAS_PROBLEM` · `CANCELED`

- `ASSIGNED` — automatic on `TaskField` creation.
- `CONFIRMED` / `DECLINED` / `NEEDS_MORE_INFO` — the worker, in response to the assignment.
- `EN_ROUTE` ("departed") · `ARRIVED` ("arrived") — the worker. Arrival = start of inspection, no separate STARTED.
- `FINISHED_FIELD` ("finished") — the worker, **with no blocking condition**.
- `WAITING_FOR_INFO` — the worker via "missing info for report", or the office.
- `HAS_PROBLEM` — the worker via "report a problem".
- `CANCELED` — mirrors a cancellation in the office.

The "done" the worker sees is `Task.status = DONE` from the office — not a `fieldStatus` value. `FINISHED_FIELD` does not change `Task.status`.

## 5. Main menu (worker)

```
שלום דני, מה תרצה לעשות?

1. הבדיקות שלי להיום
2. הבדיקות שלי למחר
3. עדכון סטטוס בדיקה
4. דיווח על בעיה
5. חסר ציוד
6. חסר מידע לדוח
7. סיכום יום
```

Free text ("departed for Ra'anana") or a voice message is routed directly without going through the menu.

## 6. Inspection card

```
שובצה לך בדיקה חדשה.

סוג: בדיקת קרינה מרשת החשמל
לקוח: משה כהן
כתובת: אחוזה 100, רעננה
תאריך: 26.06.2026  שעה: 10:00
איש קשר: משה, 050-0000000

ציוד נדרש:
- מד ELF
- מד RF
- חצובה
- טופס שטח

ניווט: <קישור>

בחר:
1. מאשר
2. לא יכול להגיע
3. צריך פרטים נוספים
```

## 7. Daily work process

**Assignment** → card (section 6). 1 → `CONFIRMED` · 2 → `DECLINED` (asks for a short reason, alerts the office; reassignment is done in the office) · 3 → `NEEDS_MORE_INFO`.

**Morning reminder:**
```
בוקר טוב דני. היום יש לך 3 בדיקות:
1. 09:00 קרינה - רעננה
2. 12:00 רעש - הרצליה
3. 15:30 איכות אוויר - תל אביב

בחר מספר לעדכון סטטוס.
```

**Departed** → `EN_ROUTE` (+`departedAt`). **Arrived** → `ARRIVED` (+`arrivedAt`). **Finished** → `FINISHED_FIELD` (+`finishedAt`), unconditional, and then:
```
הבדיקה סומנה כבוצעה בשטח. יש הערות?
1. אין הערות
2. יש הערות מהשטח
3. יש בעיה
4. חסר מידע לדוח
```

## 8. Missing info for report

A situation where a detail the office needs in order to write the final report is missing — building permit number, sampling form, planner name, operating-hours approval, etc.:
```
מה חסר לדוח?
<טקסט חופשי / קולי>
```
Result: `fieldStatus = WAITING_FOR_INFO`, `missingReportInfo = true` + a note, and an alert to the office to chase the missing item. The inspection is done in the field but not "closed" until the office completes it.

## 9. Report a problem

```
איזו בעיה?
1. הלקוח לא עונה
2. אין גישה למקום
3. הלקוח לא נמצא
4. חסר ציוד
5. אי אפשר לבצע בדיקה
6. בעיה מקצועית
7. אחר
```
"Professional problem"/"Other" → asks for elaboration. Result: `fieldStatus = HAS_PROBLEM`, `problemType` + `problemNote`, `hasOpenProblem = true`, an alert to the manager:
```
בעיה מהשטח
עובד: דני · בדיקה: רעש · לקוח: משה כהן (הרצליה)
לא ניתן לבצע מדידה בגלל עבודות בנייה במקום.
לטיפול מנהל.
```
One problem per inspection is stored inline on `TaskField`. If multiple structured problems per inspection are needed in the future — bring back `TaskFieldEntry`.

## 10. Equipment reminder in the morning

Consolidates equipment from all of the day's inspections by the families' `InspectionChecklist`:
```
תזכורת ציוד להיום:
רעש: מד רעש, קליברטור, חצובה
קרינה: מד ELF, מד RF

1. לקחתי הכל
2. חסר לי ציוד
```
"Missing equipment" → free text → an alert to the manager.

## 11. Day summary for the worker

Computed in real time from the day's inspections' `fieldStatus`:
```
סיכום יום:
בוצעו: קרינה רעננה, רעש הרצליה, איכות אוויר ת"א
ממתינות למידע: 1

יש מה להשלים?
1. הכל בוצע
2. חסר מידע לדוח
3. צריך לחזור ללקוח
4. בעיה פתוחה
```

## 12. The leads stream (Sasha)

**Source:** the `IncomingLead` table (confirmed 2026-07-01). The bot reads from it only; all handling of a lead is done in the CRM. Columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`. No phone — display `fromName`/`fromEmail`/`subject`/`body`. Assignment field: `ownerId` (UUID FK to `User`; null = unassigned).

**Morning digest — 9:30, to Sasha:** all leads that came in overnight (17:00 yesterday → 9:30 today) where `ownerId IS NULL`:
```
לידים מהלילה (4):
1. רונן לוי · ronenlevi@example.com · "צריך בדיקת קרינה לדירה חדשה"
2. ...
שייכי ב-CRM. הצעת התאמה לכל ליד מצורפת.
```

**Assignment:** Sasha assigns a lead to a worker **in the CRM** — sets `ownerId` from null to a `User.id`. The bot detects the transition and sends the worker an alert (the worker does nothing in the bot — only views):
```
שויך אליך ליד חדש:
מאת: רונן לוי · ronenlevi@example.com
"צריך בדיקת קרינה לדירה חדשה"
לטיפול ועדכון ב-CRM.
```

**Escalation — a daytime lead that wasn't assigned:** a lead with `receivedAt` between 9:30 and 22:00 and `ownerId IS NULL` for more than **one hour** → one alert to Sasha (one event, not two):
```
ליד לא שויך כבר שעה:
רונן לוי · ronenlevi@example.com · "בדיקת קרינה..."
הצעת AI: דני (בודק קרינה)   [או: לא נמצאה התאמה לפי ROLE]
אנא שייכי ידנית ב-CRM.
```
The AI suggests a match based on the lead's description against the workers' ROLE (system prompt / DB) — **a suggestion only**, not an automatic assignment. Overnight leads are not counted toward this escalation; Yoram sees them in the morning and that's enough.

**Yoram:** sees leads in the morning and evening summary (count + list), read-only.

## 13. Alerts and summaries for the manager

Relies on the existing digest/notifications infrastructure in the managers' bot, which will also read the new field tables and `IncomingLead`.

**Yoram — summary (morning + evening), exceptions only:**
```
סיכום גלית
שטח: בוצעו 8 · לא אושרו 1 · עם בעיה 2 · ממתינות למידע 3 · לא סגרו יום 1
לידים: מהלילה 4 · לא שויכו 2

פתוחים:
1. דני - לקוח לא היה במקום
2. חיים - חסר טופס דגימה למעבדה
3. יוסי - חסר מספר היתר לדוח
```

**Sasha — the leads side:** the 9:30 digest + unassigned-lead escalations, as described in section 12.

## 14. MVP scope

**In:** automatic `TaskField` creation, card + confirmation, "my inspections", statuses (departed/arrived/finished), missing info for report, problem reporting, equipment reminder, day summary for the worker, exception alerts to Yoram, leads stream to Sasha (digest + assignment-by-alert + escalation + AI suggestion), voice messages.

**Out (for later):** photos, Outlook, `TaskFieldStatusHistory`, the structured `TaskFieldEntry`, `FieldWorkerDayClose`, performance analysis, automated reports, lead actions from within the bot.

═══════════════════════════════════════

# Updated migration — 3 tables, no photos

Changes from the previous version: `TaskPhotoMeta` dropped, `kind`/photos dropped from `InspectionChecklist` (equipment only), `STARTED`/`startedAt` dropped from `TaskField`.

```sql
-- Migration 009 (revised v2): Field-worker layer — 3 tables, additive only, no photos.
-- InspectionType (by מק"ט + family) · InspectionChecklist (equipment per family) · TaskField.
-- Conventions mirror 001–008: PascalCase quoted tables, camelCase cols, uuid PKs,
-- text FKs to CRM, text+CHECK (no PG enums), timestamptz default now(), RLS deny-all.

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

-- ── 2. InspectionChecklist — equipment only, PER FAMILY ───────────────────────
CREATE TABLE IF NOT EXISTS "InspectionChecklist" (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  family       text    NOT NULL CHECK (family IN (
                 'radiation','noise','air','asbestos','radon','odor',
                 'water','soil','occupational','thermal','green','opinion','general')),
  code         text    NOT NULL,                      -- machine code, e.g. noise_meter
  "labelHe"    text    NOT NULL,
  "isRequired" boolean NOT NULL DEFAULT true,
  "sortOrder"  integer NOT NULL DEFAULT 0,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, code)
);
CREATE INDEX IF NOT EXISTS idx_checklist_family ON "InspectionChecklist"(family);

-- ── 3. TaskField — 1:1 with Task. A Task is an inspection IFF a row exists here ─
CREATE TABLE IF NOT EXISTS "TaskField" (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId"                text        NOT NULL UNIQUE REFERENCES "Task"(id),
  "inspectionTypeId"      uuid        NOT NULL REFERENCES "InspectionType"(id),
  family                  text        NOT NULL,        -- snapshot for fast checklist lookups
  -- static metadata (written once at assignment)
  "siteAddress"           text,
  "siteCity"              text,
  "fieldContactName"      text,
  "fieldContactPhone"     text,
  "navigationUrl"         text,
  "specialInstructions"   text,
  -- live operational status (no STARTED)
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
  "problemType"           text CHECK ("problemType" IS NULL OR "problemType" IN (
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

-- ── RLS deny-all (bot uses service-role key, which bypasses RLS) ───────────────
ALTER TABLE "InspectionType"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InspectionChecklist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskField"           ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['InspectionType','InspectionChecklist','TaskField'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'deny_all_public') THEN
      EXECUTE format(
        'CREATE POLICY deny_all_public ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (false)', t);
    END IF;
  END LOOP;
END $$;

-- ── SEED: InspectionChecklist — equipment for the families we defined ──────────
INSERT INTO "InspectionChecklist" (family, kind_removed_use_family, code, "labelHe", "sortOrder") VALUES (NULL,NULL,NULL,NULL,NULL);  -- placeholder removed below
```

Typo in the seed line above — here's the clean seed (copy it in place of the last line):

```sql
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
```

**Both inputs resolved (2026-07-01):**

1. **The `InspectionType` dictionary (~150 מק"טים)** — proceed with the clear, field-relevant rows from the draft below. Shielding מק"טים and borderline non-inspection services are excluded from the initial seed; D1-T7 is now unblocked.

2. **The `IncomingLead` table** — resolved. Table: `IncomingLead`. Columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`. Assignment field: `ownerId` (UUID FK to `User`). No phone — use `fromName`/`fromEmail`/`subject`/`body`. `transferredToId` exists but is not used. All Domain 3 tasks are now unblocked.

---

# Regarding the SEED:
```sql
-- ════════════════════════════════════════════════════════════════════════════
-- Field-worker definitions layer — FINAL (locks InspectionType + checklist).
-- Run after migration 009 created the 3 tables. Idempotent; safe to re-run.
--
-- JOIN KEY: Task."productName" (numeric מק"ט) → "InspectionType".code.
-- Three legacy non-numeric slugs exist in Task data and must be normalized in
-- the TaskField-creation code BEFORE the lookup (no schema column for 3 rows):
--     odor_investigation         → 10013
--     odor_panel_assessment      → 10003
--     short_term_radon_certified → 10044
--
-- isFieldInspection = true  → real on-site measurement; CRM dropdown may create a TaskField.
-- isFieldInspection = false → shielding products / logistics / office reports; never a field task.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Add the gate column (additive; default true so existing rows are unaffected).
ALTER TABLE "InspectionType"
  ADD COLUMN IF NOT EXISTS "isFieldInspection" boolean NOT NULL DEFAULT true;

-- ── InspectionType dictionary — full catalog, family + field-inspection flag ──
INSERT INTO "InspectionType" (code, "labelHe", family, "isFieldInspection", "sortOrder") VALUES
-- ── איכות אוויר → air (all measurement) ───────────────────────────────────────
  ('66',    'אוויר – בדיקת איכות אוויר סביבתית',                                 'air', true, 1),
  ('72',    'אוויר – בדיקת איכות אוויר תוך מבני',                                'air', true, 2),
  ('10046', 'אוויר – בדיקת איכות אוויר מתחבורה',                                 'air', true, 3),
  ('10072', 'אוויר – ניטור פורמלדהיד',                                           'air', true, 4),
  ('69',    'אוויר – דיגום עובשים באוויר – בדיקה ראשונה',                        'air', true, 5),
  ('10066', 'אוויר – דיגום עובשים באוויר – דיגום נוסף באתר',                     'air', true, 6),
  ('10073', 'אוויר – דיגום חיידקים באוויר – דיגום נוסף באתר',                    'air', true, 7),
  ('10126', 'אוויר – דיגום משטח עובשים – דיגום נוסף באתר',                       'air', true, 8),
  ('10078', 'אוויר – בדיקת איכות אוויר סביבתית – יום נוסף',                      'air', true, 9),
  ('10047', 'אוויר – תוספת אמוניה',                                              'air', true, 10),
  ('10127', 'איכות אוויר – תחנה לניטור אוויר – מזהמים כימיים',                   'air', true, 11),
  ('10159', 'איכות אוויר – תחנה לניטור אוויר – חודש נוסף – מזהמים כימיים',       'air', true, 12),
-- ── אסבסט → asbestos (all measurement) ────────────────────────────────────────
  ('10023', 'אסבסט – ביצוע סקר אסבסט ע"י בודק מוסמך',                            'asbestos', true, 1),
  ('10026', 'אסבסט – זיהוי צובר אסבסט',                                          'asbestos', true, 2),
  ('10112', 'אסבסט – ניטור סיבי אסבסט באוויר – 2 דגימות',                        'asbestos', true, 3),
-- ── ראדון → radon (kits/detectors = field; calibration/cert = office) ─────────
  ('10044', 'ראדון – בדיקת גז ראדון קצרת טווח ע״י בודק מוסמך',                   'radon', true,  1),
  ('10017', 'ראדון – בדיקת גז ראדון ארוכת טווח ע״י בודק מוסמך',                  'radon', true,  2),
  ('61',    'ראדון – ערכה – בדיקת ראדון קצרת טווח',                              'radon', true,  3),
  ('10000', 'ראדון – ערכה לבדיקת גז ראדון ארוכת טווח',                           'radon', true,  4),
  ('87',    'ראדון – פרט ראדון',                                                 'radon', true,  5),
  ('10022', 'ראדון – RD200 גלאי ראדון רציף',                                     'radon', true,  6),
  ('10095', 'ראדון – RD200P Radon Eye +2 גלאי ראדון רציף',                       'radon', true,  7),
  ('10160', 'ראדון – RADELEC כולל לידר',                                         'radon', true,  8),
  ('10161', 'ראדון – גלאי אלקטרוני ארוך טווח חדש',                              'radon', true,  9),
  ('10162', 'ראדון – גלאי אלקטרוני קצר טווח חדש',                               'radon', true,  10),
  ('70',    'ראדון – כיול גלאי ראדון לחידוש היתר לבודק ראדון',                   'radon', false, 11),  -- כיול מעבדה
  ('10069', 'ראדון – RD200 הנפקת תעודת כיול למכשיר',                             'radon', false, 12),  -- הנפקת תעודה
-- ── ריח → odor (all measurement; note the 3 legacy slugs map here / to radon) ─
  ('10013', 'ריח – איתור וסילוק מטרד ריח',                                       'odor', true, 1),
  ('10003', 'ריח – בדיקת ריח ע״י צוות מריחים',                                   'odor', true, 2),
  ('10083', 'ריח – בדיקת ריח ע״י בודק ריח מוסמך',                                'odor', true, 3),
  ('10055', 'ריח – דוח סביבתי ריח – הערכת פיזור ריחות להגשה לרשויות',            'odor', false, 4),  -- דוח להגשה
-- ── מים → water (all measurement) ─────────────────────────────────────────────
  ('63',    'מים – בדיקה מיקרוביאלית מלאה, דיגום ראשון באתר',                    'water', true, 1),
  ('10076', 'מים – בדיקת מתכות חלקית, דיגום ראשון באתר',                         'water', true, 2),
  ('10120', 'מים – בדיקה מיקרוביאלית מלאה + בדיקת מתכות חלקית',                  'water', true, 3),
  ('10121', 'מים – בדיקת מתכות מלאה',                                            'water', true, 4),
  ('10122', 'מים – בדיקת מתכות ומיקרוביאלית מלאה',                               'water', true, 5),
  ('10075', 'מים – בדיקה מיקרוביאלית מלאה, דיגום נוסף באתר',                     'water', true, 6),
  ('10077', 'מים – בדיקת מתכות חלקית, דיגום נוסף באתר',                          'water', true, 7),
-- ── קרקע → soil (sampling = field; survey/plan prep = office) ─────────────────
  ('10027', 'קרקע – הכנת סקר קרקע היסטורי',                                      'soil', false, 1),  -- סקר משרדי
  ('10050', 'קרקע – הכנת תוכנית דיגום לקרקע',                                    'soil', false, 2),  -- תכנון משרדי
  ('10087', 'קרקע – בדיקת רעידות ממכונות דחיקת צינור',                           'soil', true,  3),
  ('10102', 'קרקע – דיגום לקרקע ע״פ סעיף מס׳ 1',                                 'soil', true,  4),
  ('10103', 'קרקע – דיגום גז קרקע ע״פ סעיף מס׳ 1',                              'soil', true,  5),
  ('10088', 'קרקע – דיגום נוסף באתר חיידקים בחול תחת ריצוף',                     'soil', true,  6),
  ('10089', 'קרקע – פעימות וספיקת משאבות חיידקים בדגימת חול',                    'soil', true,  7),
-- ── גהות / רעש תעסוקתי → occupational (measurement = field; survey/form = office) ─
  ('62',    'גהות – בדיקת רעש תעסוקתית',                                         'occupational', true,  1),
  ('98',    'גהות – רעש תעסוקתי – הכנת סקר מקדים',                               'occupational', false, 2),  -- סקר מקדים
  ('10084', 'גהות – הכנת סקר מקדים חומרים כימיים ורעש',                          'occupational', false, 3),  -- סקר מקדים
  ('10104', 'גהות – יום עבודה ניטור סביבתי תעסוקתי',                             'occupational', true,  4),
  ('10105', 'גהות – טופס מידע התקשרות עם הלקוח',                                 'occupational', false, 5),  -- טופס
  ('10137', 'תסקיר סביבתי – להיתר בנייה',                                        'occupational', false, 6),  -- תסקיר משרדי
-- ── רעש → noise (measurement = field; consulting/forecast = office) ───────────
  ('73',    'רעש – בדיקת רעש סביבתית עפ״י סעיף 1',                               'noise', true,  1),
  ('10011', 'רעש – בדיקת רעש סביבתית רציפה עד 24 שעות',                          'noise', true,  2),
  ('10048', 'רעש – בדיקת רעש רציפה יום נוסף',                                    'noise', true,  3),
  ('10012', 'רעש – בדיקת רעש מתחבורה',                                           'noise', true,  4),
  ('10028', 'רעש – בדיקת רעש במשתחמים',                                          'noise', true,  5),
  ('10043', 'רעש – בדיקת רעש מציוד בנייה, השתל״ס 1979-1',                        'noise', true,  6),
  ('10085', 'רעש – בדיקת רעש מטוסים',                                            'noise', true,  7),
  ('10060', 'רעש – בדיקה אקוסטית לחדר קול נישא באוויר וקול הולם',                'noise', true,  8),
  ('10061', 'רעש – חדר נוסף קול נישא באוויר וקול הולם',                          'noise', true,  9),
  ('10058', 'רעש – בדיקה אקוסטית לחדר קול הולם',                                 'noise', true,  10),
  ('10059', 'רעש – בדיקה אקוסטית לחדר קול הולם חדר נוסף',                        'noise', true,  11),
  ('10070', 'רעש – בדיקה אקוסטית לחדר קול נישא באוויר',                          'noise', true,  12),
  ('10071', 'רעש – בדיקה אקוסטית לחדר קול נישא באוויר חדר נוסף',                 'noise', true,  13),
  ('10062', 'רעש – בדיקת רעש במסגרת ייעוץ אקוסטי למבנה בבנייה',                  'noise', true,  14),
  ('10042', 'רעש – סקר אקוסטי להפחתת מפלסי הרעידות',                             'noise', true,  15),
  ('10056', 'רעש – בדיקת רעש ממעלית',                                            'noise', true,  16),
  ('10123', 'רעש – בדיקת מעלית נוספת',                                           'noise', true,  17),
  ('10037', 'רעש – ייעוץ אקוסטי להפחתת רעש',                                     'noise', false, 18),  -- ייעוץ משרדי
  ('10086', 'רעש אקוסטיקה – בדיקת רעידות',                                       'noise', true,  19),
  ('10079', 'רעש אקוסטיקה – מתן היתר לבריכה פרטית',                              'noise', true,  20),
  ('10125', 'רעש – הספק אקוסטי לאולם / פאב',                                     'noise', true,  21),
  ('10139', 'בדיקה אקוסטית – רעש מערכות',                                        'noise', true,  22),
  ('10119', 'רעש – ביצוע חיזוי רעש לכביש חדש',                                   'noise', false, 23),  -- חיזוי משרדי
-- ── קרינה → radiation : בדיקות מדידה בשטח ─────────────────────────────────────
  ('9',     'קרינה – בדיקת קרינה אלקטרומגנטית מרשת החשמל',                       'radiation', true, 1),
  ('56',    'קרינה – בדיקת קרינה משולבת מדוח רשת החשמל',                         'radiation', true, 2),
  ('83',    'קרינה – בדיקת קרינה רציפה מרשת החשמל',                              'radiation', true, 3),
  ('10064', 'קרינה – בדיקת קרינה מרכב היברידי / חשמלי',                          'radiation', true, 4),
  ('002',   'RF – קרינה – בדיקת קרינה אלקטרומגנטית ממתקני שידור ואנטנות סלולריות', 'radiation', true, 5),
  ('10034', 'קרינה – בדיקת איפוס ואיזון הארקות אלקטרומגנטית',                    'radiation', true, 6),
  ('10036', 'קרינה – בדיקת קרינה רקע RF + ELF בתחילת הבנייה (ELF היתר)',         'radiation', true, 7),
  ('10165', 'בדיקת קרינה מרשת החשמל למתן היתר (ELF היתר)',                       'radiation', true, 8),
  ('10167', 'מדידת קרינה לפני ואחרי עבודות המיגון',                              'radiation', true, 9),
  ('10006', 'קרינה – ייעוץ ופיקוח עליון לאחר בנייה (ELF היתר)',                  'radiation', true, 10),
-- ── קרינה → radiation : מיגון / מוצרים / דוחות (NOT field inspections) ─────────
  ('10166', 'המלצות למיגון קרינה',                                              'radiation', false, 20),
  ('10041', 'קרינה – הכנת מפרט למיגון קרינה לדוח חזוי (ELF היתר)',              'radiation', false, 21),
  ('10082', 'קרינה – הכנת דו״ח מעשי איכ״ס – לאחר הקמת אתר (RF היתר)',          'radiation', false, 22),
  ('10081', 'קרינה – הכנת דו״ח תיאורטי איכ״ס – לפני הקמת אתר (RF היתר)',        'radiation', false, 23),
  ('10163', 'קרינה – דוח יישום מיגון להגשה לרשויות ובנייה ירוקה',               'radiation', false, 24),
  ('10096', 'קרינה – מיגון קרינה לקירות',                                        'radiation', false, 25),
  ('10098', 'קרינה – מיגון קרינה לתקרה',                                         'radiation', false, 26),
  ('10100', 'קרינה – מיגון קרינה ברצפה',                                         'radiation', false, 27),
  ('10097', 'קרינה – חיפוי גבס כולל שפכטל וצבע',                                'radiation', false, 28),
  ('10099', 'קרינה – מיגון חזית לוח חשמל',                                       'radiation', false, 29),
  ('10101', 'קרינה – חיפוי פרקט למינציה 8 מ״מ',                                 'radiation', false, 30),
  ('10106', 'קרינה – דלתות הזזה ממוגנות קרינה',                                  'radiation', false, 31),
  ('10107', 'קרינה – מיגון נישה ללוח חשמל',                                      'radiation', false, 32),
  ('10108', 'קרינה – מיגון קירות פח קווי הזנה',                                  'radiation', false, 33),
  ('10109', 'קרינה – מיגון תעלת כבלים מחוררת',                                   'radiation', false, 34),
  ('10110', 'חדירת MUMETAL 450×450 בקיר – מיגון קרינה',                          'radiation', false, 35),
  ('10111', 'קרינה – מיגון ריכוז מונים',                                         'radiation', false, 36),
  ('10093', 'קרינה – פלדת שנאים למיגון קרינה, עובי 0.35',                        'radiation', false, 37),
  ('10094', 'קרינה – אלומיניום למיגון קרינה, עובי 1.5 מ״מ כולל בידוד פנימי 0.2 מ״מ', 'radiation', false, 38),
  ('10144', 'מיגון קרינה – פלדת סיליקון, עובי 0.5, צפיפות גבוהה',                'radiation', false, 39),
  ('10152', 'מ״מ סיליקון – סוג 1',                                               'radiation', false, 40),
  ('10153', 'מ״מ סיליקון – סוג 2',                                               'radiation', false, 41),
  ('10154', 'מ״מ אלומיניום דל פחמן – סוג 3',                                     'radiation', false, 42),
  ('10116', 'קרינה – מיגון דלתות פלדת שנאים 10×10×0.35',                         'radiation', false, 43),
  ('10115', 'קרינה – מיגון דלת שנאים 1.5×10×10',                                 'radiation', false, 44),
  ('10118', 'קרינה – מיגון דלתות מחוררות אלקטרומגנטית',                          'radiation', false, 45),
  ('10124', 'קרינה מיגון – פחת וחפיפות 10%',                                     'radiation', false, 46),
  ('10145', 'מיגון פר פס צבירה',                                                 'radiation', false, 47),
  ('10146', 'מיגון קרינה – התקנת תעלת חשמל ממוגנת קרינה',                        'radiation', false, 48),
  ('10164', 'מיגון קרינה לתעלת חשמל בצורת ח׳ המותקנת בתקרה',                     'radiation', false, 49),
  ('10128', 'לצורך בידוד בין האלומיניום לסיליקון PVC',                           'radiation', false, 50),
  ('10136', 'קרינה – התקנת ארון חשמל ממוגן קרינה',                              'radiation', false, 51),
  ('10140', 'קרינה – הובלה והתקנת מיגון לקירות מסוג A100',                       'radiation', false, 52),
  ('10129', 'מיגון רנטגן – חיפוי קירות בלוחות עופרת עובי 0.5 מ״מ',               'radiation', false, 53),
  ('10130', 'מיגון רנטגן – חיפוי קירות בלוחות עופרת עובי 1 מ״מ',                 'radiation', false, 54),
  ('10131', 'מיגון רנטגן – חיפוי קירות בלוחות עופרת עובי 1.5 מ״מ',               'radiation', false, 55),
  ('10133', 'מיגון רנטגן – חיפוי קירות בלוחות עופרת עובי 2 מ״מ',                 'radiation', false, 56),
  ('10134', 'מיגון רנטגן – חיפוי קירות בלוחות עופרת עובי 2.5 מ״מ',               'radiation', false, 57),
  ('10135', 'מיגון רנטגן – חיפוי קירות בלוחות עופרת עובי 3 מ״מ',                 'radiation', false, 58),
-- ── בנייה ירוקה → green (office) ───────────────────────────────────────────────
  ('10148', 'בנייה ירוקה – הכנת אוגדן מקדמי שלב א׳ לאישור מכון ההתעדה',          'green', false, 1),
  ('10149', 'בנייה ירוקה – הכנת אוגדן שלב ב׳ כולל ביקור בשטח והנחיות',           'green', true,  2),  -- כולל ביקור בשטח
-- ── תרמי → thermal (office reports) ───────────────────────────────────────────
  ('10156', 'תרמי – דוח התאמה לתקן 1045',                                        'thermal', false, 1),
  ('10157', 'תרמי – דוח התאמה לתקן 5282',                                        'thermal', false, 2),
  ('10158', 'תרמי – בדיקת דוח במעבדה מוסמכת',                                    'thermal', false, 3),
  ('10150', 'ייעוץ תרמי והנחיות לבנייה ירוקה בהתאם לת״י 1045 ודוח אנרגטי 5282',  'thermal', false, 4),
-- ── חוות דעת סביבתית → opinion (office) ────────────────────────────────────────
  ('10015', 'הכנת חוות דעת סביבתית',                                             'opinion', false, 1),
-- ── כללי → general (logistics / admin — never field) ──────────────────────────
  ('10090', 'כללי – דיון / ישיבות עם רשויות / אדריכלים / רגולטורים',             'general', false, 1),
  ('10032', 'כללי – מתן עדות בבית משפט',                                         'general', false, 2),
  ('10091', 'כללי – שינויים בתוכנית לאחר ביצוע',                                 'general', false, 3),
  ('10113', 'קבלת תוצאות בנוהל דחוף',                                            'general', false, 4),
  ('82',    'כללי – הוצאות הגעה',                                                'general', false, 5),
  ('10117', 'הובלה',                                                            'general', false, 6),
  ('10092', 'כללי – משלוח דלת לדלת דרך חברת שליחויות',                          'general', false, 7),
  ('10142', 'משלוח עד הדלת',                                                     'general', false, 8),
  ('10143', 'משלוח חזרה למעבדה',                                                 'general', false, 9),
  ('65',    'כללי – מקדמה להזמנת שירות',                                         'general', false, 10),
  ('10114', 'שונות',                                                            'general', false, 11)
ON CONFLICT (code) DO UPDATE
  SET "labelHe"           = EXCLUDED."labelHe",
      family              = EXCLUDED.family,
      "isFieldInspection" = EXCLUDED."isFieldInspection",
      "sortOrder"         = EXCLUDED."sortOrder",
      "updatedAt"         = now();

-- ── InspectionChecklist — equipment per family (field families only) ──────────
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
```