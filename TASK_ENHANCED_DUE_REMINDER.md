# Task: Enhanced Due-Date Reminder for CRM Tasks

## Summary (one line)

Enrich the 1-hour due-date reminder for CRM Tasks (`src/scheduler/jobs/dueDateReminder.ts`) with a full detail body + a "פרטים נוספים" quick-reply button that opens an extended detail message, **and** a new Meta template `due_reminder_v2` that renders the exact same content out-of-window. Applies **only** to CRM Tasks (`Task` rows); **do not touch** `preInspectionReminder` (field-inspection reminders are out of scope).

## Why

The current reminder body is minimal:
```
תזכורת: המשימה "{{1}}" מגיעה למועדה היום בשעה {{2}}. אנא היערך בהתאם.
```
The manager/owner doesn't get enough context to act (who's the customer, what phone to call, what to prepare). CEO explicitly asked to include contact + description + CRM link so the owner can act directly from WhatsApp.

## Coverage requirement — 100 %

The recipient may or may not have messaged the bot in the last 24 h (managers/workers do interact frequently but not every day; weekends, mornings, first-week employees are all realistic gaps). We cannot rely on the 24-h WhatsApp customer-service window. Therefore this task delivers **two rendering paths that produce byte-identical body text**:

| Path | When | Uses |
| --- | --- | --- |
| **Freeform** | Recipient IS in the 24-h window | `sendButtonMessage` with rich body + quick-reply button. No template involvement. |
| **Template** | Recipient is OUT of the 24-h window | Approved Meta template `due_reminder_v2`, 10 body vars + quick-reply button component. Renders identical text. |

The pure formatter `formatTaskReminderBody(details, crmUrl)` is the single source of truth. The same string is placed in `notify()`'s `fallbackText` (freeform path) and is exactly what Meta renders from the template (template path), because both paths take their values from the same `TaskDetailForReminder` object.

The existing approved template `due_reminder` (2 vars, no button) is retained as a safety fallback: if `due_reminder_v2` is not APPROVED yet at Meta, the env override `WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder` keeps things safe. Once v2 is APPROVED, flip to `WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2`.

---

## Current state — read this first

- **Scheduler:** `runDueDateReminder` in `src/scheduler/jobs/dueDateReminder.ts` runs every 5 min. Finds `Task` rows with `dueDate` between `now()+55min` and `now()+65min`, sends via `notify()` with template key `DUE_REMINDER`, params `[title, time]`. Dedup via `WhatsappReminderLog` kind=`DUE_1H` (row inserted only after a successful send).
- **Template `due_reminder`** at Meta is APPROVED with 2 body vars (title, time). **Do not edit it.** It stays as the emergency fallback.
- **`notify()`** in `src/whatsapp/templates.ts` already supports optional `buttons` for the freeform path — when `sendTextMessage`/`sendButtonMessage` is picked, buttons are used; when the template path is picked, buttons are ignored. **We need to extend the template path to support quick-reply button payloads too.**
- **`sendTemplateMessage`** in `src/whatsapp/sender.ts` currently only accepts `bodyParams`. **You will extend it** to also accept `buttonParams` and emit the correct `components: [..., { type: 'button', sub_type: 'quick_reply', index, parameters }]` shape per Meta's Graph API spec.
- **`setActiveTask` / `getActiveTask`** exist in `src/services/taskContext.ts` and are already used by the router.
- **`getTaskById`** in `src/services/tasks.ts` returns Task + Customer/Lead/Project subsets — a starting point but missing `Customer.contactName`, `Customer.phone2`, `Customer.notes`, `Customer.address`, `Task.processNotes`.

---

## Product requirements (verbatim from product owner)

### Reminder body (regular tasks) — sent identically in both freeform and template paths
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

📋 לפתיחת המשימה ב-CRM:
{crmTaskUrl}
```

### Quick-reply button
```
פרטים נוספים
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

