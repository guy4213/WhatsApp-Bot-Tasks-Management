# Rollback — Green API → Meta Cloud API

The Green API swap (PR#2) is a **transport‑only** change behind `sender.ts`. No
business logic (`ai/`, `routes/tasks*`, `auth/`, `utils/`, `scheduler/`) knows
which transport is active. Rolling back to Meta is therefore a **single env var**.

---

## 1. The one change

```
WHATSAPP_PROVIDER=meta
```

Set it and restart. `getProvider()` now returns the Meta provider, and every send
goes back through the Meta Cloud API exactly as it did before PR#2. That's the
whole rollback. Make sure the Meta credentials are still present (they live in
`.env` §2): `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`. `preflight.ts` re‑requires these
(and stops requiring the `GREENAPI_*` vars) the moment the provider is `meta`.

The Meta inbound webhook (`POST /webhook`) was never removed and needs no
reconfiguration — Meta calls it directly. The Green API route
(`POST /greenapi/webhook`) simply stops receiving traffic.

---

## 2. Do NOT touch `WHATSAPP_TEMPLATES_ENABLED`

Leave it exactly as it was. Template delivery is gated on the **provider's**
`supportsTemplates`, not on your intervention:

- Under `greenapi`, `supportsTemplates = false` → `notify()` forced every
  proactive message onto the free‑form fallback path, regardless of the flag.
- Under `meta`, `supportsTemplates = true` → `notify()` returns to honoring
  `WHATSAPP_TEMPLATES_ENABLED` and sending real approved templates, automatically.

So flipping the provider back to `meta` **restores template behavior on its own.**
Touching `WHATSAPP_TEMPLATES_ENABLED` during rollback only risks drift.

### NotificationKeys that resume real templates under Meta

When `WHATSAPP_PROVIDER=meta` **and** `WHATSAPP_TEMPLATES_ENABLED=true`, these keys
(canonical names in `src/whatsapp/templateNames.ts`) send Meta‑approved templates
again for out‑of‑window messages:

```
DUEDATE_APPROVAL_REQUEST      DUEDATE_APPROVED           DUEDATE_REJECTED
DUE_REMINDER                  DEADLINE_EXCEEDED          DEADLINE_APPROACHING
DAILY_SUMMARY                 TASK_COMPLETED             REQUEST_EXPIRED
REQUEST_EXPIRED_MANAGER       EMPLOYEE_MORNING_DIGEST    MANAGER_MORNING_DIGEST
EMPLOYEE_END_OF_DAY_REPORT    MANAGER_END_OF_DAY_REPORT  CUSTOMER_WORKER_EN_ROUTE
OWNTRACKS_PROVISIONING
```

(While `WHATSAPP_TEMPLATES_ENABLED=false`, Meta still sends these as in‑window
free‑form text — the pre‑PR#2 behavior. Nothing changes there.)

---

## 3. What auto‑reverts (no action needed)

- **Greeting + menu merge.** `webhook.ts` coalesces the daily greeting and the
  auto‑opened menu into one message only when the provider is `paced`. Meta is
  not paced, so under Meta the greeting and menu go back to being two separate
  sends — the original UX — automatically.
- **Numbered menus / `PendingChoice`.** Under Meta, buttons and lists are native
  interactive messages again; the `PendingChoice` translation layer is never
  written or read. No cleanup required for correctness.

---

## 4. `PendingChoice` table — safe to leave

Migration `019_pending_choice.sql` is **additive and inert under Meta** (nothing
writes or reads it). Leave it in place — no rollback migration is needed.

If you want to tidy up the now‑unused rows, this is **optional** and can run any
time:

```sql
-- Optional cleanup only. Not required for rollback correctness.
DELETE FROM "PendingChoice";        -- clear rows
-- or, to remove the table entirely (only if you are sure you won't switch back):
-- DROP TABLE IF EXISTS "PendingChoice";
```

Rows also self‑expire (60‑min TTL enforced at read), so leaving them is harmless.

---

## 5. There is no outbound queue to drain

PR#2 deliberately added **no** `OutboundQueue`. Green API owns the send queue
server‑side (`delaySendMessagesMilliseconds`, 24 h retention). So there is no
local queue to flush, pause, or migrate on rollback — outbound simply switches
API endpoints. (The inbound `WhatsappInboundQueue` is shared by both transports
and is unaffected.)

---

## 6. One‑line summary

> Set `WHATSAPP_PROVIDER=meta`, keep Meta creds present, restart. Everything else
> reverts on its own. Don't touch `WHATSAPP_TEMPLATES_ENABLED`. Leave the
> `PendingChoice` table alone.
