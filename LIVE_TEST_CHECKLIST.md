# Manual Live-Test Checklist (WhatsApp / buttons / audit / cron / templates)

These require a **real WhatsApp number + Meta** and cannot be automated. Run after restarting the server with the go-live config. Mark each PASS/FAIL with the date, tester, and what the bot replied.

> Prereqs: server restarted; Cloudflare tunnel URL set as the Meta webhook callback; a known **active employee**, **manager**, **admin**, **inactive**, and **unknown** number; at least one open task per tester for summary/reminder tests.

## A. Inbound / identity
- [ ] **A1** Active employee sends "מה המשימות שלי להיום?" → bot replies with their tasks (not stuck).
- [ ] **A2** Unknown number sends any message → "המספר … אינו מזוהה כעובד פעיל".
- [ ] **A3** Inactive user sends a message → "המשתמש שלך אינו פעיל".
- [ ] **A4** First message of the day → greeting by name appears once.

## B. WhatsApp messaging & buttons
- [ ] **B1** Any reply → arrives as a normal WhatsApp text (M-10.1).
- [ ] **B2** Create/edit a task → a **כן / לא** button message arrives (M-10.2).
- [ ] **B3** Tap **כן** → action executes (M-10.3 / M-5.10).
- [ ] **B4** Tap **לא** → action cancels (M-10.4).
- [ ] **B5** Typed confirmations execute: `כן`, `אשר`, `מאשר`, `אוקיי`, `סבבה` (M-5.1–5.5).
- [ ] **B6** Typed cancels work: `לא`, `בטל`, `אל תבצע` (M-5.6–5.8).

## C. Create / edit / view
- [ ] **C1** "צור לי משימה להתקשר לדני מחר ב-10" → asks confirm → on כן, task created.
- [ ] **C2** "צור לי משימה להתקשר לדני" (no date) → bot asks for a date.
- [ ] **C3** Regular employee "צור משימה ליוסי" → refused (permissions).
- [ ] **C4** Manager "צור משימה ליוסי …" → allowed after confirm.
- [ ] **C5** "שנה את הכותרת של המשימה X ל-Y" → confirm → title changes.
- [ ] **C6** Follow-up "עכשיו תשנה עדיפות לגבוהה" (no task named) → applies to the **same** task X.
- [ ] **C7** "סמן את המשימה כבוצעה" → "סטטוס מנוהל ב-CRM".
- [ ] **C8** Regular employee edits a task that isn't theirs → "אפשר לערוך רק את המשימות שלך".
- [ ] **C9** Get-task details shows the **description** field.

## D. dueDate approval flow
- [ ] **D1** Employee "דחה את המשימה … ליום ראשון" → bot asks employee to confirm.
- [ ] **D2** Employee taps כן → **managers receive an approval request** (check a manager's WhatsApp).
- [ ] **D3** Manager replies `אשר <id>` / taps approve → date updates; requester notified.
- [ ] **D4** Manager replies `דחה <id>` → date unchanged; requester notified.
- [ ] **D5** Regular employee tries `מאשר` → refused (manager/admin only).
- [ ] **D6** **Two managers** approve the same request → only the first succeeds; the others get "כבר אושרה/נדחתה על ידי …".
- [ ] **D7** **Manager/admin** changes a dueDate → executes immediately (no approval round-trip).

## E. Admin / reassign / relink
- [ ] **E1** Admin/manager "תעביר את המשימה ליוסי" → confirm → owner changes (name resolves to the right user; disambiguation if several).
- [ ] **E2** Relink to a customer/lead/project by name → resolves & links; bad name → clear "לא מצאתי …".
- [ ] **E3** Regular employee reassign → refused.

## F. Cron / scheduled (Asia/Jerusalem)
- [ ] **F1** Daily summary fires at **17:00**; only users **with open tasks** and a **phone** receive it.
- [ ] **F2** User with no open tasks → no summary.
- [ ] **F3** Task due in ~1h → owner gets a single reminder; restart before it fires → still no duplicate.
- [ ] **F4** Task due within 24h → managers get a "deadline approaching" alert.
- [ ] **F5** Overdue task → managers get a single "deadline exceeded" alert.
- [ ] **F6** Start a pending action and don't confirm → it expires after the TTL.
- [ ] **F7** Mark a task DONE in the CRM → managers get a single completion notice.

## G. Templates (after Meta approval)
- [ ] **G1** With `WHATSAPP_TEMPLATES_ENABLED=false`: an out-of-window proactive message does **not** arrive (expected).
- [ ] **G2** Register & approve the 10 templates (see `META_TEMPLATES.md`), set `=true`, restart.
- [ ] **G3** Trigger a proactive message to an **out-of-window** user → now arrives via template.

## H. Audit log (inspect `WhatsappAuditLog` in DB)
- [ ] **H1** After a list request → a row with `executionStatus=SUCCESS`.
- [ ] **H2** After creating a task → `SUCCESS`.
- [ ] **H3** After cancelling → `confirmationStatus=DECLINED` / `executionStatus=SKIPPED`.
- [ ] **H4** After an unauthorized attempt → `executionStatus=SKIPPED`, errorMessage `Unauthorized: …`.
- [ ] **H5** Simulate a send/DB failure → a `FAILED` row.

## I. Failure modes
- [ ] **I1** Stop the DB / wrong creds → `GET /health/ready` returns **503**.
- [ ] **I2** Unset `AI_PROVIDER` → bot replies "ה-AI אינו מוגדר"; but `כן <id>`/`לא <id>` button replies still work.
- [ ] **I3** Send an invalid task type → bot asks for clarification, no update.

---
**Sign-off:** all of A–F + H + I PASS, and G after templates are approved → ready for production traffic.