📋 לפתיחת המשימה ב-CRM:
{crmTaskUrl}
```

### Rules
- Empty field → render `—` (em-dash). Applies to every field including `crmTaskUrl`.
- Text triggers `"פרטים"` and `"פרטים נוספים"` must behave identically to the button tap.
- Only applies to CRM Tasks. **Do not touch** `preInspectionReminder`.
- Use `taskId` as the context/target — there is no `taskFieldId` for a regular CRM Task.
- After sending the reminder, call `setActiveTask(phone, taskId, title)` so text triggers work seamlessly.
- **CRM link stays in the message body, not as a URL button.** A future Phase-2 change may add a "פתח ב-CRM" URL button; do not add it now.

---

## Meta template `due_reminder_v2` — spec to submit

### Category
`UTILITY`, language `he`.

### Body (10 vars)
```
🔔 תזכורת משימה

כותרת: {{1}}
לקוח: {{2}}
טלפון לקוח: {{3}}
איש קשר: {{4}}
טלפון איש קשר: {{5}}
תאריך/שעה: {{6}}
אחראי: {{7}}

תיאור קצר:
{{8}}

הערות:
{{9}}

📋 לפתיחת המשימה ב-CRM:
{{10}}
```

### Buttons component
Add ONE quick-reply button with static text `פרטים נוספים`. Payload is dynamic per send (set at send time to `TASK_DETAILS_<taskId>`).

### Meta rules the payload must satisfy
- Body must not start or end with a variable. Ours starts with the `🔔 תזכורת משימה` heading and ends with `{{10}}` — **that fails the "no trailing variable" rule.** Fix: make the CRM section end with the URL followed by a trailing static line, e.g.:
  ```
  📋 לפתיחת המשימה ב-CRM:
  {{10}}
  
  יום עבודה טוב.
  ```
  Or place a static single word after `{{10}}` on the same line. The submission script must run the existing validator (see `scripts/create-digest-templates-v2.ts`) which rejects bodies that effectively end with a variable.
- No adjacent variables (we're fine — each `{{n}}` has real text between).
- No empty variables. `crmTaskUrl` must be a non-empty string at send time. When `CRM_TASK_URL_TEMPLATE` env is unset, pass `—` (em-dash) instead of an empty string so Meta doesn't reject the send.
- Body length limit ≈ 1024 chars total (post-substitution). **`description` and `processNotes` MUST be truncated to a safe length** (see below) so the assembled body never exceeds ~900 chars in practice.

### Truncation
Truncate `description` and `processNotes` to at most **200 UTF-8 chars each**, appending `…` when cut. This keeps the body well under Meta's limit even with long values. Implement the truncation inside the formatter so both paths use the truncated version.

### Approval risk
UTILITY reminders with contact fields are the standard Meta-friendly case; risk of automatic rejection is low. If Meta escalates to human review, expect a few hours to 24 h. The old `due_reminder` template remains active throughout — no service interruption.

---

## Field mapping (source of truth)

Use these joins in the DB query. All lookups have precedent in `src/services/preInspectionReminder.ts` (6-source COALESCE for customer name) and `src/services/tasks.ts` (`getTaskById`).

| UI Field         | Source                                                                                              | Fallback |
| ---------------- | --------------------------------------------------------------------------------------------------- | -------- |
| `taskTitle`      | `Task.title`                                                                                        | required — never null in practice |
| `customerName`   | `COALESCE(Customer.name, Lead.fullName, TRIM(CONCAT_WS(' ', Lead.firstName, Lead.lastName)), Lead.company, Project.client, IncomingLead.fromName)` | `—`      |
| `customerPhone`  | `COALESCE(Customer.phone, Lead.phone, IncomingLead.fromPhone)`                                       | `—`      |
| `contactName`    | `Customer.contactName`                                                                              | `—`      |
| `contactPhone`   | `COALESCE(NULLIF(TRIM(Customer.phone2), ''), Customer.phone)` — see **Assumption A** below           | `—`      |
| `dueDate`        | `Task.dueDate` — format Asia/Jerusalem `DD/MM בשעה HH:MM` via `formatShortDateTimeIL` (`src/ai/inspectionFormatters.ts`) | required |
| `assignedTo`     | `User.name` where `User.id = Task.ownerId`                                                          | `—`      |
| `description`    | `Task.description`, truncated to 200 chars + `…`                                                    | `—`      |
| `notes`          | `Task.processNotes`, truncated to 200 chars + `…`                                                   | `—`      |
| `address`        | `Customer.address` (extended message only)                                                          | `—`      |
| `city`           | `Customer.city` (extended message only)                                                             | `—`      |
| `status`         | `Task.status` — translate: `OPEN → פתוחה`, `IN_PROGRESS → בטיפול`, `DONE → הושלמה`, `BLOCKED → חסום`, else raw | `—` |
| `crmTaskUrl`     | Built from `CRM_TASK_URL_TEMPLATE` env var, substituting `{taskId}`. If unset or lacks the placeholder → `—`. | `—` |

### Assumption A — contactPhone
Product spec distinguishes "טלפון איש קשר" from "טלפון לקוח". The `Customer` table has `phone`, `phone2`, `phone3`. Best guess: `phone` is the primary company/customer number, `phone2` is the contact person's direct line. **Implement as:** `COALESCE(NULLIF(TRIM(Customer.phone2), ''), Customer.phone)`. If evidence emerges during implementation that a different column is intended, swap in one place and note in the PR + `TASKS.md`.

---

## Implementation plan

### New files

#### 1. `src/services/taskDetailFormatter.ts` (NEW — pure, no DB / no network)

Exports the two pure formatters. No imports beyond types + `formatShortDateTimeIL`.

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
  description: string | null;    // pre-truncation value; formatter truncates
  processNotes: string | null;   // pre-truncation value; formatter truncates
  address: string | null;
  city: string | null;
  status: string;                // Task.status raw value
}

/** Short body sent as the reminder (identical text used for both freeform
 *  fallbackText and the template body-param values). */
export function formatTaskReminderBody(d: TaskDetailForReminder, crmUrl: string | null): string { ... }

/**
 * Returns the 10 body params in the order the `due_reminder_v2` template
 * expects them. Substituting these into the template body yields exactly
 * `formatTaskReminderBody(d, crmUrl)`. THIS MUST BE MECHANICALLY DERIVED FROM
 * THE SAME VALUES — do not build the two independently or they will drift.
 */
export function reminderTemplateParams(d: TaskDetailForReminder, crmUrl: string | null): string[] { ... }

/** Extended detail message sent when the button is tapped or the user
 *  types "פרטים" / "פרטים נוספים". */
export function formatTaskDetailsExtended(d: TaskDetailForReminder, crmUrl: string | null): string { ... }

/** Truncate a string to N UTF-8 chars, appending "…" when cut. Exported for testability. */
export function truncateForTemplate(s: string | null, max: number): string { ... }
```

