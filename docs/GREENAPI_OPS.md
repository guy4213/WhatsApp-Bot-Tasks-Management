# Green API — Operations Guide (PR#2, temporary transport)

This is the operational runbook for running the bot on **Green API** (an
unofficial WhatsApp‑Web transport) instead of Meta Cloud API. It is a
**temporary** swap until Meta approval lands. Rollback is one env var — see
[ROLLBACK.md](./ROLLBACK.md).

Activate Green API with `WHATSAPP_PROVIDER=greenapi` (this is the default as of
PR#2). All the credentials and console settings below are required for it to work.

---

## 1. Mandatory Green API CONSOLE settings

These are set in the Green API console (<https://console.green-api.com>), **not**
in our `.env`. The bot does **not** throttle sends itself — Green API owns the
outbound queue.

| Setting | Value | Why |
|---|---|---|
| `delaySendMessagesMilliseconds` | **15000** | Paces outbound at 15 s/msg. This is the anti‑ban throttle. The bot relies on it — there is no local throttling. |
| `webhookUrl` | `https://<host>/greenapi/webhook` | Where inbound messages are delivered. |
| `webhookUrlToken` | *(a strong secret)* | Sent by Green API as `Authorization: Bearer <token>`. **Must equal** our `GREENAPI_WEBHOOK_TOKEN`. A mismatch → every webhook gets 404. |
| `incomingMessageReceived` | **ON** | The primary webhook the bot processes. |
| `stateInstanceChanged` | **ON** | Feeds the health-alert flow (§8). Without it, the poll at `*/5m` is the only signal — you lose real-time notification when the phone drops. |
| `outgoingMessageReceived` / status types | may stay OFF | The bot acks them 200 and ignores them; leaving them off reduces noise. |

Our matching `.env` (see `.env.example` §2b):

```
WHATSAPP_PROVIDER=greenapi
GREENAPI_ID_INSTANCE=...
GREENAPI_API_TOKEN_INSTANCE=...
GREENAPI_API_URL=https://api.green-api.com
GREENAPI_WEBHOOK_TOKEN=<same value as webhookUrlToken>
```

`preflight.ts` fails fast in production if any of `GREENAPI_ID_INSTANCE`,
`GREENAPI_API_TOKEN_INSTANCE`, `GREENAPI_WEBHOOK_TOKEN` is missing while
`WHATSAPP_PROVIDER=greenapi`.

---

## 2. New‑SIM warm‑up — the first 10 days

A brand‑new WhatsApp number on an unofficial transport is the single biggest ban
risk. For the **first 10 days** after registering the SIM:

- **Do not create groups.**
- **Add ≤ 20 new contacts per day.**
- **Start sending only the day AFTER the QR scan** — never blast on day 0.
- Keep volume low and human‑paced; let the number age.

## 3. Steady‑state volume

- **≤ 200 message recipients per day.** We have ~10 recipients (see §6), so we
  are an order of magnitude under this — not a concern at our scale.
- **Every worker must save the bot's number in their contacts.** WhatsApp‑Web
  transports are far more likely to be flagged when messaging numbers that have
  never saved you. This is a hard onboarding step, not a nicety.

## 4. Physical phone rules

The number lives on a real device. Treat it as infrastructure:

- **WhatsApp Business app only** (not consumer WhatsApp).
- **Do not move the account to another device**, and **do not re‑register** the
  number — either looks like a takeover and can trip a ban.
- Keep the phone **plugged into power** and on **stable Wi‑Fi**, always on.
- Don't use the phone for anything else.

---

## 5. Known issues — sequential sends cost +15 s each

Under Green API every outbound message is paced 15 s apart. So any code path that
sends **two messages back‑to‑back** to the same user makes them wait ~15 s
between the two. This is the **real UX pain** of the swap — far more than the
cron drain (§6).

**Decision (per plan): these are documented, NOT fixed in PR#2.** The list below
is concrete so the fix can be scoped later.

> **Note on the "~40 sites" estimate:** an earlier grep‑level estimate put this
> at ~40. On a full read of `src/ai/router.ts`, the **genuine** count of
> back‑to‑back double‑sends is **11** (below). The rest of the ~40 grep hits are
> **not** double‑sends: ~15 are `try { sendList } catch { sendText }` menu
> fallbacks (one message either way), and the manager sub‑menus already *merge*
> ack+menu into a single `sendTextMessage` (e.g. router.ts 5370, 5478, 5498,
> 5603, 5616, 5658) — that merge is exactly the Green‑API‑friendly pattern and is
> already applied there. There is also one systemic *multiplier* (`sendChunked`)
> that is separate from the 11.

### 5.1 Genuine sequential double‑send sites (`src/ai/router.ts`)

| # | Line(s) | What is sent (in order) | Trigger | Cost |
|---|---|---|---|---|
| 1 | **568–572** | full manager menu → then the routed digit's result | Manager types a lone digit `1‑9` with no active context (bare‑digit guard) — the whole menu is sent, then immediately superseded by the routed result | +15 s (menu send is wasted) |
| 2 | **581–585** | full worker menu → then the routed digit's result | Worker types a lone digit `1‑7` with no context (bare‑digit guard) | +15 s (menu send is wasted) |
| 3 | **695 + 699** | clarification/caveat text → then the query result list | High‑confidence list/query intent that also carried a `clarification` (`management_snapshot`, `list_open_exceptions`, `list_pending_leads`, `workers_day_overview`, `list_today_field_inspections`, `search_task`) | +15 s |
| 4 | **1804 + 1810–1815** | team‑overview pulse → then **one message per worker** | Manager lists tasks grouped by owner (`scope:'all'` or >1 owner) — this is **1 + N** messages | +15 s × N |
| 5 | **3147 + 3149** | day‑summary text → then the 4‑option follow‑up menu | Worker day summary (menu item 7 / `day_summary_query`) | +15 s |
| 6 | **3309 + 3310** | "☀️ סיכום הבוקר הופעל." ack → then settings re‑render | Digest settings, choice 1 (enable morning) | +15 s |
| 7 | **3314 + 3315** | "☀️ סיכום הבוקר כובה." ack → then settings re‑render | Digest settings, choice 2 (disable morning) | +15 s |
| 8 | **3323 + 3324** | "🌆 דוח סוף היום הופעל." ack → then settings re‑render | Digest settings, choice 4 (enable evening) | +15 s |
| 9 | **3328 + 3329** | "🌆 דוח סוף היום כובה." ack → then settings re‑render | Digest settings, choice 5 (disable evening) | +15 s |
| 10 | **3362 + 3363** | "✅ שעת … עודכנה" ack → then settings re‑render | Digest settings — after setting a digest time (`handleDigestTimeReply`) | +15 s |
| 11 | **5943 + 5948** | task‑field detail card → then the 4‑action list menu | Manager opens a task‑field row (today / exceptions / search / my‑inspections) → `showMgrTaskFieldDetail` (the `catch` at 5956 already merges into one text) | +15 s |

Cheapest wins if/when we fix: sites **6–10** (digest settings) and **11**
(manager detail) are pure "ack + re‑show menu" — one string concat each merges
them, same pattern the manager sub‑menus already use. Sites **1–2** waste a full
menu send before the routed result. Sites **3–4** are "note/overview then data"
and are more inherent.

### 5.2 Systemic multiplier — `sendChunked` (router.ts 330–348)

`sendChunked` splits any body over ~3500 chars into multiple `sendTextMessage`
calls. It backs essentially every list render (manager query lists, today /
my‑inspections, exceptions/leads/workers/search, EOD reports). For short lists
it's a single message; for long lists it's **2+ messages, each +15 s**. Site #4's
per‑worker loop runs through it, so it compounds. Not a fixed count — it scales
with list length.

---

## 6. Recipient count & cron "drain" time

**What "drain" means:** a proactive cron (e.g. the morning digest) hands all its
messages to Green API in a quick burst; Green API then *releases* them 15 s apart.
So the **last** recipient is served ~`(N − 1) × 15 s` after the first. Our cron
finishes fast; the user‑visible delivery drains over that window.

**Formula:** `drain ≈ (N − 1) × 15 s ≈ N × 15 s`, where `N` = number of proactive
recipients (active users with a phone).

**The recipient universe** (active users with a phone number) is exactly:

```sql
SELECT count(*) FROM "User"
WHERE upper(status::text) = 'ACTIVE' AND phone IS NOT NULL AND phone <> '';
```

> ⚠️ **Run this against production to get the real N.** It could not be run from
> the PR build environment (an ephemeral clone with no production DB
> credentials). Plug the result into the table below.

| N (recipients) | Drain `(N−1)×15 s` | ≈ minutes |
|---|---|---|
| 10 | 135 s | **~2.3 min** |
| 13 | 180 s | ~3.0 min |
| 16 | 225 s | ~3.75 min |
| 22 (old estimate) | 315 s | ~5.25 min |

At our real scale (~10 field workers; a few more once managers / Yoram / Sasha
are counted) this is **~2.5–4 minutes**, *not* the 8–11 minutes previously
estimated for 22 recipients. The drain is a non‑issue; §5 (per‑step +15 s) is the
real cost.

---

## 7. Ops health alerts — "the phone died"

Because Green API rides on a physical phone, silent failures are the biggest
class of production incidents: the phone gets killed by Android battery
optimization, Wi-Fi drops, WhatsApp Business is force-stopped, or WhatsApp
itself hangs up the session (yellowCard / notAuthorized). From the code's
point of view everything looks fine — `sendMessage` returns 200 and the
message queues up on Green API's server for up to 24h before being dropped.

The bot surfaces this via two paths:

1. **Webhook** (`stateInstanceChanged`) — near real-time. Requires the console
   setting in §1. Handled by `src/routes/greenapiWebhook.ts` and dispatched to
   `services/greenapiHealth.ts`.
2. **Poll** (`GET /getStateInstance`) — every 5 minutes from the scheduler
   (`src/scheduler/jobs/greenapiHealthCheck.ts`, advisory lock 1013). Runs
   even if the webhook is off. Alerts on transitions out of `authorized`.

Both funnel through `handleGreenApiStateChange` for dedup:

- Alert on transition `authorized → anything_else`.
- Alert again if the specific bad state changes (`notAuthorized → blocked`).
- Re-alert every 30 min while the state stays bad ("still broken" reminder).
- Alert once on recovery (`bad → authorized`).
- Transient network errors from the poll are silent (no alert on 500s).

**Recipients** are resolved by `User.name` from the DB — see
`OPS_ALERT_NAMES` in `src/services/specialUsers.ts`. Intentionally narrower
than the exceptions-viewer set: this is dev/ops noise, not CEO-facing signal.
Yoram is NOT included by design.

**Known limitation.** The alert itself goes through the SAME Green API
transport that's failing. If Green API is fully down, the alert may not
deliver in real time either — it will queue and deliver when the transport
recovers. This is documented, not fixed; a truly independent channel (SMS,
email, PagerDuty) is a future upgrade if the failure rate justifies it.

**Not currently alerted on.**
- HTTP-level errors from `sendMessage` (400/500 back to us). These already
  route through the standard httpDelivery retry/DLQ path.
- Instance quota exceeded (a specific 466 response). Would be a useful
  addition; not built yet.

---

## 8. Plan to reduce the delay

After one clean week on Green API with no ban flags:

- Lower `delaySendMessagesMilliseconds` from **15000 → 7000** in the Green API
  console. This roughly halves both the drain (§6) and every per‑step penalty
  (§5).
- This is a **console setting change, not a code deploy.** No PR, no restart.

Do not lower it before a clean week, and never below Green API's supported floor.
