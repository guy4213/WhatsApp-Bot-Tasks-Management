# Customer Tracking Page — MVP plan

**Status:** DRAFT — awaiting user approval before any code / migration / deploy.
**Predecessor:** `docs/LIVE_TRACKING_PLAN.md` (backend foundation, applied
2026-07-08). Backend is verified live: OwnTracks pings land, worker mapping
resolves, TrackingSession opens on "יצאתי", `GET /tracking/:token` returns
JSON, "הגעתי" flips to ARRIVED, "סיימתי" hides coordinates.

**Scope of this step:** a single-page Galit-branded customer tracking page,
served by the same Fastify app. Consumes the existing JSON contract. No new
backend data. No new migration. No customer WhatsApp sending yet.

**Model recommendation** (CLAUDE.md §3): **Sonnet** — one new route, one
inline HTML/CSS/JS template, Leaflet from CDN, isolated tests. Nothing in
`router.ts`, nothing in the scheduler, no DB writes. Switch with
`/model <name>`, or say "go".

---

## 1. What exists today

### 1.1 The backend contract (unchanged)

- `GET /tracking/:token` — `src/routes/tracking.ts`
  - Public, `Cache-Control: no-store`.
  - Token whitelist regex `^[A-Za-z0-9_-]{16,64}$` — bogus paths never touch DB.
  - Unknown / malformed → 404 `{"error":"Not found"}` (no existence leak).
  - Body from `getPublicView` in `src/services/tracking.ts`:

    ```jsonc
    {
      "status":          "ACTIVE" | "ARRIVED" | "FINISHED"
                       | "CANCELED" | "EXPIRED" | "SUPERSEDED",
      "taskFieldStatus": "ASSIGNED" | "CONFIRMED" | "EN_ROUTE"
                       | "ARRIVED" | "FINISHED_FIELD" | "…",
      "updatedAt":       "2026-07-08T09:00:00Z",
      "lastLocation":    { "lat": 32.08, "lng": 34.78,
                           "at": "2026-07-08T09:00:00Z",
                           "accuracy": 15 },  // ONLY when ACTIVE|ARRIVED
      "etaMinutes":         25,               // ONLY when ACTIVE
      "expectedArrivalAt":  "2026-07-08T09:25:00Z"  // ONLY when ACTIVE
    }
    ```

  - Terminal statuses (`FINISHED`/`CANCELED`/`EXPIRED`/`SUPERSEDED`) already
    strip `lastLocation` / `etaMinutes` in the service. Lazy expiry on read
    when `now() > expiresAt`.
  - No internal ids (`taskFieldId`, `workerUserId`, `publicToken`) ever appear
    in the payload — verified by test `tracking.test.ts`.

- `GET /tracking/debug/sessions` — `x-internal-secret` guarded. Unchanged.

### 1.2 Frontend / static-asset infrastructure

- **None.** No `@fastify/static`, no `@fastify/view`, no template engine
  installed. No `public/` or `static/` folder. Zero HTML in the repo.
- Rate limit: `@fastify/rate-limit` at 100 req/min per IP, `127.0.0.1`
  allowlisted (`src/app.ts:23`). At a 12-second poll, one customer = 5 req/min.
  Fine for MVP.
- Render config not in-repo (no `render.yaml`, no `Procfile`) — deploys are
  dashboard-driven. The MVP page adds one Fastify route on the existing
  server → nothing changes on Render.

### 1.3 What the plan explicitly does NOT change

- `GET /tracking/:token` JSON contract — untouched. Any internal or QA client
  that hits it today keeps working the same way.
- Backend services (`tracking.ts`, `workerLocation.ts`) — no changes.
- Router / scheduler / DB — no changes.
- No new migration, no `TrackingSession` schema change.

---

## 2. Proposed route structure

Recommendation: **Option 1 from the brief — separate routes, no content
negotiation.**