Use `—` for null/empty **including** when `crmUrl` is null. Translate `Task.status` via a small map inside this file.

**Consistency invariant:** the strings returned by `reminderTemplateParams(...)`, when substituted into the `due_reminder_v2` template body in order, must produce the exact string returned by `formatTaskReminderBody(...)`. Add a test that asserts this equality by textually substituting `{{1}}..{{10}}` in the known template body.

#### 2. `src/__tests__/taskDetailFormatter.test.ts` (NEW)

Vitest, pure unit tests. Cover:
- All fields present → both formatters render the expected multi-line strings.
- Every optional field null → shows `—` for that line.
- `crmUrl` null → both the reminder body and the extended message show `—` under the CRM header.
- `description` / `processNotes` longer than 200 chars → truncated with `…`.
- `Task.status` translation for each supported value + fallback to raw.
- **`reminderTemplateParams` produces params that, when substituted into the frozen template-body string, equal `formatTaskReminderBody`.**

#### 3. `scripts/create-due-reminder-v2-template.ts` (NEW)

Submit the `due_reminder_v2` template to Meta. Mirror the style of `scripts/create-digest-templates-v2.ts`:
- Reads `META_WABA_ID`, `WHATSAPP_ACCESS_TOKEN`, `META_GRAPH_VERSION` from env.
- Runs the validator (no leading/trailing variable, adjacent-variable check, placeholder-count check).
- POSTs `/{version}/{waba_id}/message_templates` with body components + buttons component.
- Prints template id + status.
- Supports `--dry-run` for previewing the payload.

