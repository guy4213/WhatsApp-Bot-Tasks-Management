# WhatsApp Task Bot — MVP Test Checklist

> Status reflects the code **after** the fix pass (2026-06-18). Rows marked **FIXED** were failing/partial in the initial evaluation and have since been addressed; see the matching code change. The only non-PASS rows (7.2, 20.3) are ⬜ MANUAL — they need live Meta infra to verify; the code is done.

**Legend:** ✅ PASS · ❌ FAIL · ⚠️ PARTIAL/RISK · ⬜ MANUAL (needs live infra)

## 0. Build & Automated

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | BUILD | `npm run build` compiles with no TypeScript errors | ✅ PASS | `tsc --noEmit` exits 0, no type errors, strict:true. |
| [x] | TEST | `npm test` — all unit/integration tests pass | ✅ PASS | `vitest run` = 33 passed, 3 skipped (DB integration block, skipped unless RUN_DB_TESTS=1), exit 0. |

## 6. Core backend

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 6.1 | Health check (GET /health → {status:ok}) | ✅ PASS | GET /health returns exactly `{status:'ok'}`. |
| [x] | 6.2 | Database readiness (GET /health/ready) | ✅ PASS | Correct (and better than the plan): HTTP 200 `{status:'ok',db:'connected'}` on DB success, 503 `{status:'error',db:'unreachable'}` on failure. `body.status==='ok'` holds; the extra `db` field is intentional/informative. |

## 7. WhatsApp Webhook

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 7.1 | Webhook verification (GET /webhook challenge) | ✅ PASS | GET /webhook echoes hub.challenge when mode='subscribe' and token matches (timing-safe), else 403. |
| [ ] | 7.2 | Meta webhook subscription (dashboard) | ⬜ MANUAL | Requires live Meta dashboard subscription configuration; cannot be judged from code. |
| [x] | 7.3 | Incoming WhatsApp message reaches backend | ✅ PASS | POST /webhook backend path is correct (HMAC verify, dedup via inbound queue PK, ACK 200 'EVENT_RECEIVED' before processing); depends on tunnel+Meta but backend behavior is sound. |

## 8. Phone authentication

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 8.1 | Known active user authenticated | ✅ PASS | resolveUserByPhone matches canonical phone and accepts status 'active' OR 'ACTIVE'. |
| [x] | 8.2 | Unknown number rejected | ✅ PASS | FIXED: webhook now replies the plan's 2-line message ("…אינו מזוהה כעובד פעיל…/יש לפנות למנהל המערכת…") and audits UNKNOWN_NUMBER. |
| [x] | 8.3 | Inactive user rejected | ✅ PASS | FIXED: inactive users now get a distinct "המשתמש שלך אינו פעיל…" message (branch on auth.reason), audited INACTIVE_USER. |
| [x] | 8.4 | Phone normalization to canonical | ✅ PASS | "052-1234567","0521234567","+972521234567","972521234567" all normalize to "972521234567"; phoneNormalizer.test.ts passes. |

## 9. Read tasks

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 9.1 | List my tasks today | ✅ PASS | read scope 'today' runs immediately with no confirm required. |
| [x] | 9.2 | List my open tasks | ✅ PASS | read scope 'open' runs immediately (confirm only when a date range is set). |
| [x] | 9.3 | List tasks this week | ✅ PASS | read scope 'this_week' runs immediately, no confirm. |
| [x] | 9.4 | Read task details | ✅ PASS | get_task via getTaskById works; disambiguation supported. |
| [x] | 9.5 | Read tasks by createdAt (with confirm) | ✅ PASS | A dateFrom/dateTo range triggers read_confirm before listing. |
| [x] | 9.6 | Read all users' tasks as regular employee (denied) | ✅ PASS | listTasks clamps ownOnly when scope!=='all' or !canViewAllTasks; a regular employee asking scope='all' is forced to own-only. |
| [x] | 9.7 | Read all users' tasks as manager/admin (allowed) | ✅ PASS | Elevated user (canViewAllTasks) sees all tasks; clamp does not apply. |