```
GET /tracking/:token   → application/json  (existing; UNCHANGED)
GET /t/:token          → text/html         (new; customer page)
```

Why `/t/:token` rather than `/track/:token`:
- Shorter link — matters for WhatsApp / SMS forwarding.
- Zero collision risk with `/tracking/*` internal debug paths.
- Same token space + same regex whitelist, so validation stays trivial.
- Any customer who accidentally types `/tracking/:token` still gets valid JSON
  — not broken UX, just raw JSON.

Why NOT content negotiation:
- `Accept` headers vary across WhatsApp in-app browser, mobile Safari, and
  desktop. Deterministic paths are easier to reason about and test.

Why NOT flipping `/tracking/:token` to HTML by default:
- Breaks the QA tooling that already relies on the JSON contract (verified
  live on 2026-07-08).
- We can revisit if we ever want a single vanity URL. Not now.

The customer link the bot will eventually send:
`https://<render-host>/t/<publicToken>` — 34–66 characters including host.

---

## 3. Proposed UI / page states

All copy in Hebrew, RTL, mobile-first, no login. One page, one JS module,
one CSS block — all inline in the served HTML so the customer sees the page
in one request round-trip.

### 3.1 ACTIVE  (worker en route)

- **Hero band** (top, brand color): "הבודק בדרך אליך".
- **ETA card:**
  - Large: "הגעה משוערת: **09:25**" (from `expectedArrivalAt`, formatted in
    the customer's local timezone; the page uses the browser's timezone).
  - Small: "בעוד כ־25 דקות" (from `etaMinutes`).
- **Last update line:** "המיקום עודכן לפני X שניות/דקות" (relative time,
  updated by a 1s tick even between polls).
- **Map card:** Leaflet map centered on `lastLocation`, one marker with the
  Galit brand color. Zoom 14 by default.
- **Footer:** Galit logo / company name, small privacy note (no phone
  numbers).

### 3.2 ARRIVED  (worker at site)

- Hero: "הבודק הגיע לאתר".
- ETA card → replaced by "הבודק בשטח" text + a subtle checkmark.
- Map card → still shown once, at the arrival location, but visually
  de-emphasized (gray marker); "עודכן לאחרונה" continues to update.
- Polling **slows** to 60 s (nothing dramatic will happen from here on).

### 3.3 FINISHED

- Hero: "הבדיקה הסתיימה. תודה!".
- No map, no ETA, no last-updated. Just a warm final message.
- Polling **stops** entirely.

### 3.4 CANCELED  or  EXPIRED  or  SUPERSEDED

- Hero: "המעקב אינו פעיל".
- Body: "עדכון חי אינו זמין כרגע. אם עולה שאלה — פנה אלינו בטלפון המשרד."
  (no phone number embedded — brand only).
- No map, no ETA.
- Polling **stops**.

### 3.5 404 / bad token

- Standalone friendly page: "הקישור אינו תקף".
- Same visual shell (header + footer). No mention of what a valid token
  looks like. HTTP status `404`.

### 3.6 Network error / repeated fetch failure

- Sticky small banner at the top: "מנסים לרענן…" (retry with backoff).
- The last successfully-fetched state stays visible underneath.

---

## 4. Proposed map approach

**Recommendation: option C — Leaflet + OpenStreetMap tiles.**

Comparison as requested:

| # | Option | Cost | Complexity | Reliability | Recommendation |
|---|---|---|---|---|---|
| A | No map yet | Free | Trivial | Perfect | Fallback if we hit trouble with C |
| B | Static-map link (open in external app) | Free | Trivial | Depends on external service | Rejected — external redirect breaks the "one clean page" UX |
| C | **Leaflet + OSM tiles** | Free (fair use) | Small (60 KB CSS+JS from CDN, ~30 lines to init) | Excellent for hobby / SMB traffic | **CHOSEN** |
| D | Google Maps JS API | Paid ($7 per 1k loads after free tier) | Requires API key management + billing | Excellent | Deferred — reconsider only if OSM tile usage becomes visible |