The frozen body string used by the validator MUST match the string that `reminderTemplateParams` mechanically substitutes into (see the consistency invariant above). Consider exporting the raw template body from `taskDetailFormatter.ts` so both the script and the tests reference it.

#### 4. `src/__tests__/senderTemplateButtons.test.ts` (NEW)

Vitest. Cover the `sendTemplateMessage` extension:
- `buttonParams` unset → outgoing payload has `components: [{ type: 'body', ... }]` only. (Regression guard for the 14 existing approved templates.)
- `buttonParams: [{ subType: 'quick_reply', index: 0, payload: 'TASK_DETAILS_abc' }]` → outgoing payload includes `{ type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'TASK_DETAILS_abc' }] }`.
- Multiple buttons at correct indices.

Mock `https.request` to capture the JSON body (same pattern as existing `sender` tests).

#### 5. `src/__tests__/routerTaskDetailsButton.test.ts` (NEW)

- Payload `TASK_DETAILS_<taskId>` → `getTaskDetailsForReminder` called, `sendTextMessage` called with `formatTaskDetailsExtended` output.
- Text `"פרטים"` with an active task in context → same handler.
- Text `"פרטים נוספים"` → same.
- Text `"פרטים"` with NO active task → **must not throw, must not send** (falls through to the general router).
- `getTaskDetailsForReminder` returns null → user gets the "לא הצלחתי למצוא" message; no crash.

Use the same mocking pattern as `src/__tests__/detailViewAIContext.test.ts` (`vi.hoisted` factories + `vi.mock`).

### Files to edit

#### 6. `src/whatsapp/sender.ts`

Extend `TemplateMessage` + `sendTemplateMessage` to support button component params:

```ts
export interface TemplateButtonParam {
  subType: 'quick_reply' | 'url';
  index: number;
  payload: string;                 // for quick_reply → the dynamic payload id;
                                   // for url         → the URL suffix (only if template's URL button has a variable)
}

export interface TemplateMessage {
  to: string;
  name: string;
  languageCode: string;
  bodyParams?: string[];
  buttonParams?: TemplateButtonParam[];   // NEW
}
```

Build `components` as:
- Always: `{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: t })) }` when `bodyParams.length > 0`.
- For each `b` in `buttonParams`: append `{ type: 'button', sub_type: b.subType, index: b.index, parameters: [{ type: b.subType === 'quick_reply' ? 'payload' : 'text', ... }] }`.

Do NOT change the shape when `buttonParams` is empty/undefined — that would risk regressing the 14 existing templates.

#### 7. `src/whatsapp/templates.ts`

`notify()` accepts a new optional field:
```ts
export interface NotifyArgs {
  to: string;
  key: NotificationKey;
  bodyParams: string[];
  fallbackText: string;
  buttons?: Array<{ id: string; title: string }>;
  templateButtonParams?: TemplateButtonParam[];   // NEW — used only when template path is taken
}
```

Template path: passes `templateButtonParams` through to `sendTemplateMessage`. Freeform path: ignores `templateButtonParams`, uses `buttons` as today.

#### 8. `src/services/tasks.ts`

Add:
```ts
export async function getTaskDetailsForReminder(taskId: string): Promise<TaskDetailForReminder | null>
```

One query joining `Task + User (owner) + Customer + Lead + Project + IncomingLead`, mapped per the table above. Follow the style of the existing SQL in `preInspectionReminder.ts` (multi-line, quoted PascalCase identifiers, COALESCE expressions).

#### 9. `src/scheduler/jobs/dueDateReminder.ts`

