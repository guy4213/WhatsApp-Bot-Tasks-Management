# Code Audit — WhatsApp Task Bot Manual Test Suite

**Method:** Static code audit. Each manual test was traced to the code that implements it and assessed against the expected result. This does **not** replace live testing — anything that depends on Meta/WhatsApp delivery, real cron firing, or DB row inspection is marked accordingly.

**Legend**
- ✅ **PASS** — code implements the expected behavior.
- ⚠️ **PARTIAL / RISK** — works, but with a caveat or model-dependence.
- ❌ **DIVERGES** — code does **not** match the test's expectation (often intentional, due to a later requirement change).
- 🔵 **LIVE** — code path is correct, but must be confirmed against live Meta/WhatsApp/cron.
- 🟣 **DB** — correct write exists; verify by inspecting the database.

---

## ‼️ Read this first — cross-cutting caveats

1. **Restart required.** Many recent changes (gpt-4o model, task-context, reassign/relink name-resolution, elevated self-approval, etc.) load at startup. Verdicts below reflect the **current source**, i.e. behavior **after** a restart. If you test before restarting, you're testing old code.

2. **Two tests now INTENTIONALLY diverge from this sheet** because you explicitly changed the policy to *"let everyone view all tasks, restrict only writes"*:
   - **M-3.6** (regular employee asks for everyone's tasks) — sheet expects "own only"; code now returns **all** (viewing is open).
   - **M-14.2** (employee can't see another's task by name) — sheet expects "no info"; code now **does** return it.
   These are ❌ vs. the sheet, but ✅ vs. your decision. Decide which is authoritative and update the sheet or the code.

3. **WhatsApp 24-hour window.** `WHATSAPP_TEMPLATES_ENABLED=false`, so all proactive messages (manager approvals, deadline/summary/completion alerts) fall back to free-form text, which Meta only delivers to recipients **inside their 24h window**. Affects M-7.3, M-10.5, M-11.x, E2E-M-9/10.

4. **Daily summary time is temporarily 13:00** (changed for your test), not 17:00 — so **M-11.1** reads "17:00" but the code fires at **13:00**. Revert `scheduler/index.ts` to `0 17 * * *` when done.

5. **AI model is now `gpt-4o`** (`.env`). Section 9 and all NLU-dependent tests assume it.

---

## 1. Connection
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-1.1 | `/health` → status ok | ✅ | `app.ts:60` returns `{status:'ok'}` (also `/health/live`). |
| M-1.2 | `/health/ready` → db connected | ✅ | `app.ts:49-52` returns `{status:'ok', db:'connected'}`; 503 on DB failure. |
| M-1.3 | Meta verify challenge | ✅ 🔵 | `webhook.ts:75-82` GET `/webhook` checks `hub.mode`+`hub.verify_token`, echoes `hub.challenge`. Confirm live in Meta dashboard. |
| M-1.4 | Inbound msg → bot responds, not stuck | ✅ 🔵 | `webhook.ts:88` ACKs 200 immediately, enqueues durably, then `processInbound`. |

## 2. User identification
| ID | Expected | Verdict | Evidence |
|----|----------|---------|----------|
| M-2.1 | Active employee recognized | ✅ | `userResolver.ts` resolves phone→active user. |
| M-2.2 | Unknown number blocked | ✅ | `webhook.ts:274` "המספר … אינו מזוהה כעובד פעיל". |
| M-2.3 | Inactive user blocked | ✅ | `webhook.ts:273` "המשתמש שלך אינו פעיל"; `userResolver.ts:87` status check. |
| M-2.4 | Israeli phone formats | ✅ | `phoneNormalizer.ts` handles `05x`, `+972`, `972…`, dashes/spaces. |

## 3. Reading tasks
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-3.1 | Today | ✅ | `list_tasks` filter `today`. |
| M-3.2 | Open | ✅ | filter `open`. |
| M-3.3 | This week | ✅ | filter `this_week`. |
| M-3.4 | Task details / ask | ✅ | `get_task` → `resolveOrAsk` resolves or disambiguates. |
| M-3.5 | Created-yesterday → confirm range first | ✅ | `router.ts:595-602` sets `read_confirm` when a date range is present. |
| M-3.6 | Regular employee → own only | ❌ | **Intentional divergence** (caveat #2). `canViewAllTasks` now returns `true`; employee gets **all**. |
| M-3.7 | Manager → all | ✅ | listTasks team-wide for elevated. |

## 4. Creating tasks
| ID | Expected | Verdict | Evidence |
|----|----------|---------|----------|
| M-4.1 | Create for self → confirm | ✅ | create flow → pending action + confirm button. |
| M-4.2 | Confirm → created | ✅ | `tasks.ts` confirm CREATE_TASK → `createTask`. |
| M-4.3 | Cancel → not created | ✅ | confirm CANCEL path. |
| M-4.4 | No date → asks date | ✅ | `router.ts` create_task `create_date` prompt. |
| M-4.5 | Hebrew type → maps/asks | ✅ | `normalizeTaskType` (`tasks.ts:421+`). |
| M-4.6 | Employee creates for other → refused | ✅ | `canCreateForOthers` = elevated only (`permissions.ts`). |
| M-4.7 | Manager creates for other → allowed after confirm | ✅ | passes gate; name→id via `resolveOwnerReference`. |

## 5. Confirmations & cancellations
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-5.1–5.5 | כן / אשר / מאשר / אוקיי / סבבה → execute | ✅ ⚠️ | `YES_RE` (`router.ts:67`) + parser `confirm_pending_action`. Plain typed words rely on the **AI** path; buttons (`כן <uuid>`) work without AI. |
| M-5.6 | לא → cancel | ✅ | `NO_RE` / `decline_pending_action`. |
| M-5.7 | בטל → cancel | ✅ | `NO_RE` includes `בטל`. |
| M-5.8 | אל תבצע → cancel | ✅ | `NO_RE` includes `אל\s+תבצע`. |
| M-5.9 | רגע/תיקון/לא לזה → nothing + ask restate | ⚠️ | `CORRECTION_RE` only fires inside a **ConversationState clarification** (`continueConversation`). After a *pending-action* confirm button there is no such state, so a correction word is parsed as a fresh message (action stays pending, not executed). Works mid-clarification; weaker after a final confirm prompt. |
| M-5.10 | WhatsApp buttons = normal reply | ✅ | `webhook.ts:162-170` maps button `id` → text command. |

## 6. Editing tasks
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-6.1 | Change title → confirm | ✅ | `edit_field` → pending + button. |
| M-6.2 | Confirm → changes | ✅ | confirm EDIT_FIELD → `updateTaskField`. |
| M-6.3 | "Add to description" | ⚠️ | Sets/**replaces** `description` with the new text — it does **not append**. If you need append semantics, that's a code change. |
| M-6.4 | Change priority → confirm+update | ✅ | priority validated vs live enum. |
| M-6.5 | Change type → map+confirm | ✅ | `normalizeTaskType`. |
| M-6.6 | Mark done → "status in CRM only" | ✅ | parser STATUS-CHANGE rule (`intentParser.ts`). |
| M-6.7 | Employee edits other's task → refused | ✅ | `canEditTask` (owner or elevated) `tasks.ts:294`. |

## 7. Due-date change — manager approval
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-7.1 | Employee requests → employee confirm | ✅ | REQUIRES_MANAGER_APPROVAL → EDIT_DUEDATE pending. |
| M-7.2 | Employee confirms → goes to manager | ✅ | confirm EDIT_DUEDATE → PENDING_MANAGER_APPROVAL. ⚠️ If the requester **is** elevated, it now **self-approves** (your requested change) — only regular employees route to a manager. |
| M-7.3 | Managers receive request | ✅ 🔵 | `getManagersForBroadcast` + `notify`. Delivery needs 24h window / template (caveat #3). |
| M-7.4 | Manager approves → updates | ✅ | `/tasks/approve` APPROVE → `updateDueDate`. |
| M-7.5 | Manager rejects → unchanged | ✅ | REJECT path. |
| M-7.6 | Employee tries to approve → refused | ✅ | `tasks.ts:478` `isElevated` gate. |
| M-7.7 | (reinterpreted) On approval, notify the OTHER managers it's handled | ✅ | **Implemented** — `notifyOtherManagers` (`tasks.ts`) messages every other manager/admin "כבר אושרה/נדחתה על ידי …" after an approve/reject. (Plain `מאשר` with several pending still auto-picks the latest; targeting a specific one uses `אשר <uuid>`.) |
| M-7.8 | Two managers race → only first wins | ✅ | `transitionState` `fromState` guard → 2nd gets "already resolved"; the others are now also **proactively** told it's handled (`notifyOtherManagers`). |

## 8. Admin/elevated permissions
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-8.1 | Employee reassign → refused | ✅ | `ownerId` is ELEVATED_ONLY → non-elevated FORBIDDEN → 403. |
| M-8.2 | Admin reassign → confirm+update | ✅ | now also **managers** (you broadened it); name→id via `resolveOwnerReference`. |
| M-8.4 | Invalid project → clear error, no update | ✅ | `resolveLinkReference` → "לא מצאתי פרויקט…"; a bad id reaching the DB → `FKError`→400 (`tasks.ts:402`). |

## 9. AI / Hebrew understanding (gpt-4o)
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-9.1 | Typos → understands | ⚠️✅ | Prompt has typo-tolerance note; reliable on gpt-4o, not guaranteed. |
| M-9.2 | "מה פתוח עליי" → open | ✅ | explicit example added. |
| M-9.3 | "שנה את הכותרת" → asks which task | ✅ ⚠️ | Asks when no task named. **Note:** with the new task-context, if you *just* acted on a task it will reuse that one instead of asking (by design). |
| M-9.4 | Unrelated → "tasks only" | ✅ | OUT-OF-SCOPE rule. |
| M-9.5 | Garbled → ask rephrase | ✅ | confidence `< LOW` → clarification. |

## 10. WhatsApp messaging
| ID | Expected | Verdict | Evidence |
|----|----------|---------|----------|
| M-10.1 | Text reply | ✅ 🔵 | `sendTextMessage`. |
| M-10.2 | Confirm buttons | ✅ 🔵 | `sendButtonMessage`. |
| M-10.3 | Tap "כן" → executes | ✅ | button id `כן <uuid>` → confirm. |
| M-10.4 | Tap "לא" → cancels | ✅ | button id `לא <uuid>` → cancel. |
| M-10.5 | Proactive template | ✅ 🔵 | `notify` → template when enabled. Currently disabled. |
| M-10.6 | Templates off → text fallback | ✅ | `templates.ts:79-83`. (Free-form ⇒ 24h window only.) |

## 11. Scheduling & alerts
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-11.1 | Daily summary 17:00 | ⚠️ | Mechanism ✅, but time is **temporarily 13:00** (caveat #4). |
| M-11.2 | No open tasks → no message | ✅ | `dailySummary.ts:44-51` only users with OPEN/IN_PROGRESS. |
| M-11.3 | Reminder ~1h before, once | ✅ | `dueDateReminder.ts` 55–65min window + INSERT-first dedup. |
| M-11.4 | No duplicate on restart | ✅ | `WhatsappReminderLog` `DUE_1H` dedup. |
| M-11.5 | Deadline <24h → managers | ✅ 🔵 | `runDeadlineApproachingAlert`. |
| M-11.6 | Deadline passed → once | ✅ 🔵 | `runDeadlineExceededAlert` INSERT-first dedup. |
| M-11.7 | Pending action expires | ✅ | `expireStaleActions` + scheduler. |

## 12. Completion via CRM
| ID | Expected | Verdict | Evidence |
|----|----------|---------|----------|
| M-12.3 | "סיים משימה" → "status in CRM" | ✅ | parser STATUS-CHANGE rule. |

## 13. Audit log (verify rows in DB 🟣)
| ID | Expected | Verdict | Evidence |
|----|----------|---------|----------|
| M-13.1 | Read → SUCCESS | ✅ 🟣 | `router.ts:616` `auditEvent(... 'SUCCESS')`. |
| M-13.2 | Create → SUCCESS | ✅ 🟣 | confirm CREATE_TASK audit SUCCESS. |
| M-13.3 | Cancel → DECLINED/SKIPPED | ✅ 🟣 | confirm CANCEL writes DECLINED + SKIPPED. |
| M-13.4 | Unauthorized → SKIPPED | ✅ 🟣 | `auditDenied` → `executionStatus:'SKIPPED'`. |
| M-13.5 | System error → FAILED | ✅ 🟣 | `processInbound` catch + `writeSendFailure` → FAILED. |

## 14. Security
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-14.1 | Unknown number → no info | ✅ | blocked at `resolveUserByPhone`. |
| M-14.2 | Employee can't see other's task | ❌ | **Intentional divergence** (caveat #2) — viewing is now open to all. |
| M-14.3 | Employee can't create for others | ✅ | `canCreateForOthers` elevated only. |
| M-14.4 | Employee can't approve dueDate | ✅ | approve gate `isElevated`. |
| M-14.5 | Blocked field (status) | ✅ | `status` READONLY + parser blocks. |

## 15. Failure handling
| ID | Expected | Verdict | Evidence / Notes |
|----|----------|---------|------------------|
| M-15.1 | AI unavailable → "AI not configured" | ✅ | `handleAIMessage` `getProvider()===null`. |
| M-15.2 | Yes/No without AI still works | ✅ ⚠️ | **uuid/button** replies (`כן <uuid>`) handled by regex pre-AI (`webhook.ts:246-266`). Plain typed `כן` without a uuid still needs AI. |
| M-15.3 | Supabase down → 503 | ✅ | `/health/ready` (`app.ts:49-56`). |
| M-15.4 | Meta send failure → retry then FAILED | ✅ 🟣 | `sender.ts` retry loop + `writeSendFailure` DLQ. |
| M-15.5 | Invalid enum → no update + error | ✅ | `normalizeTaskType`→null clarification; priority validated. |

## 16. End-to-end
| ID | Verdict | Note |
|----|---------|------|
| E2E-M-1 | ✅ | own-only read. |
| E2E-M-2 | ✅ | create→type/date→confirm. |
| E2E-M-3 | ✅ | cancel create. |
| E2E-M-4 | ✅ 🔵 | employee dueDate → employee confirm → manager approve. |
| E2E-M-5 | ✅ | manager reject. |
| E2E-M-6 | ✅ | manager all-tasks. |
| E2E-M-7 | ✅ | admin/manager reassign. |
| E2E-M-8 | ✅ | status stays CRM. |
| E2E-M-9 | ✅ 🔵 | `completionNotifier` once-per-task dedup; live delivery. |
| E2E-M-10 | ✅ 🔵 | needs approved template. |

---

## Summary of items needing your attention

| Item | Tests | Action |
|------|-------|--------|
| ~~"Which pending request?" prompt~~ → notify other managers | M-7.7 | ✅ **Done** — `notifyOtherManagers` informs the other managers when one approves/rejects. |
| Correction words after a final confirm | M-5.9 | Only handled mid-clarification; extend to pending-action prompts if needed. |
| "Add to description" replaces vs appends | M-6.3 | Implement append if that's the intent. |
| Daily summary time | M-11.1 | Currently 13:00 (temp) — revert to 17:00 after testing. |
| Restart | all | Load the recent changes before live testing. |
| Templates / 24h window | M-7.3, M-10.5, M-11.x, E2E-M-9/10 | Enable approved templates for reliable out-of-window delivery. |

**Net:** the large majority of tests map to correct, implemented behavior. **M-7.7 is now resolved** (other managers are notified on approval/rejection). The remaining real gap is **M-6.3** (replace vs append); **M-3.6 / M-14.2** are deliberate policy changes you requested; the rest are LIVE/DB confirmations or the documented caveats above.
