# Task: Enhanced Due-Date Reminder for CRM Tasks

## Summary (one line)

Enrich the 1-hour due-date reminder for CRM Tasks (`src/scheduler/jobs/dueDateReminder.ts`) with a full detail card + a "🔍 פרטים נוספים" quick-reply button that opens an extended detail message. Applies **only** to CRM Tasks (`Task` rows); **do not touch** `preInspectionReminder` (field-inspection reminders are out of scope).

## Why

The current reminder body is minimal:
```
תזכורת: המשימה "{{1}}" מגיעה למועדה היום בשעה {{2}}. אנא היערך בהתאם.
```
The manager/owner doesn't get enough context to act (who's the customer, what phone to call, what to prepare). CEO explicitly asked to include contact + description so the owner can act directly from WhatsApp without opening the CRM.

---

## Current state — read this first

- **Scheduler:** `runDueDateReminder` in `src/scheduler/jobs/dueDateReminder.ts` runs every 5 min. Finds `Task` rows with `dueDate` between `now()+55min` and `now()+65min`, sends via `notify()` with template key `DUE_REMINDER`, params `[title, time]`. Dedup via `WhatsappReminderLog` kind=`DUE_1H` (row inserted only after a successful send).
- **Template `due_reminder`** at Meta is APPROVED with 2 body vars (title, time). **Do not edit the template** — it stays as the out-of-window fallback.
- **`notify()`** in `src/whatsapp/templates.ts` already supports optional `buttons` — when the freeform path is taken (in-window recipient), buttons are used; when the template path is taken (out-of-window), buttons are ignored. This is exactly what we need.
- **`setActiveTask` / `getActiveTask`** exist in `src/services/taskContext.ts` and are already used by the router.
- **`getTaskById`** in `src/services/tasks.ts` returns Task + Customer/Lead/Project subsets — a good starting point but does NOT include `Customer.contactName`, `Customer.phone2`, `Customer.notes`, `Customer.address`, or `Task.processNotes` which we need.

---

## Product requirements (verbatim from product owner)

### Reminder body (regular tasks)
```
🔔 תזכורת משימה

כותרת: {taskTitle}
לקוח: {customerName}
טלפון לקוח: {customerPhone}
איש קשר: {contactName}
טלפון איש קשר: {contactPhone}
תאריך/שעה: {dueDate}
אחראי: {assignedTo}

תיאור קצר:
{description}

הערות:
{notes / processNotes}
```

### Quick-reply button
```
🔍 פרטים נוספים
```

### Extended details (after button tap OR text "פרטים" / "פרטים נוספים")
```
🔍 פרטי המשימה

כותרת: {taskTitle}
לקוח: {customerName}
טלפון לקוח: {customerPhone}
איש קשר: {contactName}
טלפון איש קשר: {contactPhone}
כתובת/עיר: {address / city}
אחראי: {assignedTo}
סטטוס: {status}
תאריך יעד: {dueDate}

תיאור מלא:
{description}

הערות פנימיות / הערות תהליך:
{processNotes}

קישור ל-CRM:
{crmTaskUrl}   ← OPTIONAL — see "Phase 2" below
```

### Rules
- Empty field → render `—` (em-dash).
- Text triggers `"פרטים"` and `"פרטים נוספים"` must behave identically to the button tap.
- Only applies to CRM Tasks. **Do not touch** `preInspectionReminder`.
- Use `taskId` as the context/target — there is no `taskFieldId` for a regular CRM Task.
- After sending the reminder, call `setActiveTask(phone, taskId, title)` so text triggers work seamlessly.
- Reminder body should be sent as freeform + quick-reply button when possible (in-window path in `notify()`). When the recipient is out-of-window, `notify()` falls back to the approved `due_reminder` template automatically — accept that fallback as-is, the button won't appear then. Do not try to embed the button in the template (that would require Meta re-approval).

---

## Field mapping (source of truth)

Use these joins in the DB query. All lookups already have precedent in `src/services/preInspectionReminder.ts` (6-source COALESCE for customer name) and `src/services/tasks.ts` (`getTaskById`).