Why Leaflet + OSM for MVP:

- **No API key, no billing.** The customer link works forever with zero ops.
- **RTL-friendly.** Leaflet controls flip cleanly under `dir="rtl"`.
- **Small.** ~40 KB gzipped for `leaflet.js` + `leaflet.css` from unpkg CDN.
- **Works in WhatsApp in-app browser.** No autoplay quirks, no camera perms.
- **Legally safe** for our expected volume (well under OSM's "heavy user"
  threshold of 1 req/s). One customer polling every 12 s calls the OSM
  tile server only when they pan/zoom — the map itself is a small handful
  of tiles per view.

**Attribution requirement:** we must show "© OpenStreetMap contributors"
in the map corner (Leaflet does this automatically). Trivial to satisfy.

**Follow-up path** (NOT this PR): if OSM ever complains about volume, swap
to a paid tile provider (Mapbox / Maptiler) that keeps the Leaflet code
unchanged — one URL swap.

**Optional accuracy visualization:** draw a translucent circle around the
marker with radius = `lastLocation.accuracy` (meters). Only when accuracy
> 50 m, and label subtly as "מיקום משוער". This uses only data already in
the JSON payload.

---

## 5. Data contract from JSON to the frontend

The page consumes **exactly** what `getPublicView` returns today. No
backend changes. Explicit mapping:

| JSON field | UI use | Guardrail |
|---|---|---|
| `status` | Drives which UI state renders | Anything unexpected → "המעקב אינו פעיל" |
| `taskFieldStatus` | Not shown to customer directly (avoids exposing internal enum) | Only used for internal reasoning, never rendered as text |
| `updatedAt` | "עודכן לאחרונה לפני X" | Relative-time formatter, ticks every 1s |
| `lastLocation.lat`/`lng` | Map marker | Only used when session status is `ACTIVE`/`ARRIVED` |
| `lastLocation.at` | Precede "עודכן לפני" with the location's own timestamp when it differs from `updatedAt` | Same relative-time formatter |
| `lastLocation.accuracy` | Optional radius circle when > 50m | Never rendered as a raw number |
| `etaMinutes` | "בעוד כ־N דקות" | Only when `ACTIVE`; falls back if missing |
| `expectedArrivalAt` | "הגעה משוערת: HH:MM" | Only when `ACTIVE`; falls back if missing |

Explicitly **never** rendered / referenced in the frontend, even if the
JSON ever leaked them:

- `taskFieldId`, `workerUserId`, `publicToken`
- phone numbers, customer name, worker name, address
- accuracy / speed / battery as raw numbers
- raw OwnTracks payload

Defense-in-depth: the frontend hard-codes only the whitelisted keys. Any
future extra JSON key is ignored.

---

## 6. Files to add / change

New:

| File | Purpose |
|---|---|
| `src/routes/trackingPage.ts` | Fastify plugin: `GET /t/:token`. Fetches internal via `getPublicView` (imports `services/tracking`), embeds initial state into the HTML shell, returns `text/html; charset=utf-8` with `Cache-Control: no-store`. |
| `src/routes/trackingPage.template.ts` | Exports a single `renderTrackingPage(initialState, token)` function that returns the full HTML string with inline `<style>` and `<script>`. Keeping it in TS (not `.html`) lets us keep type safety on the initial-state shape and skip a build step. |
| `src/__tests__/trackingPage.test.ts` | Route-level behavioral tests. |

Edited:

| File | Change |
|---|---|
| `src/app.ts` | `await app.register(trackingPageRoutes);` next to `trackingRoutes`. |

Not touched:

- `src/routes/tracking.ts` (JSON contract untouched)
- `src/services/tracking.ts` (no shape change)
- `src/services/workerLocation.ts`
- Any migration, any router, any scheduler

No new npm dependencies. Leaflet loaded from a CDN via `<link>` and
`<script>` tags:

