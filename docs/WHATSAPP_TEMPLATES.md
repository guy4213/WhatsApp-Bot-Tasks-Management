# WhatsApp Message Templates

## 1. Why templates are needed
WhatsApp Business only lets you send **free-form** messages to a user **within 24 hours of their last message to you** (the "customer-service window"). To send a business-initiated message **outside** that window, you must use a **pre-approved message template**.

## 2. They're only for proactive / out-of-window messages
The bot's **proactive** notifications — daily summaries, due reminders, deadline alerts, manager approval requests, completion notices, expiry notices — are sent by the scheduler when the user usually isn't actively chatting (out of window). Those require approved templates.

## 3. Regular replies do NOT need templates
Anything the bot sends **as a reply** to a user message (confirmations, lists, task details, error messages) is **inside** the 24-hour window and is sent as free-form text — **no template required**. That path is unaffected by template configuration.

## 4. Env vars
Set these (e.g. in `.env`, which is gitignored):

```
META_GRAPH_VERSION=v23.0
META_WABA_ID=<your WhatsApp Business Account id>
WHATSAPP_ACCESS_TOKEN=<Graph API token>     # never logged; never commit
WHATSAPP_TEMPLATE_LANG=he               # default: he
```

- `META_GRAPH_VERSION` defaults to `v23.0` if unset.
- `WHATSAPP_ACCESS_TOKEN` / `META_WABA_ID` are required only for a **live** submit (not for `--dry-run`).
- Per-template name overrides are honoured: `WHATSAPP_TEMPLATE_<KEY>` (e.g. `WHATSAPP_TEMPLATE_DAILY_SUMMARY=my_name`).

## 5. Dry-run (no Meta calls)
Preview the exact payloads without sending anything:

```
npm run templates:dry-run
```

It validates every template and prints the JSON payloads. It makes **zero** network requests and never needs the token.

## 6. Submit for approval
After reviewing the dry-run, submit to Meta:

```
npm run templates:create
```

Per template it prints one of: `submitted` (PENDING in Meta), `skipped` (already exists), `warned` (exists with a different body — not overwritten), or `failed`. It exits non-zero **only** if there were real failed submissions. The access token is only ever sent in the `Authorization` header — it is never printed.

> The project uses **ts-node** (not `tsx`); the npm scripts above already use it.

## 7. Check approval status
In **Meta WhatsApp Manager → Account tools → Message Templates**, each template shows a status: **Pending → Approved / Rejected**. Approval is usually minutes to a few hours. You can also re-run `npm run templates:create` — already-approved ones report `skipped: already exists`.

## 8. When to set `WHATSAPP_TEMPLATES_ENABLED=true`
Only **after all 10 templates show "Approved"** in Meta. Then set `WHATSAPP_TEMPLATES_ENABLED=true` and restart the server. From then on, proactive messages are sent as templates (delivered even out-of-window).

## 9. Why it must stay `false` until approval
If `WHATSAPP_TEMPLATES_ENABLED=true` while a template is **not yet approved**, sending that notification will **fail** at Meta (unknown/unapproved template) and the user gets nothing. While it's `false`, the bot safely falls back to **free-form text**, which still works for in-window recipients — so leaving it `false` until approval avoids dropped notifications.

## 10. Common failures
| Symptom | Cause / fix |
|---|---|
| `401 / invalid OAuth token` | Bad/expired `WHATSAPP_ACCESS_TOKEN`. Regenerate a token with `whatsapp_business_management` permission. |
| `Unsupported get/post` or 404 on the URL | Missing/incorrect `META_WABA_ID`. |
| `already exists` | The template name is already registered — reported as `skipped`. Names must be unique per WABA. |
| Template **Rejected** in Meta | Wording looked promotional, wrong category, or policy issue. Edit the body, delete the rejected one in Meta, re-submit. |
| Wrong language | Body language must match the declared `language` (`he`). Don't mix languages. |
| Wrong category | These are `UTILITY` (task/account notifications). Marketing-style copy gets rejected — keep it transactional. |
| `body starts/ends with a variable` | Meta forbids a body that begins or ends with `{{n}}`. **A trailing period/punctuation after the last variable does NOT count as text** — `…{{2}}.` is still rejected (Graph error `100/2388299`). Add real words after the last variable. The script validates both (it strips trailing punctuation before the end-check); e.g. `duedate_approved` ends with `… {{3}}. העדכון נשמר במערכת.`. |
| `adjacent variables` | Two `{{n}}` with no text between them (`{{1}}{{2}}`) is rejected. The script validates this too. |
| `example count != placeholders` | Each `{{n}}` needs exactly one example value, in order. Script-validated. |

---

## Template ↔ runtime mapping
Template **names** come from the shared registry `src/whatsapp/templateNames.ts` (also used by the runtime sender), so submitted names always match what the bot sends. The 10 keys → names:

`DAILY_SUMMARY`→`daily_summary`, `DUE_REMINDER`→`due_reminder`, `DEADLINE_EXCEEDED`→`deadline_exceeded`, `DEADLINE_APPROACHING`→`deadline_approaching`, `DUEDATE_APPROVAL_REQUEST`→`duedate_approval_request`, `DUEDATE_APPROVED`→`duedate_approved`, `DUEDATE_REJECTED`→`duedate_rejected`, `TASK_COMPLETED`→`task_completed`, `REQUEST_EXPIRED`→`request_expired`, `REQUEST_EXPIRED_MANAGER`→`request_expired_manager`.

### Note on `duedate_approval_request`
The Meta template body was corrected to start with `שלום, ` (a body may not start with a variable). The **runtime** sends `bodyParams = [requester, taskTitle, newDate, actionId]`, which line up with `{{1}}…{{4}}` in the corrected body — so **no runtime change is required**. The in-window **fallback** text (free-form, in `src/routes/tasks.ts`) still starts with the requester's name; that's allowed for free-form and was intentionally left unchanged. Align it only if you want the in-window and template wording identical.
