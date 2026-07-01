# HANDOFF — M11 + M12: Schedule TaskField + Sasha lead assignment (design)

**Status:** APPROVED SCOPE via 2026-07-01 SPEC Addendum. No code changes yet.
Design documents for two new milestones after M8+M9 shipped:
- **M11 (D2-T11):** schedule a `TaskField` from WhatsApp against an existing `Task`
- **M12 (D3-T6):** Sasha (or leads viewers) can assign a lead to a worker from WhatsApp

Both extensions are documented and blessed in `SPEC_FIELD_V2.md` Addendum.

**Owner (next implementer):** TBD.
**Created:** 2026-07-01.
**Blocked by:** none (M8+M9 shipped; schema is stable; migrations 009+010 applied).

---

## 1. Goal

Allow a WhatsApp user to schedule a new field visit (a `TaskField` row) **for
a `Task` that already exists in the CRM**. The bot never creates the `Task` or
the customer — those remain the CRM's job (K2 + spec §1).

Concretely: mirror what the CRM's scheduling form does today, but from
WhatsApp.

### Why the scope is only TaskField (not Task)

Per SPEC_FIELD_V2 §1 core principle 2:

> "The CRM is the owner of the real state... The bot never changes them; it is
> a window and an alert voice."

Creating a `Task` from the bot would violate that principle. Creating a
`TaskField` for an EXISTING `Task` is a smaller extension: the `Task` (and
therefore the customer, address, product, ownerId) are already in the CRM —
the bot only writes the scheduled visit slot.

---

## 2. Authorization model

| Role | Can schedule TaskField for a Task where they are `Task.ownerId`? | Can schedule for any Task? |
|---|---|---|
| WORKER / TECHNICIAN | ✅ | ❌ |
| MANAGER | ✅ | ✅ |
| ADMIN | ✅ | ✅ |

Enforcement: server-side. If a WORKER supplies a `taskId` whose `Task.ownerId`
is not their own user id → reject with "אין הרשאה למשימה הזאת".

---

## 3. UX flow — happy path

### 3a. Picking the Task

**Primary path — list the user's own recent open tasks:**

```
👤 "לתזמן ביקור"        ← trigger keyword OR menu item

🤖 "המשימות הפתוחות שלך:
    1. משפחת כהן — בדיקת קרינה מרשת החשמל (רעננה)
    2. חברת ABC בע״מ — בדיקת רעש (הרצליה)
    3. מרפאת דוד — בדיקת איכות אוויר (תל אביב)

    בחר מספר, או כתוב 'חיפוש' לחיפוש לפי לקוח."

👤 "1"
```

**Fallback path — search by customer name:**

```
👤 "חיפוש"

🤖 "שם הלקוח או חלק ממנו?"

👤 "כהן"

🤖 "מצאתי:
    1. משפחת כהן דוד — 3 משימות פתוחות
    2. חברת כהן ובניו — 1 משימה פתוחה
    3. מרפאת כהן — 0 משימות פתוחות
    בחר לקוח."

👤 "1"

🤖 "משימות פתוחות של משפחת כהן דוד:
    1. בדיקת קרינה מרשת החשמל
    2. בדיקת RF
    3. בדיקת רעש
    בחר משימה."

👤 "1"
```

### 3b. Scheduling details

Once a Task is picked, the bot pre-fills every static field from the Task row
and asks ONLY for the visit-specific data:

```
🤖 "מתי? (תאריך + שעה, אפשר קולית)"

👤 [voice or text] "ראשון בעשר בבוקר"

🤖 "משך? (ברירת מחדל: 60 דק'. שלח מספר בדקות או 'אישור')"

👤 "אישור"    ← or a number to override
```

### 3c. Final confirmation

```
🤖 "לאישור:
    לקוח: משפחת כהן (מהמשימה)
    בדיקה: בדיקת קרינה מרשת החשמל (מק״ט 10156)
    כתובת: אחוזה 100, רעננה (מהמשימה)
    איש קשר: משה, 050-XXXXXXX (מהמשימה)
    מתי: א׳ 05/07 בשעה 10:00
    משך: 60 דקות
    טכנאי: אתה (מ-Task.ownerId)

    1️⃣ אישור  2️⃣ ביטול"

👤 "1"

🤖 "התיזמון נקלט ✓
    TaskField ID: 4a2f...
    הטכנאי יקבל כרטיס משימה תוך כמה דקות."
```

### Missing scheduled time

If the user supplied a message with the Task pick but no time, the bot asks
for time explicitly. Same for a missing/invalid duration — silently defaults
to 60.

### Cancellation

At ANY point in the flow, user types "ביטול" / "cancel" / "לא" → context
cleared, no writes, bot replies "בוטל.".

---

## 4. AI intent + extraction

### New intent