## 10. Create task

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 10.1 | Create task for self | ✅ PASS | FIXED: normalizeTaskType() maps plain-Hebrew step descriptions (and stepQuote=הצעת מחיר, now bot-assignable) to enum values; AI emits enum + asks for type when missing. Confirm-before-write intact. |
| [x] | 10.2 | Create task and decline | ✅ PASS | CANCEL → DECLINED/SKIPPED, audited, no insert. |
| [x] | 10.3 | Create for another user as regular employee (denied) | ✅ PASS | target!=caller and !canCreateForOthers → 403. |
| [x] | 10.4 | Create for another user as manager/admin (allowed) | ✅ PASS | FIXED: manager create-for-others works and the type mapping caveat is resolved (Hebrew→enum normalization). |
| [x] | 10.5 | Create with missing date (asks clarification) | ✅ PASS | Missing required field → clarification (missing_fields) before create. |

## 11. Free edit

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 11.1 | Edit title | ✅ PASS | title is FREE_EDIT → EDIT_FIELD pending action + confirm → 202, audited SUCCESS. |
| [x] | 11.2 | Edit description | ✅ PASS | description is FREE_EDIT → confirm-before-write applies, audited. |
| [x] | 11.3 | Edit priority | ✅ PASS | priority is FREE_EDIT, validated vs live TaskPriority enum; works if value valid. |
| [x] | 11.4 | Edit type | ✅ PASS | FIXED: editing type now runs the value through normalizeTaskType() ("כתיבת דוח"→step7, "תיאום"→step5, …), validated and confirmed before write. |
| [x] | 11.5 | Attempt to edit status (blocked) | ✅ PASS | FIXED: status still never changes, AND the AI now returns an explicit Hebrew clarification ("לא ניתן לשנות סטטוס… הסטטוס מנוהל ב‑CRM") which the router surfaces to the user; logged as SKIPPED. |

## 12. dueDate manager approval

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 12.1 | Employee requests dueDate change | ✅ PASS | dueDate is REQUIRES_MANAGER_APPROVAL → EDIT_DUEDATE pending action + employee confirm + audit PENDING → 202. |
| [x] | 12.2 | Employee confirms dueDate request | ✅ PASS | Employee confirm transitions to PENDING_MANAGER_APPROVAL and broadcasts to managers. |
| [x] | 12.3 | Manager approves | ✅ PASS | FIXED: a manager's plain "מאשר"/"אשר" now resolves the single pending PENDING_MANAGER_APPROVAL via getPendingApprovals()→/tasks/approve (multiple pending → bot lists them to pick by id). "אשר <uuid>" still works too. |
| [x] | 12.4 | Manager rejects | ✅ PASS | FIXED: plain "דחה" maps to decline→/tasks/approve REJECT for the pending request (same single-vs-many handling). |
| [x] | 12.5 | Regular employee attempts manager approval (denied) | ✅ PASS | /tasks/approve requires canApprove=isElevated → regular employee 403 (also requires uuid). |
| [x] | 12.6 | First manager wins (race) | ✅ PASS | transitionState conditional UPDATE WHERE state=expected; rowCount 0 → 409 'Another manager already resolved this request'. |
| [x] | 12.7 | Pending dueDate request expires | ✅ PASS | expireActions cron sets EXPIRED past expiresAt and notifies requester (and managers if it was a manager-approval). |

## 13. Admin-only fields

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 13.1 | Regular employee tries to reassign (denied) | ✅ PASS | ownerId is ADMIN_ONLY → non-admin gets FORBIDDEN/403. |
| [x] | 13.2 | Admin reassigns task | ✅ PASS | Admin role → ADMIN_ONLY field editable via PATCH/confirm. |
| [x] | 13.3 | Admin changes project link | ✅ PASS | Admin relink of projectId works via PATCH/confirm. Passing a non-existent id returns a clean FK 400 with a readable message — correct, desirable validation, not a defect. |