- `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` (SRI hash pinned)
- `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` (SRI hash pinned)

We pin **exact** versions + SRI hashes so a supply-chain change on unpkg
can't inject code into the customer page. If SRI is too fragile for CI,
fallback: self-host both files under a to-be-added `public/vendor/leaflet/`
via `@fastify/static`. **Recommendation: start with CDN + SRI, revisit if
we ever see integrity failures.**

---

## 7. Tests to add

Colocated with existing tests in `src/__tests__/`. Behavioral, per CLAUDE.md
§5.4 — assert what the page does, not that a function returned a string.

`trackingPage.test.ts` (Fastify inject; mocks `services/tracking`):

1. **Bad token** — malformed token → 404 with `Content-Type: text/html`.
   Body contains "הקישור אינו תקף". `getPublicView` not called.
2. **Unknown token** — well-formed but `getPublicView` returns null → 404
   HTML. Body must NOT reveal whether the token ever existed.
3. **ACTIVE state** — page includes `אליך` header text, embeds `etaMinutes`
   and lat/lng into the initial-state script tag, includes the Leaflet CDN
   `<link>` and `<script>` tags with SRI attributes, has `Cache-Control:
   no-store`.
4. **FINISHED state** — page includes "הבדיקה הסתיימה", **does NOT**
   include any `lat` / `lng` numeric values in the served HTML.