Change the flow:
1. Query the same window (`dueDate` in `[+55min, +65min]`, `status != 'DONE'`, owner active with phone). Keep the `WhatsappReminderLog` dedup as-is — do not create a new kind.
2. For each candidate: fetch `getTaskDetailsForReminder(taskId)`. If null (task deleted / access changed), skip and log.
3. Build `crmUrl` via the `buildCrmTaskUrl` helper (see below).
4. Build the reminder body via `formatTaskReminderBody(details, crmUrl)`.
5. Build `bodyParams` via `reminderTemplateParams(details, crmUrl)`.
6. Call `notify()` with:
   - `key: 'DUE_REMINDER'` (unchanged — env override switches the actual template name)
   - `bodyParams` from step 5
   - `fallbackText` from step 4
   - `buttons: [{ id: taskDetailsPayloadId(taskId), title: 'פרטים נוספים' }]`
   - `templateButtonParams: [{ subType: 'quick_reply', index: 0, payload: taskDetailsPayloadId(taskId) }]`
7. **On successful send only:** insert the dedup row (existing behavior) AND call `setActiveTask(row.owner_phone, taskId, title)` inside try/catch (a `setActiveTask` failure must not block the flow or duplicate the reminder).
8. Failure: identical to today — do not stamp, retry next tick.

Add the payload-id helpers next to it:
```ts
export function taskDetailsPayloadId(taskId: string): string {
  return `TASK_DETAILS_${taskId}`;
}
export function matchTaskDetailsPayload(raw: string): { taskId: string } | null {
  const m = raw.trim().match(/^TASK_DETAILS_([0-9a-zA-Z_-]{6,})$/);
  return m ? { taskId: m[1] } : null;
}
```

`Task.id` is `text` in the schema, not a UUID — do NOT hard-code a UUID regex.

Add `buildCrmTaskUrl` (small helper, put it in `taskDetailFormatter.ts` for reuse):
```ts
export function buildCrmTaskUrl(taskId: string): string | null {
  const template = process.env.CRM_TASK_URL_TEMPLATE;
  if (!template || !template.includes('{taskId}')) return null;
  return template.replace('{taskId}', encodeURIComponent(taskId));
}
```

#### 10. `src/ai/router.ts`

Add two dispatch paths near `matchPreReminderTap`:

```ts
// (a) Button tap payload — always route to the details handler.
const taskDetailsTap = matchTaskDetailsPayload(text);
if (taskDetailsTap) {
  await handleTaskDetailsRequest(user, taskDetailsTap.taskId);
  return;
}

// (b) Text triggers — only when there is an active task in context.
const trimmedNav = text.trim();
if (/^פרטים(?:\s+נוספים)?$/u.test(trimmedNav)) {
  const active = getActiveTask(user.phone);
  if (active?.taskId) {
    await handleTaskDetailsRequest(user, active.taskId);
    return;
  }
  // No active task — fall through so the general router / AI handles it.
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
  const crmUrl = buildCrmTaskUrl(taskId);
  const body = formatTaskDetailsExtended(details, crmUrl);
  await sendTextMessage({ to: user.phone, text: body });
}
```

#### 11. `.env.example`

Add near the other feature-flag block:
```
# Optional: URL template for the CRM task view. When set, the due-date
# reminder body and the "פרטים נוספים" extended message include a link to
# the task in the CRM. Must include the literal placeholder `{taskId}` — the
# code substitutes it at send time. When unset, both messages render "—" in
# the CRM section (the template variable is filled with "—" so Meta accepts
# the send).
# Example: https://crm.galit.co.il/tasks/{taskId}
CRM_TASK_URL_TEMPLATE=
```

Also note (comment only) that once `due_reminder_v2` is APPROVED at Meta:
```
# After due_reminder_v2 is APPROVED at Meta, override the template name:
# WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2
# Keep unset (or =due_reminder) while v2 is PENDING to fall back safely.
```

### Tests to add / extend

- `src/__tests__/taskDetailFormatter.test.ts` — new (see file 2 above).
- `src/__tests__/senderTemplateButtons.test.ts` — new (see file 4 above).
- `src/__tests__/routerTaskDetailsButton.test.ts` — new (see file 5 above).
- `src/__tests__/dueDateReminder.test.ts` — new or extended. Cover:
  - Reminder body is `formatTaskReminderBody(details, crmUrl)`.
  - `notify()` receives `buttons` and `templateButtonParams` with the correct payload.
  - `setActiveTask` called after successful send.
  - `notify()` throw → dedup NOT inserted (existing behavior).
  - `getTaskDetailsForReminder` returns null → row is skipped, dedup NOT inserted, no crash.

