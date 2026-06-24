# Bot V1 — Design Update & Launch Plan

**Status:** Planning approved, implementation **not started** (paused before writing the first file).
**Paused:** 2026-06-22 · **Resume:** Wed 2026-06-24.
**Scope of this doc:** the two new V1 features (scheduled per-user digests + role-based menu) plus the remaining go-live blockers. Companion docs: `AUDIT_BOT_TESTS.md`, `SECURITY_REVIEW.md`, `LIVE_TEST_CHECKLIST.md`, `docs/WHATSAPP_TEMPLATES.md`.

---

## 0. Where we are (done earlier this session — do NOT redo)
- ✅ Model upgraded to **gpt-4o**; intent-parser hardened.
- ✅ Authorization fixed: `canEditTask` (own/elevated), `canCreateForOthers` (elevated), `ELEVATED_ONLY` reassign/relink (manager+admin), viewing opened to all.
- ✅ Task-context retention (chain actions on the same task) + reassign/relink name→id resolution + id→name display.
- ✅ Elevated self-approval of dueDate + "notify other managers" on approve/reject.
- ✅ Go-live prep: strong `INTERNAL_API_SECRET`, `NODE_ENV=production`, prod DB TLS fix (`DATABASE_CA_CERT` support), preflight (`src/config/preflight.ts`), daily summary reverted to 17:00.
- ✅ **10 Meta templates submitted — all PENDING approval.** `WHATSAPP_TEMPLATES_ENABLED=false`.
- ✅ Submission tooling: `scripts/create-whatsapp-templates.ts`, `npm run templates:dry-run|create`, shared `src/whatsapp/templateNames.ts`.
- ✅ Tests green: **67 passed | 3 skipped**, `tsc` clean.

---

## 1. Feature A — Scheduled per-user digests (build from scratch)