Add `schedule_task_field` to `AI_INTENTS` in `src/ai/schema.ts`.

### Trigger phrases

- "לתזמן ביקור"
- "לתזמן בדיקה"
- "לקבוע ביקור חדש"
- "לקבוע בדיקה חדשה"
- "לפתוח תיזמון"
- "בדיקה נוספת"

### Extraction — only two fields are user-supplied

```typescript
{
  scheduledStartAt: string | null,   // ISO 8601; user provides date+time
  durationMinutes: number | null,    // default 60 if not stated
  specialInstructions: string | null // optional
}
```

Everything else (`customerId`, `siteAddress`, `siteCity`, `fieldContactName`,
`fieldContactPhone`, `navigationUrl`, `inspectionTypeId`, `family`) is
**copied from the picked `Task` row and its related `Customer` row.**

### Hebrew date/time parsing

Same requirement as any Hebrew scheduling: "ראשון בעשר בבוקר", "מחר ב-14:00",
"05/07 בעשר", "בעוד שעתיים". The AI receives the current local time as
context.

---

## 5. Router state machine

Add awaiting kinds to `conversationContext.ts`:

- `schedule_intake_pick_task` — waiting for a Task pick (number 1..N)
- `schedule_search_customer` — waiting for a customer name query
- `schedule_pick_from_search` — waiting for a pick after search
- `schedule_await_time` — waiting for date/time
- `schedule_await_duration` — waiting for duration or "אישור"
- `schedule_confirm` — waiting for 1 (confirm) / 2 (cancel)

Context payload throughout the flow carries the resolved `taskId` and
`ownerId` so nothing has to be re-queried at commit time.

Cancellation from any state clears the context.

---

## 6. Data lookups

### Which Tasks to show in the "your open tasks" list

Query needed in a new `src/services/tasks.ts` helper (or extension of an
existing one):

```sql
SELECT
  t.id, t."productName", t.title,
  c.id AS "customerId", c.name AS "customerName",
  it."labelHe" AS "inspectionLabelHe", it.family AS "inspectionFamily",
  it.id AS "inspectionTypeId"
FROM "Task" t
LEFT JOIN "Customer" c ON c.id = t."customerId"
LEFT JOIN "InspectionType" it ON it.code = t."productName"
WHERE t."ownerId" = $1                    -- caller's user id
  AND t.status NOT IN ('DONE', 'CANCELED') -- open tasks only
ORDER BY t."updatedAt" DESC
LIMIT 10
```

For ADMIN/MANAGER browsing a different user's tasks: the `WHERE t."ownerId"`
filter is relaxed to the specified owner.

### Search by customer name (fallback path)

```sql
SELECT c.id, c.name, COUNT(t.id) FILTER (
  WHERE t.status NOT IN ('DONE','CANCELED')
) AS open_task_count
FROM "Customer" c
LEFT JOIN "Task" t ON t."customerId" = c.id
WHERE c.name ILIKE '%' || $1 || '%'
GROUP BY c.id, c.name
ORDER BY open_task_count DESC, c.name ASC
LIMIT 10
```

### Column verification needed

Before implementation, verify column names against the CRM:
- `Task.customerId`, `Task.ownerId`, `Task.productName`, `Task.title`,
  `Task.status`, `Task.updatedAt`
- `Customer.id`, `Customer.name`, `Customer.address`, `Customer.city`,
  `Customer.contactName`, `Customer.contactPhone`, `Customer.navigationUrl`
  (or whatever field carries the site info — the CRM may store this on Task
  or on Customer)

**Action item:** get a sample row from `Task` and `Customer` before writing
the query.

---

## 7. Insert

Once the user confirms, the bot INSERTs one row into `TaskField`. No writes to
`Task`, no writes to `Customer`.

```sql
INSERT INTO "TaskField" (
  id,
  "taskId",
  "inspectionTypeId",
  family,
  "appointmentTitle",
  "scheduledStartAt",
  "scheduledEndAt",
  "durationMinutes",
  "siteAddress",
  "siteCity",
  "fieldContactName",
  "fieldContactPhone",
  "navigationUrl",
  "specialInstructions",
  "assignedAt",
  "fieldStatus",
  "updatedByUserId",
  "createdAt",
  "updatedAt"
) VALUES (
  gen_random_uuid(),
  $1,   -- taskId (from picked Task)
  $2,   -- inspectionTypeId (looked up from Task.productName → InspectionType.code)
  $3,   -- family (from InspectionType.family)
  $4,   -- appointmentTitle (e.g. Task.title or a synthesized "בדיקה נוספת ל-<customer>")
  $5,   -- scheduledStartAt (user input)
  $5 + ($6 || ' minutes')::interval,  -- scheduledEndAt = start + duration
  $6,   -- durationMinutes
  $7,   -- siteAddress (from Task/Customer)
  $8,   -- siteCity
  $9,   -- fieldContactName
  $10,  -- fieldContactPhone
  $11,  -- navigationUrl
  $12,  -- specialInstructions (user input, may be null)
  now(),
  'ASSIGNED',
  $13,  -- updatedByUserId (caller)
  now(),
  now()
);
-- workerNotifiedAt: NULL → the D5-T6 poller picks it up and sends the §6 card.
```