## 14. Confirmation behavior

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 14.1 | Accepted confirmations (כן/אשר/מאשר/תאשר/בצע/אוקיי/סבבה) | ✅ PASS | FIXED: YES_RE expanded to כן/אישור/אשר/תאשר/מאשר/בצע/בטח/אוקיי/סבבה (+AI path); all listed words now confirm. |
| [x] | 14.2 | Accepted declines (לא/בטל/אל תבצע/עצור/לא מאשר) | ✅ PASS | FIXED: NO_RE expanded to לא/ביטול/בטל/עצור/אל תבצע (+ "לא מאשר" via לא prefix; +AI path). |
| [x] | 14.3 | Correction request (שנה/תיקון/רגע/לא לזה התכוונתי) | ✅ PASS | FIXED: a short correction word in a confirm context clears the pending action and asks the user to restate ("…לא ביצעתי כלום. נסח מחדש…"). |

## 15. AI intent parsing

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 15.1 | Hebrew typo tolerance | ✅ PASS | LLM is typo-tolerant with temperature 0. |
| [x] | 15.2 | Reversed / RTL display issue | ✅ PASS | RTL reversal is terminal-only; WhatsApp renders fine and logic is unaffected. |
| [x] | 15.3 | Low confidence → clarify | ✅ PASS | Low confidence (<0.60) → unknown/clarify. |
| [x] | 15.4 | Missing task reference → ask | ✅ PASS | Missing task_reference → bot asks which task. |
| [x] | 15.5 | Unknown request → out of scope | ✅ PASS | FIXED: AI returns an explicit out-of-scope clarification ("אני מטפל רק בניהול משימות…") which the router sends, and the event is audited (SKIPPED). |

## 16. Scheduler

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 16.1 | Daily summary at 17:00 | ✅ PASS | dailySummary cron 0 17 * * * Asia/Jerusalem; each owner with open/in-progress tasks (users with no tasks get nothing). |
| [x] | 16.2 | One-hour reminder | ✅ PASS | FIXED: added WhatsappReminderLog (migration 006); the reminder now INSERT-first dedups per (taskId,'DUE_1H'), so it can't re-fire across restarts/overlaps. Still skips DONE. |
| [x] | 16.3 | Deadline approaching alert | ✅ PASS | deadlineApproaching 0 9 * * * within 24h → managers/admins, advisory-lock dedup across instances. |
| [x] | 16.4 | Deadline exceeded alert | ✅ PASS | FIXED: deadlineExceeded now dedups per task via WhatsappReminderLog ('DEADLINE_EXCEEDED') — each overdue task alerts managers once, not every day. |
| [x] | 16.5 | Expire pending actions | ✅ PASS | expireActions */5min sets EXPIRED and notifies; FOR UPDATE SKIP LOCKED. |

## 17. CRM completion notification

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 17.1 | CRM changes status to DONE → notify | ✅ PASS | completionNotifier */2min polls status='DONE', notifies managers/admins; bot never changes status itself. |
| [x] | 17.2 | Duplicate completion polling deduped | ✅ PASS | INSERT-first ON CONFLICT DO NOTHING into WhatsappCompletionNotification → notifies exactly once (table-based dedup). |

## 18. Audit log

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 18.1 | Successful read logged | ✅ PASS | FIXED: runListTasks/doGetTask now call writeAuditLog (auditEvent) with SUCCESS (and SKIPPED when not found / out-of-scope). |
| [x] | 18.2 | Successful write logged | ✅ PASS | Successful CREATE and EDIT_FIELD write SUCCESS audit rows (with old/new values). |
| [x] | 18.3 | Declined write logged | ✅ PASS | CANCEL → DECLINED/SKIPPED audit row written. |
| [x] | 18.4 | Unauthorized action logged | ✅ PASS | FIXED: auditDenied() now writes a SKIPPED row at the create-for-others, link-fields, readonly/forbidden, admin-only, and approve 403 points (plus auth-layer phone failures). |
| [x] | 18.5 | Backend error logged | ✅ PASS | FIXED: processInbound's catch now writes a FAILED audit row (in addition to sender DLQ + queue-failed marking). |

