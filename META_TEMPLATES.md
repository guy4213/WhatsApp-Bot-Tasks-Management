# WhatsApp Message Templates — for Meta approval

The bot's **proactive** messages (reminders, alerts, summaries, manager approvals) can only be delivered **outside the 24-hour customer-service window** via **pre-approved templates**. Until these are approved, `WHATSAPP_TEMPLATES_ENABLED=false` and those messages only reach users who are currently in-window.

## How to register
1. Meta **WhatsApp Manager → Account tools → Message Templates → Create template**.
2. **Category:** `Utility` · **Language:** `Hebrew (he)` (matches `WHATSAPP_TEMPLATE_LANG=he`).
3. Use the **exact name** in the table (the code's default), or override per-template with `WHATSAPP_TEMPLATE_<KEY>=your_name`.
4. Add the body **with `{{1}}…{{n}}` placeholders in the exact order listed** — the code fills them in that order (`src/whatsapp/templates.ts`).
5. After all are **Approved**, set `WHATSAPP_TEMPLATES_ENABLED=true` and restart.

> **Meta rules to respect:** a body may not **start or end** with a variable, and may not place **two variables adjacent** with no text between them. The bodies below already comply. The code strips newlines/tabs from variable values.

---

## The 10 templates

### 1. `daily_summary` — DAILY_SUMMARY
Vars: `{{1}}`=user name, `{{2}}`=open-task count
```
שלום {{1}}! סיכום יומי: יש לך {{2}} משימות פתוחות. שלח "המשימות שלי" לרשימה המלאה.
```

### 2. `due_reminder` — DUE_REMINDER
Vars: `{{1}}`=task title, `{{2}}`=time
```
תזכורת: המשימה "{{1}}" מגיעה למועדה בעוד כשעה, בשעה {{2}}.
```

### 3. `deadline_exceeded` — DEADLINE_EXCEEDED
Vars: `{{1}}`=manager name, `{{2}}`=count
```
שלום {{1}}, התראה: קיימות {{2}} משימות שעבר מועדן.
```

### 4. `deadline_approaching` — DEADLINE_APPROACHING
Vars: `{{1}}`=manager name, `{{2}}`=count, `{{3}}`=hours
```
שלום {{1}}, תזכורת: {{2}} משימות מתקרבות למועדן ב-{{3}} השעות הקרובות.
```

### 5. `duedate_approval_request` — DUEDATE_APPROVAL_REQUEST
Vars: `{{1}}`=requester, `{{2}}`=task title, `{{3}}`=new date, `{{4}}`=action id
```
{{1}} מבקש לשנות את מועד המשימה "{{2}}" ל-{{3}}. השב "אשר {{4}}" לאישור או "דחה {{4}}" לדחייה.
```

### 6. `duedate_approved` — DUEDATE_APPROVED
Vars: `{{1}}`=task title, `{{2}}`=new date, `{{3}}`=manager
```
מועד המשימה "{{1}}" שונה ל-{{2}} ואושר על ידי {{3}}.
```

### 7. `duedate_rejected` — DUEDATE_REJECTED
Vars: `{{1}}`=task title, `{{2}}`=manager
```
בקשתך לשינוי מועד המשימה "{{1}}" נדחתה על ידי {{2}}.
```

### 8. `task_completed` — TASK_COMPLETED
Vars: `{{1}}`=task title, `{{2}}`=owner
```
המשימה "{{1}}" של {{2}} סומנה כבוצעה במערכת.
```

### 9. `request_expired` — REQUEST_EXPIRED
Vars: `{{1}}`=task title
```
בקשתך לגבי המשימה "{{1}}" פגה ולא בוצעה. ניתן לשלוח אותה מחדש.
```

### 10. `request_expired_manager` — REQUEST_EXPIRED_MANAGER
Vars: `{{1}}`=requester, `{{2}}`=task title
```
בקשת {{1}} לגבי המשימה "{{2}}" פגה ללא טיפול.
```

---

## ⚠️ Not templated (free-form only — in-window delivery)
These newer proactive messages currently have **no template** and will only deliver in-window:
- "כבר אושרה/נדחתה על ידי …" — the *other managers* notification (`notifyOtherManagers`).
- The elevated **self-approval** confirmation for a dueDate change.

If out-of-window delivery matters for them, add template keys for these too (ask and I'll wire them in).