**Clarified goal (2026-06-22):** a twice-daily **work-picture summary** — **morning** and **evening (17:00)**. A **worker** gets *all* their tasks for the day (due today + overdue carry-over + open). A **manager/admin** gets *all* tasks for *everyone* — the full company picture (totals + per-employee + who's behind). Purpose: visibility into the whole company's work process each day.

> **DECISION (locked 2026-06-22): default ON.** Every active user with a phone receives morning (08:00) + evening (17:00) digests by default; they can change times or opt out per-user via the menu. **No bulk-seeding needed** — the dispatcher `LEFT JOIN`s `UserDigestPreference` and treats a **missing row as enabled-with-defaults** (`COALESCE(..., true/'08:00'/'17:00'/'Asia/Jerusalem')`). A pref row is created lazily only when a user changes a setting.
> **Hard constraint:** at 17:00 most users are **outside their 24h WhatsApp window**, so delivery needs the **approved digest templates**. Until those are approved, only in-window users receive anything — full company-wide auto-delivery is gated on template approval (§6). (This is why default-ON is safe to ship early: out-of-window users are silently skipped by Meta, no spam.)

**Locked decisions:**
1. **Do NOT keep the fixed 17:00 `dailySummary` active by default.** Gate it behind `LEGACY_DAILY_SUMMARY_ENABLED` (default **false**).
2. New per-user system: `UserDigestPreference` + `WhatsappDigestSendLog`; morning/evening enable flags + times; timezone default `Asia/Jerusalem`. **Default ON** for all active users (morning 08:00 / evening 17:00) via dispatcher `COALESCE` of a missing pref row; users override/opt-out per-user via the menu. *(Overrides the earlier "default OFF" — see locked decision above.)*
3. **No "completed today" in V1** (no real `completedAt`; `updatedAt` unreliable). Add later.
4. **MANAGER and ADMIN both get company-wide summaries** in V1. No department/team scoping.
5. **Numbered text menu only** in V1 (no WhatsApp list messages). Free text unchanged.
6. **Bot must NOT change CRM task status.** Employee menu item is **"Report task completion" / explain-only**.
7. **Do NOT submit new Meta templates.** Add definitions if needed but keep disabled; `WHATSAPP_TEMPLATES_ENABLED` stays false.

### Two distinct digests

**☀️ Morning = "opening day plan"** (what's ahead today):
- EMPLOYEE: own — due today, overdue, open.
- MANAGER/ADMIN: company totals (due today, overdue, open) + per-employee counts + #employees with overdue.

**🌆 Evening = "end-of-day report"** (where the day landed — this is the upgraded part):
- EMPLOYEE: of the tasks **due today** → how many **completed** vs **not completed**; **overdue**; **open carried to tomorrow**; (in-window only) a short list of **unfinished task titles**.
- MANAGER/ADMIN: company totals (due today, completed, not completed, overdue, open carry-over) **+ per-employee breakdown** (name · due today · completed · not completed · overdue) **+ highlight employees with unfinished/overdue tasks**.

### Data-model note (V1 — no reliable `completedAt`)
There is **no `completedAt`/status-history** column. So the evening report is **current end-of-day status**, *not* a historical "completed during today" claim. Classify tasks **due today** by their **current status**:
- **completed** = `status = 'DONE'`
- **not completed** = due today AND `status <> 'DONE'`
- **overdue** = `dueDate::date < today` AND `status <> 'DONE'`
- **open carry-over** = `status IN ('OPEN','IN_PROGRESS')` (the backlog rolling to tomorrow)

Label it clearly in the message as **"סטטוס נוכחי לסוף היום"** / "current end-of-day status". **Do NOT use `updatedAt` as `completedAt`.** (If ever used as a last resort, mark it explicitly "approximate".)
> **TODO (post-V1):** add a real `completedAt` (or a task status-history table) so the evening report can state "completed *today*" as a fact and support trend/throughput metrics.

**Delivery:** out-of-window → compact **counts** template (once approved). In-window now → rich free-form via `notify()` fallback (includes the per-employee breakdown / unfinished titles).

---

## 2. Proposed DB schema — new migration `src/db/migrations/008_digests.sql`
Additive only; RLS deny-all + `deny_all_public` policy like `006`.

```sql
-- UserDigestPreference (timezone lives here; CRM "User" has no tz column)
"userId"         text PK REFERENCES "User"(id)
"morningEnabled" boolean NOT NULL DEFAULT true    -- default ON
"morningTime"    text    NOT NULL DEFAULT '08:00'   -- 'HH:MM' local
"eveningEnabled" boolean NOT NULL DEFAULT true    -- default ON
"eveningTime"    text    NOT NULL DEFAULT '17:00'
"timezone"       text    NOT NULL DEFAULT 'Asia/Jerusalem'
"createdAt"/"updatedAt" timestamptz DEFAULT now()
-- NOTE: rows are created lazily (only when a user changes a setting). The
-- dispatcher LEFT JOINs and COALESCEs missing rows to these same defaults, so
-- EVERY active user is effectively ON without seeding.

-- WhatsappDigestSendLog (dedup, mirrors WhatsappReminderLog)
"userId"     text NOT NULL REFERENCES "User"(id)
"digestType" text NOT NULL          -- 'MORNING' | 'EVENING'
"localDate"  date NOT NULL          -- date in the user's tz
"sentAt"     timestamptz DEFAULT now()
"status"     text DEFAULT 'SENT'    -- SENT | FAILED
PRIMARY KEY ("userId","digestType","localDate")
```
> Decision recorded: NOT reusing `WhatsappNotificationRecipient` (it models event opt-outs, not scheduled times). Preference-change history → existing `WhatsappAuditLog`.

---

## 3. Files to create / change

**New:**
| File | Purpose |
|---|---|
| `src/db/migrations/008_digests.sql` | the two tables |
| `src/services/digestPreferences.ts` | `getDigestPreference`, `upsertDigestPreference` (+ audit), `ensureDigestPreference`, **`parseTimeInput`** (pure) |
| `src/services/digestSendLog.ts` | `claimDigestSend(userId,type,localDate)→bool` (INSERT-first), `markDigestFailed` |
| `src/scheduler/jobs/digestDispatcher.ts` | `runDigestDispatcher` + pure `isDigestDue(cfgHm,localHm)`, `minutesOfDay` |
| `src/whatsapp/digestContent.ts` | **pure** formatters → `{text, params}`: `formatEmployeeMorning`, `formatManagerMorning`, `formatEmployeeEndOfDay`, `formatManagerEndOfDay`; + `digestTemplateKey(user, type)` |
| `src/ai/menu.ts` | `menuItemsFor(user)`, `renderMenu(user)`, `MENU_TRIGGER_RE`, route descriptors |
| `src/__tests__/menu.test.ts`, `src/__tests__/digest.test.ts` | pure-logic tests |
| `src/__tests__/digest.integration.test.ts` | DB tests (guarded `skipIf(!RUN_DB_TESTS)`) |

**Change:**
| File | Change |
|---|---|
| `src/services/tasks.ts` | add: `getEmployeeMorningCounts(ownerId)` {dueToday, overdue, open}; `getEmployeeEndOfDay(ownerId)` {dueToday, completed, notCompleted, overdue, openCarry, unfinishedTitles[]}; `getCompanyMorning()` {totals + per-employee + #overdue}; `getCompanyEndOfDay()` {totals(completed/notCompleted/overdue/openCarry) + per-employee breakdown + #withUnfinishedOrOverdue} |
| `src/whatsapp/templateNames.ts` | add 4 keys: `EMPLOYEE_MORNING_DIGEST`, `MANAGER_MORNING_DIGEST`, `EMPLOYEE_END_OF_DAY_REPORT`, `MANAGER_END_OF_DAY_REPORT` (names only; **not** added to the submission script) |
| `src/scheduler/index.ts` | register `digestDispatcher` (`*/5 * * * *`, lock id **1008**); wrap legacy `dailySummary` in `if (process.env.LEGACY_DAILY_SUMMARY_ENABLED === 'true')`, else log that it's disabled |
| `src/services/conversationContext.ts` | add `awaiting` kinds `'menu' | 'digest_settings' | 'digest_set_time'` + `digestField?: 'morning'|'evening'` |
| `src/ai/router.ts` | menu triggers + numbered routing + digest-settings flow — see §4 (free-text path untouched) |

---

## 4. Router integration (must NOT break NLU / free text)
In `handleAIMessage`, order:
1. `getContext` → if a context exists, `continueConversation` (existing) — **unchanged**.
2. **NEW (fresh message only):** if `MENU_TRIGGER_RE.test(trimmed)` (`menu|תפריט|עזרה|היי|שלום`) → `showMenu(user)` (sets `awaiting:'menu'`), return.
3. Else existing parse + route — **unchanged**. (So any non-trigger free text behaves exactly as today.)

`continueConversation` new branches:
- `'menu'` → numeric/in-range → `handleMenuRoute(user, route)`; out-of-range → re-prompt.
- `'digest_settings'` (titled **"הגדרות סיכום בוקר / דוח סוף יום"**) → 1 enable morning summary · 2 disable morning summary · 3 change morning time · 4 enable end-of-day report · 5 disable end-of-day report · 6 change end-of-day time · 7 back. (Underlying fields stay `morningEnabled/morningTime` + `eveningEnabled/eveningTime`; only the *content* and labels differ.) Time changes → set `awaiting:'digest_set_time'` + `digestField`.
- `'digest_set_time'` → `parseTimeInput` → save + confirm + reshow settings, or re-prompt on invalid.

**Menus (numbered):**
- *Employee:* 1 My tasks · 2 Today · 3 Overdue · 4 **Report task completion (explain-only)** · 5 Request due-date change (guide) · 6 **הגדרות סיכום בוקר / דוח סוף יום** (Digest settings) · 7 Free text.
- *Manager/Admin:* 1 Daily overview (`team_workload`) · 2 Tasks by employee (guide) · 3 Overdue · 4 Today · 5 Create task for employee (guide) · 6 Pending approvals · 7 **הגדרות סיכום בוקר / דוח סוף יום** (Digest settings) · 8 Free text.

`handleMenuRoute` maps each to existing behavior (build a `list_tasks` intent → `executeIntent`, or `doTeamWorkload`, or `getPendingApprovals` display, or a guide message, or open digest settings, or clear context for free text).

---

## 5. Scheduler logic (digestDispatcher)
- Runs **every 5 min**, advisory-locked (id 1008), tz `Asia/Jerusalem`.
- One SQL: `FROM "User" u LEFT JOIN "UserDigestPreference" p ON p."userId"=u.id`, filtering active users w/ a phone. **`COALESCE(p."morningEnabled",true)`, `COALESCE(p."eveningEnabled",true)`, `COALESCE(p."morningTime",'08:00')`, `COALESCE(p."eveningTime",'17:00')`, `COALESCE(p.timezone,'Asia/Jerusalem')`** — so users with no pref row are ON by default. Compute `to_char(now() AT TIME ZONE tz,'HH24:MI') AS local_hm` and `(now() AT TIME ZONE tz)::date AS local_date`.
- JS: for each row, `isDigestDue(morningTime, local_hm)` / `isDigestDue(eveningTime, local_hm)` where due = `0 <= (nowMin - cfgMin) < 5`.
- For each due (MORNING/EVENING): `claimDigestSend(userId,type,localDate)` (INSERT-first) → if won, **pick content by type**: MORNING → opening-day-plan builder; EVENING → end-of-day-report builder (status classification below). Role picks employee vs company builder. Then `notify({key, bodyParams, fallbackText})`, audit `SUCCESS`; on send error `markDigestFailed` + audit `FAILED`.
- **End-of-day status classification** (current status, `CURRENT_DATE` = Asia/Jerusalem session tz):
  ```sql
  COUNT(*) FILTER (WHERE "dueDate"::date = CURRENT_DATE)                          AS due_today
  COUNT(*) FILTER (WHERE "dueDate"::date = CURRENT_DATE AND status = 'DONE')      AS completed
  COUNT(*) FILTER (WHERE "dueDate"::date = CURRENT_DATE AND status <> 'DONE')     AS not_completed
  COUNT(*) FILTER (WHERE "dueDate"::date < CURRENT_DATE AND status <> 'DONE')     AS overdue
  COUNT(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS'))                        AS open_carryover
  ```
  Employee = `WHERE "ownerId"=$1`; manager/admin = same FILTERs `GROUP BY` employee + a totals roll-up, plus unfinished/overdue titles via a small `LIMIT`ed query for the in-window list.
- **Dedup:** PK `(userId,type,localDate)` → at most one morning + one evening per user per local day, across restarts/overlaps.
- **Failed sends:** `notify`/sender already retry + DLQ; status row marked FAILED, no duplicate same day.
- Minor known edge: midnight-wrap times (e.g. 23:58) — acceptable for V1.

---

## 6. WhatsApp template needs
`daily_summary` (name + open count) is **too limited**. Proposed counts-based templates (Hebrew, UTILITY, `he`) — **do NOT submit until explicitly approved:**

**Morning ("opening day plan"):**
- `employee_morning_digest` (4 vars) — `בוקר טוב {{1}}! תוכנית היום: {{2}} משימות להיום, {{3}} באיחור, {{4}} פתוחות. שלח "המשימות שלי" לפירוט.`
- `manager_morning_digest` (5 vars) — `בוקר טוב {{1}}! תוכנית צוות: {{2}} להיום, {{3}} באיחור, {{4}} פתוחות, {{5}} עובדים עם משימות באיחור. שלח "עומס משימות בצוות".`

**Evening ("end-of-day report" — current status):**
- `employee_end_of_day_report` (6 vars) — `ערב טוב {{1}}! דוח סוף יום: מתוך {{2}} משימות להיום — {{3}} בוצעו, {{4}} לא בוצעו. בנוסף {{5}} באיחור ו-{{6}} פתוחות שעוברות למחר. שלח "המשימות שלי" לפירוט.`
- `manager_end_of_day_report` (7 vars) — `ערב טוב {{1}}! דוח סוף יום (צוות): מתוך {{2}} להיום — {{3}} בוצעו, {{4}} לא בוצעו. {{5}} באיחור, {{6}} פתוחות למחר, {{7}} עובדים עם משימות פתוחות/באיחור. שלח "עומס משימות בצוות".`

(None start/end with a variable — passes our validator. ADMIN reuses `manager_*`. Counts only — the **per-employee breakdown + unfinished titles live in the in-window free-form** message, not the template.) Until approved, digests deliver **in-window only** (rich free-form via fallback).

### 6a. Quick-reply buttons (proposed — NOT submitted)
Each of the 4 templates gets **2 Quick Reply buttons** whose payloads must equal the in-window button IDs (`src/ai/digestCommands.ts → DIGEST_PAYLOAD_IDS`), so a tapped button routes the same deterministically whether it came from a template (out-of-window) or the free-form fallback (in-window). The CTA text was updated to `👇 לחץ על הכפתור לפירוט, או כתוב "<command>" / "כתיבה חופשית".`

| Template | Button 1 (title → payload) | Button 2 (title → payload) |
|---|---|---|
| `employee_morning_digest` | `משימות להיום` → `digest_emp_today` | `כתיבה חופשית` → `digest_free_text` |
| `employee_end_of_day_report` | `דוח סוף יום שלי` → `digest_emp_eod` | `כתיבה חופשית` → `digest_free_text` |
| `manager_morning_digest` | `משימות להיום בצוות` → `digest_team_today` | `כתיבה חופשית` → `digest_free_text` |
| `manager_end_of_day_report` | `דוח סוף יום צוות` → `digest_team_eod` | `כתיבה חופשית` → `digest_free_text` |

> Meta quick-reply payloads are returned as `interactive.button_reply.id`, which the webhook already forwards as message text — so the existing deterministic matcher handles both template-button taps and in-window taps with no extra parsing. **Still NOT submitted; `WHATSAPP_TEMPLATES_ENABLED` stays false.**

---

## 7. Env vars to add
| Var | Default | Purpose |
|---|---|---|
| `LEGACY_DAILY_SUMMARY_ENABLED` | `false` | keep old fixed 17:00 broadcast off |
| (existing) `WHATSAPP_TEMPLATES_ENABLED` | `false` | stays false until digest templates approved |

No secrets; `.env` stays gitignored. (No new required-in-prod var, so preflight unchanged.)

---

## 8. Test plan (resume target)
**Pure (offline, in `menu.test.ts` / `digest.test.ts`):**
- employee menu items; manager/admin menu items; `MENU_TRIGGER_RE` matches triggers; **free text (`"הצג את המשימות שלי"`) does NOT match** (bypass preserved).
- `parseTimeInput`: `8`, `8:30`, `08:00` valid → `HH:MM`; `25:00`, `8:99`, `abc`, `''` invalid.
- `isDigestDue`: fires inside the 5-min window, not before/after; `digestTemplateKey(role,type)` maps to the 4 keys (morning vs end_of_day × employee vs manager).
- **Morning formatters**: employee shows due-today/overdue/open; manager adds per-employee + #overdue; employee output has **no** per-employee data.
- **End-of-day formatters**: `completed + notCompleted === dueToday`; overdue and open-carry rendered; employee end-of-day lists unfinished titles (in-window) but never others' tasks; manager end-of-day includes the per-employee breakdown + highlights employees with unfinished/overdue.
- **End-of-day classification** (pure, given a fixture task set): completed = DONE due-today, notCompleted = due-today not DONE, overdue = due<today not DONE, openCarry = OPEN/IN_PROGRESS — and that the message is labeled "current end-of-day status" (no false "completed today" claim).

**DB-guarded (`digest.integration.test.ts`, `RUN_DB_TESTS=1`):**
- preference create + update (+ audit row written); `claimDigestSend` returns true once then false same `(user,type,day)` (**no duplicate**); failed-send marks `FAILED`; dispatcher due-detection selects the right user.
- **default ON:** a user with **no** `UserDigestPreference` row is still selected by the dispatcher (COALESCE defaults); a user who opted out (`eveningEnabled=false`) is **not**.

---

## 9. Rollout plan
1. Ship migration + code with digests **ON by default**, `LEGACY_DAILY_SUMMARY_ENABLED=false`, templates **disabled**. Because templates are off, **only in-window users receive digests** at first — out-of-window users are silently skipped by Meta (no spam), so shipping default-ON early is safe.
2. Menu + settings live (free text fully preserved). Verify with a couple of in-window test users: delivery + dedup (no double-send) + audit.
3. Submit the 4 new templates **only after explicit approval**; once approved → `WHATSAPP_TEMPLATES_ENABLED=true`. **At that point every active user with a phone begins receiving morning + evening digests** (the intended company-wide visibility). Users can opt out / change times via the menu.
4. Legacy 17:00 job stays off (flag) — remove entirely later. (Its replacement is the evening digest.)

## 10. Risks / watch-items
- **Default ON (locked):** once digest templates are approved + `WHATSAPP_TEMPLATES_ENABLED=true`, **all** active users with a phone get 2 messages/day. This intentionally overrides the earlier "don't auto-message everyone" guard — accepted for the company-visibility goal. Opt-out + time-change available per-user via the menu. Until templates are approved, only in-window users are reached.
- Don't double-send: legacy 17:00 vs evening digest → legacy gated off (decision locked).
- "Report task completion" must stay **explain-only** (no CRM status writes).
- Manager == Admin scope in V1 (company-wide); department scoping is a future design.
- Greetings `שלום/היי/עזרה` now open the menu (intended minor change).
- Out-of-window digests silent until templates approved (accepted).

---

## 11. Remaining go-live blockers (independent of this feature)
From `SECURITY_REVIEW.md` / `AUDIT_BOT_TESTS.md`:
- 🔴 **Rotate live secrets** before launch (WhatsApp token, Supabase service-role key + DB password, OpenAI key).
- 🟠 Wait for the **10 templates to be Approved**, then `WHATSAPP_TEMPLATES_ENABLED=true`.
- 🟠 Run the **`LIVE_TEST_CHECKLIST.md`** with a real number (restart first).
- 🟡 Optional hardening: remove unused `supabaseAdmin`, least-privilege DB role, `DATABASE_CA_CERT`, bind internal routes to localhost.

---

## 12. First actions on resume (Wed 2026-06-24)
1. Create `src/db/migrations/008_digests.sql` (§2).
2. `digestPreferences.ts` + `digestSendLog.ts` (pure `parseTimeInput` first — easy test win).
3. `digestContent.ts` formatters + `services/tasks.ts` count queries.
4. `digestDispatcher.ts` + register in `scheduler/index.ts` (+ legacy flag).
5. `conversationContext.ts` states → `menu.ts` → `router.ts` wiring.
6. Add tests; run `npx tsc --noEmit` && `npm test`; expect green.
7. Report per the agreed format (files, migration, env, commands, results, manual-test/enable/verify-legacy-off steps).