| UI Field         | Source                                                                                              | Fallback |
| ---------------- | --------------------------------------------------------------------------------------------------- | -------- |
| `taskTitle`      | `Task.title`                                                                                        | required — never null in practice |
| `customerName`   | `COALESCE(Customer.name, Lead.fullName, TRIM(CONCAT_WS(' ', Lead.firstName, Lead.lastName)), Lead.company, Project.client, IncomingLead.fromName)` | `—`      |
| `customerPhone`  | `COALESCE(Customer.phone, Lead.phone, IncomingLead.fromPhone)`                                       | `—`      |
| `contactName`    | `Customer.contactName`                                                                              | `—`      |
| `contactPhone`   | `COALESCE(NULLIF(TRIM(Customer.phone2), ''), Customer.phone)` — see **Assumption A** below           | `—`      |
| `dueDate`        | `Task.dueDate` — format as Asia/Jerusalem `DD/MM בשעה HH:MM` via `formatShortDateTimeIL` (already exists in `src/ai/inspectionFormatters.ts`) | required |
| `assignedTo`     | `User.name` where `User.id = Task.ownerId`                                                          | `—`      |
| `description`    | `Task.description`                                                                                  | `—`      |
| `notes`          | `Task.processNotes` (rendered as "הערות" in the short reminder)                                     | `—`      |
| `address`        | `Customer.address`                                                                                  | `—`      |
| `city`           | `Customer.city`                                                                                     | `—`      |
| `status`         | `Task.status` — translate: `OPEN → פתוחה`, `IN_PROGRESS → בטיפול`, `DONE → הושלמה`, `BLOCKED → חסום`, else raw | `—` |

### Assumption A — contactPhone
Product spec says "טלפון איש קשר" (contact phone) distinct from "טלפון לקוח" (customer phone). The `Customer` table has `phone`, `phone2`, `phone3`. Best guess: `phone` = primary customer/company number, `phone2` = contact person's direct line. **Implement as:** `COALESCE(NULLIF(TRIM(Customer.phone2), ''), Customer.phone)`. If the product owner clarifies later that a different column is used (e.g., a dedicated `contactPhone` field somewhere), swap the column reference in one place (the query).

---

## Implementation plan

### New files

#### 1. `src/services/taskDetailFormatter.ts` (NEW — pure, no DB / no network)

Exports two pure formatters. No imports beyond types + `formatShortDateTimeIL`.

```ts
export interface TaskDetailForReminder {
  taskId: string;
  taskTitle: string;
  customerName: string | null;
  customerPhone: string | null;
  contactName: string | null;
  contactPhone: string | null;
  dueDate: Date;
  assignedTo: string | null;
  description: string | null;
  processNotes: string | null;
  address: string | null;
  city: string | null;
  status: string; // Task.status raw value
}

/** Short body sent as the reminder + fallback for the template freeform. */
export function formatTaskReminderBody(d: TaskDetailForReminder): string { ... }

/** Extended detail message sent when the button is tapped or the user
 *  types "פרטים" / "פרטים נוספים". */
export function formatTaskDetailsExtended(d: TaskDetailForReminder, crmUrl?: string | null): string { ... }
```

Use `—` for null/empty. Translate `Task.status` via a small map inside this file. Keep it dependency-free so it's trivially unit-testable.

#### 2. `src/__tests__/taskDetailFormatter.test.ts` (NEW)

Vitest, pure unit tests. Cover:
- All fields present → both formatters render the expected multi-line strings.
- Every optional field null → shows `—` for that line.
- `crmUrl` null → the extended message does NOT include the CRM link line.
- `Task.status` translation for each supported value + fallback to raw.

### Files to edit

#### 3. `src/services/tasks.ts`

Add:
```ts
export async function getTaskDetailsForReminder(taskId: string): Promise<TaskDetailForReminder | null>
```

Runs one query joining `Task + User (owner) + Customer + Lead + Project + IncomingLead` and returns the shape above. Field mapping per the table. Follow the style of the existing SQL in `preInspectionReminder.ts` (multi-line, quoted PascalCase identifiers, COALESCE expression).

#### 4. `src/scheduler/jobs/dueDateReminder.ts`