5. **CANCELED state** — page includes "המעקב אינו פעיל", no coordinates.
6. **No id leak** — for every state above, the served HTML must NOT contain
   the strings `taskFieldId`, `workerUserId`, `publicToken`, or the token
   itself echoed as an internal id. (The token appears as-is only in the
   JS constant used for polling — that's inevitable and safe.)
7. **RTL sanity** — served HTML has `<html dir="rtl" lang="he">`.

Not covered by unit tests (must be validated in manual QA below): actual
map render, poll behavior, Leaflet CSS.

---

## 8. Manual QA script

Run once against staging (or a local Render deploy pointed at Supabase).
Uses the existing tracking flow — no new manual seeding needed.

**Setup:**
- Worker phone `guy` with OwnTracks configured (already seeded).
- A TaskField assigned to worker `guy` in a near-term slot.
- A device / desktop browser to open the customer link.

**Steps:**

1. Worker sends "יצאתי" from WhatsApp → wait for session to open.
2. From Supabase SQL editor:
   `SELECT "publicToken" FROM "TrackingSession"
      WHERE "workerUserId" = '<guy id>' AND status = 'ACTIVE';`
3. Open `https://<host>/t/<publicToken>` in mobile Chrome/Safari + WhatsApp
   in-app browser + desktop Chrome. Expected:
   - Hebrew RTL, no login, no console errors.
   - Header "הבודק בדרך אליך".
   - ETA card with `expectedArrivalAt` in local time.
   - Map centered on worker location, one marker.
   - "עודכן לפני X שניות" ticks every second.
4. Wait 20 seconds. Poll fires ~10-15 s → "עודכן לפני" resets. If worker's
   phone moved, marker moves smoothly (`.setLatLng` re-center).
5. Kill worker's data connection for 60s. Page shows "מנסים לרענן…" banner;
   underneath, last known state stays visible.
6. Reconnect worker; wait for the next OwnTracks ping. Banner clears, poll
   resumes.
7. Worker sends "הגעתי". Within 15 s the customer page flips to "הבודק הגיע
   לאתר", polling slows to 60 s, map de-emphasizes.
8. Worker sends "סיימתי". Customer page flips to "הבדיקה הסתיימה", polling
   stops, map disappears. Refresh the page manually — same view.
9. In DevTools > Network, confirm the page has `Cache-Control: no-store`
   AND the JSON polls do NOT include internal ids (grep for `taskFieldId`
   in the network tab).
10. Open a bogus token URL (`/t/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`). Expect
    a friendly 404 page, no leaked information.
11. Open the JSON endpoint directly (`/tracking/<publicToken>`) — must
    still return JSON as before (proves we didn't break it).

**Explicit non-goals for QA:** we do NOT test the customer WhatsApp send in
this iteration (not implemented yet).

---

## 9. Risks / questions

- **Q1 — Leaflet CDN vs self-host.** Recommend: CDN with SRI hash for MVP.
  Trade-off: fewer moving parts vs one external dependency. If you prefer
  self-host (adds `@fastify/static` + a `public/vendor/leaflet/` folder,
  ~40 KB in git), say so and I'll switch.
- **Q2 — Route path.** Recommending `/t/:token`. Alternative `/track/:token`
  is fine too — pick one and I'll wire it. Not changing `/tracking/:token`.
- **Q3 — Timezone display.** Recommending browser-local (`toLocaleTimeString`
  with `Asia/Jerusalem` fallback if the browser is elsewhere). Alternative:
  always Asia/Jerusalem regardless of the customer's device. Which do you
  prefer?
- **Q4 — Poll interval.** Recommending 12 s while ACTIVE, 60 s while ARRIVED,
  stop while terminal. Trade-off: shorter = livelier, longer = kinder to
  the OSM tile server if the customer pans. 12 s is well inside the
  100/min rate limit even with the map ticking.
- **Q5 — Accuracy circle.** Recommending: draw when `accuracy > 50 m`,
  label "מיקום משוער". OK, or skip entirely for MVP?
- **Q6 — Brand assets.** Do you have a Galit logo asset I can embed as an
  inline SVG or a PNG? If not, MVP will render just the brand name as text
  ("גלית ייעוץ סביבתי" or whatever the current copy is — confirm the
  exact string).
- **Q7 — Copy tone.** All the Hebrew strings above are my proposals. Any
  of them you want to phrase differently? Especially the 404 / CANCELED /
  EXPIRED copy.
- **Q8 — Auto-focus / accessibility.** OK to add `role="status"` +
  `aria-live="polite"` on the hero band so screen readers announce
  transitions? Small and safe.
- **Q9 — Public host.** What URL will Render serve this from? I'll use
  that for the token links + for the QA steps.

---

## 10. Clear recommendation — what to build first

**Ship this MVP in one small PR (one route + one HTML template + tests):**

1. Add `src/routes/trackingPage.ts` — `GET /t/:token` returning
   server-rendered HTML with initial state embedded in a `<script>`
   constant.
2. Add `src/routes/trackingPage.template.ts` — inline HTML/CSS/JS,
   Leaflet + OSM from CDN with SRI hashes.
3. Register the plugin in `src/app.ts`.
4. Add `src/__tests__/trackingPage.test.ts` — the seven behavioral tests
   in §7.
5. Run `npx tsc --noEmit` + `npx vitest run` — green.
6. Manual QA per §8.

Then deploy to Render (with approval), grab a real token, share the link.

**Only after** the customer page is verified working end-to-end, revisit
the deferred items **as separate proposals**, in this order:
1. Bot sends the customer a WhatsApp message on DEPARTED with the
   `/t/<token>` link (auto-token discovery from the just-opened session).
2. `expiresAt` cron sweep to move stale sessions to `EXPIRED` server-side.
3. Google Routes ETA (only if OSM-derived ETA isn't good enough).
4. Self-host Leaflet (only if the CDN causes trouble).
5. WebSocket push (only if 12-second polling feels laggy in practice).

---

## 11. Guardrails during implementation

- No Google Maps / Routes API calls.
- No WebSocket.
- No customer WhatsApp sending.
- No new migration, no DB writes, no scheduler job.
- No change to `GET /tracking/:token` JSON contract.
- No change to `services/tracking.ts`, `services/workerLocation.ts`, or
  `ai/router.ts`.
- No deploy without your explicit approval; no migration to apply since
  none is needed.