---

## Verification checklist

Before marking done, run and confirm all pass:

```powershell
npx tsc --noEmit
npx vitest run src/__tests__/taskDetailFormatter.test.ts
npx vitest run src/__tests__/senderTemplateButtons.test.ts
npx vitest run src/__tests__/routerTaskDetailsButton.test.ts
npx vitest run src/__tests__/dueDateReminder.test.ts
npx vitest run                    # full suite — no regressions
git status
git diff --stat                   # confirm files match the spec's list
```

Then, template submission (should be run once, not as part of routine testing):
```powershell
npx tsx scripts/create-due-reminder-v2-template.ts --dry-run   # preview
npx tsx scripts/create-due-reminder-v2-template.ts             # LIVE — submits to Meta
npx tsx scripts/list-whatsapp-templates.ts                     # confirm PENDING → APPROVED
```

Confirm manually:
- The reminder body contains all 10 short-body fields from the spec (including the CRM section).
- The extended message contains all extended fields.
- Empty fields render as `—`.
- The button title is exactly `פרטים נוספים` (no emoji in the button title — Meta caps button length at 20 chars, keep it plain).
- Text triggers `"פרטים"` and `"פרטים נוספים"` route to the same handler as the button tap.
- No writes to `Task.status` anywhere.
- Zero changes in `src/services/preInspectionReminder.ts` or its tests.

---

## Constraints from CLAUDE.md — do not break these

- **Do NOT write to `Task.status`.** Reading is fine; writing is forbidden anywhere in this task.
- **Do NOT touch `preInspectionReminder`.** The regex `matchTaskDetailsPayload` must not collide with `matchPreReminderTap` — `PREREMIND_*` is a different prefix, and the `TASK_DETAILS_*` regex is exact-match, so this is already safe. Do not merge or share handlers between them.
- **Do NOT edit the existing approved `due_reminder` template.** It stays as the safe fallback. Any Meta interaction is via the NEW template `due_reminder_v2`.
- **Fire-and-forget etiquette:** `setActiveTask` must not block or fail the reminder send. Wrap in try/catch that just logs.
- **Do NOT enable `WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2` in any committed env file** until the template is APPROVED at Meta. Document it in `.env.example` as a comment only.
- **`TASKS.md` update:** when done, add an entry summarizing this task (status, files changed, tests run, commit sha). Follow existing conventions in that file.

---

## Phase 2 (out of scope; document only)

Optional future work — do NOT do this now:
- Replace the CRM section in the body with a "פתח ב-CRM" URL button in the template (Meta URL buttons open the link in the customer's browser). This would require re-approval of the template and slightly complicates the button-payload extension (URL buttons take a `type: 'text'` variable instead of `type: 'payload'`).
- Add a second "פתח ב-CRM" URL button alongside the "פרטים נוספים" quick-reply. Meta templates allow up to 3 buttons total, so this is possible.

---

## Model recommendation for the implementing agent

**Sonnet** — spec is precise, change is well-scoped, low architectural risk. If the implementing agent hits genuinely unclear behavior in the `sendTemplateMessage` extension or the template-body/formatter consistency check, escalate to Opus.

---

## Open questions / assumptions the implementing agent may need to defend

1. **`contactPhone` source column** — see Assumption A. Implement `COALESCE(phone2, phone)` as the default; if evidence emerges of a different intended column, change the query in one place and note in the PR + `TASKS.md`.
2. **Text-trigger regex** — the spec allows `"פרטים"` and `"פרטים נוספים"`. Regex `^פרטים(?:\s+נוספים)?$/u` covers both.
3. **What if the user has multiple recent reminders and types "פרטים"?** — `setActiveTask` overwrites, so only the most recent task's details are shown. Matches the product's implied UX (act on the reminder you just got). Do not build a picker.
4. **CRM URL when unset** — Meta rejects empty template vars; passing `—` is safe and renders sensibly.
5. **Description/notes truncation limit (200 chars)** — chosen to keep the assembled body well under Meta's ~1024 char limit even in worst case. Adjust downward if Meta rejects the template for length.