Failure → clear error, no partial state, user starts over.

---

## 8. What triggers the assignment card

The existing D5-T6 poller (`assignmentCardNotifier`) already handles this end
of the flow:

- Runs every 2 minutes
- Finds `TaskField` rows where `workerNotifiedAt IS NULL`
- Sends the §6 assignment card (D2-T2)
- Stamps `workerNotifiedAt`

So a WhatsApp-created TaskField and a CRM-created TaskField behave
identically after commit. No new plumbing needed for the card.

---

## 9. Validation

| Check | Failure response |
|---|---|
| Picked `taskId` exists in `Task` | Reject; re-open the list |
| Caller's role permits scheduling for this Task's owner (see §2) | Reject "אין הרשאה למשימה הזאת" |
| `Task.productName` maps to a row in `InspectionType` | Reject "סוג הבדיקה של המשימה לא בקטלוג — פנה לאדמין" |
| `scheduledStartAt` is in the future | Reject "לא ניתן לתזמן בעבר" |
| `durationMinutes > 0` (or null → default 60) | Coerce to default |
| Task's status is not DONE / CANCELED | Reject "המשימה סגורה — אין טעם לתזמן" |

---

## 10. Test plan

**Unit:**
- `parseIntent` recognizes `schedule_task_field` trigger phrases
- Extraction schema against 5-10 Hebrew fixtures
- Hebrew date parser handles common phrases
- Auth check: worker cannot pick another user's Task
- Task-lookup query returns only open tasks

**Integration:**
- Full happy-path flow from trigger to TaskField insert
- Search-by-customer fallback path
- Cancellation from each state clears context
- After insert, D5-T6 poller sends the assignment card within 2 min
- Invalid pick (out of range) re-prompts
- Task with `productName` not in `InspectionType` → clear rejection

**Regression:**
- No existing flow (menu, morning digest, status update) breaks

---

## 11. Rollout

- No new env vars
- No new dependencies
- No new migrations
- Feature flag `SCHEDULE_TASKFIELD_ENABLED` gates the trigger phrases in the
  router — flip after smoke test in prod.

---

## 12. Deferred / out of scope for M11

- **Creating a new `Task`** — that stays in the CRM per §1 and K2.
- **Creating a new `Customer`** — CRM.
- **Assigning to a different worker at scheduling time** — for now the
  scheduled TaskField inherits `Task.ownerId` as the assigned inspector. If
  ADMIN wants to override, do it in the CRM.
- **Editing an existing TaskField** — rescheduling, changing time, adding
  notes to an already-created scheduling row. Not in M11.
- **Recurring visits** — no cron support.
- **Photo attachments** — deferred per §14.

---

## 13. Estimated effort

- AI schema + prompt tuning: 0.5 day
- Task-lookup queries (Task / Customer joins): 0.5 day
- Router state machine + handlers: 1-2 days
- INSERT + validation + audit log: 0.5 day
- Tests (unit + integration): 1-2 days
- Product review + edge cases: 0.5 day

**Total:** ~4-5 days for a single implementer.

Notably smaller than the "create Task + TaskField" flow because:
- No customer creation UI
- No AI-based Task field extraction (we reuse Task fields verbatim)
- No worry about `Task.status` default behavior
- Fewer validation rules

---

## 14. Open questions for the next implementer

1. **Column layout of `Task`** — confirm where the site metadata lives.
   Options: (a) always on `Customer`; (b) always on `Task`; (c) split. This
   affects the SQL in §6.
2. **Confirm `Task.status` values used by the CRM** — the "not DONE not
   CANCELED" check needs the exact strings.
3. **Should the `TaskField.appointmentTitle` be user-editable, or synthesized
   from Task fields?** Default proposal: synthesize (`בדיקה חוזרת ל-<customer>`).
4. **What happens if the picked Task already has an open TaskField** (an
   unfinished scheduled visit)? Options: (a) allow anyway — multiple field
   visits per Task per K2; (b) warn and confirm; (c) block. Recommendation:
   (a) — matches K2's "one Task can have multiple TaskField rows."
5. **Should ADMIN/MANAGER be able to schedule to a Task they don't own?**
   Recommendation: yes, per the auth table in §2. But confirm.

---

*This handoff replaces the retired V1 HANDOFF.md. For prior context on why the
old bot was rewritten, see `GAP_ANALYSIS.md` and `SPEC_FIELD_V2.md`.*