Change the flow:
1. Load candidates (same window: `dueDate` in `[+55min, +65min]`, `status != 'DONE'`, owner active with phone). Keep the `WhatsappReminderLog` dedup as-is — do not create a new kind.
2. For each candidate: fetch `getTaskDetailsForReminder(taskId)`.
3. Build the reminder body via `formatTaskReminderBody(details)`.
4. Call `notify()` with:
   - `key: 'DUE_REMINDER'` (unchanged — template stays as out-of-window fallback)
   - `bodyParams: [title, dueTime]` (unchanged for template compatibility)
   - `fallbackText: <the enhanced body from step 3>`
   - `buttons: [{ id: taskDetailsPayloadId(taskId), title: '🔍 פרטים נוספים' }]`
5. **On successful send only:** insert the dedup row (existing behavior) AND call `setActiveTask(row.owner_phone, taskId, title)` so text triggers work.
6. Failure: identical to today — do not stamp, retry next tick.

Add a payload-id helper next to it:
```ts
export function taskDetailsPayloadId(taskId: string): string {
  return `TASK_DETAILS_${taskId}`;
}
export function matchTaskDetailsPayload(raw: string): { taskId: string } | null {
  const m = raw.trim().match(/^TASK_DETAILS_([0-9a-zA-Z_-]{6,})$/);
  return m ? { taskId: m[1] } : null;
}
```

`Task.id` is `text` in the schema, not a UUID — do NOT hard-code a UUID regex. The `[0-9a-zA-Z_-]{6,}` regex is intentionally permissive.

#### 5. `src/ai/router.ts`

Add two dispatch paths near the pre-reminder tap detection (search for `matchPreReminderTap` in `router.ts` — put the new one in the same block, right before or after).

```ts
// (a) Button tap payload — always route to the details handler.
const taskDetailsTap = matchTaskDetailsPayload(text);
if (taskDetailsTap) {
  await handleTaskDetailsRequest(user, taskDetailsTap.taskId);
  return;
}

// (b) Text triggers "פרטים" / "פרטים נוספים" — only when there is an
//     active task in context (set by dueDateReminder after a send).
const trimmedNav = text.trim();
if (/^(?:🔍\s*)?פרטים(?:\s+נוספים)?$/u.test(trimmedNav)) {
  const active = getActiveTask(user.phone);
  if (active?.taskId) {
    await handleTaskDetailsRequest(user, active.taskId);
    return;
  }
  // No active task in context — fall through so the general router / AI
  // handles it. Do NOT block the user with an error.
}
```

Add the handler:
```ts
async function handleTaskDetailsRequest(user: ResolvedUser, taskId: string): Promise<void> {
  const details = await getTaskDetailsForReminder(taskId);
  if (!details) {
    await sendTextMessage({ to: user.phone, text: 'לא הצלחתי למצוא את פרטי המשימה. נסה שוב או פנה למנהל.' });
    return;
  }
  const crmUrl = buildCrmTaskUrl(taskId); // returns null if CRM_TASK_URL_TEMPLATE unset — Phase 2
  const body = formatTaskDetailsExtended(details, crmUrl);
  await sendTextMessage({ to: user.phone, text: body });
}
```

Add `buildCrmTaskUrl` — Phase 2 optional; put it in a small helper file or inline. If the env var `CRM_TASK_URL_TEMPLATE` is unset OR does not contain `{taskId}`, return null so the extended message simply omits the CRM link. This is scaffolding — the CEO has not provided the URL structure yet.

```ts
function buildCrmTaskUrl(taskId: string): string | null {
  const template = process.env.CRM_TASK_URL_TEMPLATE;
  if (!template || !template.includes('{taskId}')) return null;
  return template.replace('{taskId}', encodeURIComponent(taskId));
}
```

#### 6. `.env.example`

Add near the other feature-flag block:
```
# Optional: URL template for the CRM task view. When set, the "🔍 פרטים נוספים"
# extended message includes a link to the task in the CRM. Must include the
# literal placeholder `{taskId}` — the code substitutes it at send time.
# Example: https://crm.galit.co.il/tasks/{taskId}
CRM_TASK_URL_TEMPLATE=
```

### Tests to add