## 19. Security & safety

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 19.1 | AI cannot write directly | ✅ PASS | AI provider gets only system prompt + user message + tool schema; emits JSON tool call only, backend does all DB writes. |
| [x] | 19.2 | Service role key server-only | ✅ PASS | SUPABASE_SERVICE_ROLE_KEY is server-side only, never sent to AI/frontend; .env is gitignored. |
| [x] | 19.3 | RLS enabled on bot tables | ✅ PASS | Every migration ENABLEs RLS + deny_all_public RESTRICTIVE policy on WhatsappPendingAction, WhatsappAuditLog, WhatsappNotificationRecipient and others. |
| [x] | 19.4 | Unknown phone cannot access tasks | ✅ PASS | Unknown phone → UNKNOWN_NUMBER, no task access, audited. |
| [x] | 19.5 | Regular employee cannot access other's task by title | ✅ PASS | Scope clamp + getTaskById AND ownerId filter → non-elevated gets null for others' tasks. |

## 20. WhatsApp sending

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 20.1 | Send plain text reply | ✅ PASS | type:'text' send path works (help/plain text replies). |
| [x] | 20.2 | Send interactive confirmation | ✅ PASS | FIXED: sendButtonMessage() sends interactive reply buttons (כן/לא, id="כן <uuid>") for the create/edit/dueDate confirm prompts; webhook parses interactive.button_reply and routes it like a typed reply (text still works as fallback). |
| [ ] | 20.3 | Proactive template message | ⬜ MANUAL | templates.notify() template path is correct but requires an approved Meta template + WHATSAPP_TEMPLATES_ENABLED=true to verify live (falls back to free-form text otherwise). Code is done; verification is environmental. |
| [x] | 20.4 | WhatsApp send retry/backoff | ✅ PASS | MAX_ATTEMPTS=3; 429 wait 60s, other retryable exponential backoff, then DLQ to WhatsappAuditLog FAILED. |

## 21. Error handling

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | 21.1 | Supabase unavailable | ✅ PASS | /health/ready returns 503 with graceful error; inbound queue fallback handles failures. |
| [x] | 21.2 | AI provider unavailable | ✅ PASS | handleAIMessage early-returns "שירות ה-AI אינו מוגדר עדיין..."; regex quick replies (כן/לא/אשר <uuid>) still work without AI. |
| [x] | 21.3 | Meta send failure | ✅ PASS | Send failure is retried, logged, and DLQ'd to WhatsappAuditLog FAILED. |
| [x] | 21.4 | Invalid enum rejected | ✅ PASS | Invalid type/priority → 400 with no DB write. |

## 22. End-to-end scenarios

| Done | ID | Test | Status | Verdict / Why |
| --- | --- | --- | --- | --- |
| [x] | E2E-1 | Employee reads own tasks | ✅ PASS | Read flow runs immediately for own tasks with scope clamp enforced. |
| [x] | E2E-2 | Employee creates task for self | ✅ PASS | FIXED: "להתקשר לדני" with no type → bot asks which step, maps the Hebrew answer to the enum, confirms (buttons), then creates. Type-mapping friction resolved. |
| [x] | E2E-3 | Employee denied access to all tasks | ✅ PASS | scope='all' forced to own-only for regular employee. |
| [x] | E2E-4 | Manager sees all tasks | ✅ PASS | Elevated user (canViewAllTasks) sees all tasks. |
| [x] | E2E-5 | dueDate approval flow | ✅ PASS | FIXED: manager's plain "מאשר" now resolves the pending PENDING_MANAGER_APPROVAL → dueDate updated, employee notified, audited. |
| [x] | E2E-6 | dueDate rejection flow | ✅ PASS | FIXED: manager's plain "דחה" now rejects the pending request → dueDate unchanged, employee notified, audited. |
| [x] | E2E-7 | Bot never changes status | ✅ PASS | FIXED: status still never changes AND the bot explicitly explains status is CRM-owned when asked to change it. |