#### 7. `src/__tests__/dueDateReminder.test.ts`
If the file already exists — extend it. Otherwise create it.
- Given a Task with a due date in the window, the reminder body is the output of `formatTaskReminderBody(details)`.
- `notify()` is called with a `buttons: [{ id: TASK_DETAILS_<taskId>, title: '🔍 פרטים נוספים' }]`.
- After a successful `notify()`, `setActiveTask(phone, taskId, title)` is called.
- On `notify()` throw, dedup is NOT inserted (existing behavior — assert it stays).

#### 8. `src/__tests__/routerTaskDetailsButton.test.ts` (NEW)
- Payload `TASK_DETAILS_<taskId>` → `getTaskDetailsForReminder` called, `sendTextMessage` called with `formatTaskDetailsExtended` output.
- Text `"פרטים"` with an active task in context → same as above.
- Text `"פרטים נוספים"` → same.
- Text `"פרטים"` with NO active task → **must not throw, must not send** (falls through to general router).
- `getTaskDetailsForReminder` returns null → user gets the "לא הצלחתי למצוא" message; no crash.

Use the same mocking pattern as `src/__tests__/detailViewAIContext.test.ts` (`vi.hoisted` factories + `vi.mock`).

---

## Verification checklist

Before marking done, run and confirm all pass:

```powershell
npx tsc --noEmit
npx vitest run src/__tests__/taskDetailFormatter.test.ts
npx vitest run src/__tests__/routerTaskDetailsButton.test.ts
npx vitest run src/__tests__/dueDateReminder.test.ts
npx vitest run                    # full suite — no regressions
```

Also:
- `git diff` shows changes only in the files listed above (nothing surprising).
- No writes to `Task.status` anywhere (CLAUDE.md core constraint).
- Reminder body contains all 9 short-body fields; extended message contains all extended fields.
- The button title is exactly `🔍 פרטים נוספים` (with the emoji).

---

## Constraints from CLAUDE.md — do not break these

- **Do NOT write to `Task.status`.** Reading is fine; writing is forbidden anywhere in this task.
- **Do NOT touch `preInspectionReminder`.** Field-inspection reminders are out of scope. The regex `matchTaskDetailsPayload` must not collide with `matchPreReminderTap` — `PREREMIND_*` is a different prefix, and the `TASK_DETAILS_*` regex is exact-match, so this is already safe. Do not merge or share handlers between them.
- **Do NOT edit or re-submit any Meta template.** The approved `due_reminder` template stays as-is (out-of-window fallback). All enhancements live in the freeform path via `notify()`'s `fallbackText` + `buttons`.
- **Fire-and-forget etiquette:** the `setActiveTask` call must not block or fail the reminder send. Wrap it in a try/catch that just logs on failure.
- **No new WhatsApp templates** — this task adds zero Meta dependencies.
- **`TASKS.md` update:** when done, add an entry summarizing the change (status, files changed, tests run, commit sha). Follow the existing conventions in that file.

---

## Phase 2 (optional, not blocking this task)

Add `CRM_TASK_URL_TEMPLATE` to Render env once product provides the CRM URL structure. Zero code change needed — `buildCrmTaskUrl` already reads the env var and returns null (i.e., no CRM line) when unset.

---

## Model recommendation for the implementing agent

**Sonnet** — spec is precise, change is isolated to one scheduler job + one formatter + one router path, low architectural risk. If the implementing agent hits unclear behavior in the router's active-task context flow, escalate to Opus.

---

## Open questions / decisions the implementing agent may need to make

1. **`contactPhone` source column** — see Assumption A. Implement `COALESCE(phone2, phone)` as the default. If evidence emerges during implementation that a different column is the intended contact phone, change the query in one place and note the decision in the PR / TASKS.md entry.
2. **Text-trigger regex** — the spec allows `"פרטים"` and `"פרטים נוספים"`. Also accept the leading `🔍` emoji if the user copies it back. The provided regex `/^(?:🔍\s*)?פרטים(?:\s+נוספים)?$/u` covers this.
3. **What if the user has multiple recent reminders and types "פרטים"?** — `setActiveTask` overwrites, so only the most recent task's details are shown. This matches the product's implied UX (act on the reminder you just got). Do not build a picker.
