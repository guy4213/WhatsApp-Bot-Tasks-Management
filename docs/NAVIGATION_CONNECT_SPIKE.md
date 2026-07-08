# Google/Waze Navigation Connect — Feasibility Spike

**Status:** RESEARCH ONLY — no code, no Cloud project, no billing enabled.
**Author:** Claude, per request 2026-07-08.
**Method:** Read the official Google Maps Platform documentation for
Navigation Connect API. Every non-obvious claim in this report cites its
source URL.

**One-line answer up front:** Navigation Connect is a real, documented,
purpose-built product that solves exactly the problem we described — worker
navigates in Waze/Google Maps, backend receives live trip telemetry — **but
it requires a NATIVE (or Universal-Link-capable) worker app to launch the
navigation with the trip token**. A plain WhatsApp link cannot start a
Navigation Connect trip. It is also Pre-GA (experimental) and its per-trip
pricing is NOT published — it's quote-only enterprise SKU. See §A for the
full executive conclusion.

---

## Sources (all quotes below cite one of these)

- **Overview** — <https://developers.google.com/maps/documentation/navigation/connect/overview>
- **Hub / setup landing** — <https://developers.google.com/maps/documentation/navigation/connect>
- **Setup overview & requirements** — <https://developers.google.com/maps/documentation/navigation/connect/setup-overview-requirements>
- **Launch Google Maps or Waze** — <https://developers.google.com/maps/documentation/navigation/connect/launch-navigation-app>
- **Handle trip data (Pub/Sub / polling)** — <https://developers.google.com/maps/documentation/navigation/connect/handle-trip-data>
- **CreateTrip REST reference** — <https://developers.google.com/maps/documentation/navigation/connect/create-trip>
- **Errors** — <https://developers.google.com/maps/documentation/navigation/connect/errors>
- **Location message schema** — <https://developers.google.com/maps/documentation/navigation/connect/reference/pubsub/rest/Shared.Types/Location>
- **Waze Transport SDK (different product)** — <https://developers.google.com/waze/intro-transport>
- **Maps Platform public pricing** — <https://mapsplatform.google.com/pricing/>
- **Maps Platform SKU pricing list** — <https://developers.google.com/maps/billing-and-pricing/pricing>

---

## A. Executive conclusion

**Can we implement Navigation Connect in this product?**
- **Yes technically.** The API is real and documented. It gives us
  server-side, near-real-time trip telemetry (location, ETA, remaining
  distance, remaining polyline, trip status) from the worker's Waze or
  Google Maps session, without asking the worker to install a custom
  navigation app.

**Can we do it without a native worker app?**
- **No.** The launch mechanism is prescriptive: on Android an `Intent`,
  on iOS a Universal Link. There is NO documented path from a plain
  `https://` link in WhatsApp to a valid Navigation Connect launch. The
  docs explicitly state: *"Navigation Connect works exclusively with the
  Google Maps and Waze mobile apps and doesn't support web browsers,
  CarPlay, or Android Auto."*
- The `action_token` / `external_trip_token` query parameters on the
  launch URLs would in theory be handled by the OS-level app links, but
  the docs are silent about launching those URLs from a browser tab, and
  in practice this is fragile at best (Chrome intent-URL sniffing) and
  not supported at worst.

**If not, what is the minimum wrapper required?**
- The smallest possible worker-side app that satisfies the API:
  1. **Android:** A trivial Android app that (a) handles a deep link from
     WhatsApp, (b) calls our backend to trigger `CreateTrip`, (c) fires
     the `Intent` to Google Maps/Waze with `action_token`, and (d)
     provides a `PendingIntent` for the "return to app" button.
  2. **iOS:** The same but as an iOS app with a registered Universal Link
     for the "return to app" behavior.
  - A **PWA is not enough** — PWAs cannot register PendingIntents or
    Universal Links the way native apps can. iOS also blocks arbitrary
    scheme deep-linking from web apps.
  - A **Flutter/React-Native shell** for both platforms is the smallest
    real path. Zero screens; just deep-link handler + intent fire +
    return callback.

**Is this suitable for MVP or only for later phase?**
- **Not for the current MVP.** Three separate hurdles:
  1. Native worker app required. That's a new build, sign, distribute
     pipeline for at least Android (and Play Store publishing or side-
     load).
  2. Product is **Pre-GA / experimental**. The overview page displays:
     *"Pre-GA products and features might have limited support, and
     changes to pre-GA products and features might not be compatible
     with other pre-GA versions."* Backwards-compatibility isn't
     guaranteed.
  3. Pricing is **not published**. Navigation Connect does NOT appear on
     the public Maps Platform SKU pricing list. The overview blog says
     "Navigation" enterprise SKUs are billed pay-as-you-go regardless of
     plan, but the actual dollar amount is quote-only. Real risk of a
     surprising ARR cost.
- **Recommendation for MVP:** stay with the current Wolt-lite direction
  (OwnTracks worker phone GPS + OSRM road routing + our own tracking
  page). Revisit Navigation Connect once (a) we have a native worker app
  for other reasons, and (b) the product goes GA and pricing is
  transparent.

---

## B. Required Google setup checklist

Everything documented AND everything the docs are silent about but a real
integration will need. Items marked ⚠ are unknowns / risks that require a
paid POC or a sales conversation to nail down.

| # | Item | Where confirmed |
|---|---|---|
| 1 | Google Cloud project | "Create and configure a Google Cloud project" — setup-overview-requirements |
| 2 | Billing account attached to project (required — enterprise SKU) | Implied by pricing page absence + Maps Platform norms |
| 3 | Enable the Navigation Connect API in the project | "Enable Navigation Connect API and verify your app" — setup-overview-requirements |
| 4 | ⚠ **App verification** — Google says "verify your app", details not on the public page | setup-overview-requirements landing; details behind a page we could not fetch |
| 5 | Service account with `roles/navigationconnect.tripCreator` or equivalent (name unconfirmed) | "Set up your service account to enable communication between your backend infrastructure and Google Maps or Waze" — setup-overview-requirements |
| 6 | Service-account JSON key OR Application Default Credentials on the backend | "Use Application Default Credentials (ADC) to obtain an access token" — create-trip reference |
| 7 | Android app: package name + SHA-1 signing cert fingerprint registered in Cloud project | Required for the launch `Intent` to be trusted per `androidAppId` in `CreateTrip` payload |
| 8 | iOS app: bundle identifier + Universal Link association file (`apple-app-site-association`) hosted on our domain | Required for the launch Universal Link + "return button" per `iosAppId` |
| 9 | Waze v5.15.5+ AND/OR Google Maps v26.14+ on the driver's device | overview: "Waze version 5.15.5 or higher, or Google Maps version 26.14 or higher" |
| 10 | Precise-location permission granted on the driver's device | errors: "enable precise location and accept the consent prompt" |
| 11 | Google Cloud Pub/Sub topic + push subscription pointed at our backend webhook (only if we want event-driven; polling `GetTrip` is the alternative) | handle-trip-data: "Google Cloud Pub/Sub" |
| 12 | ⚠ Regional availability confirmation for Israel — the overview flags EEA has different terms as of 2025-07-08. Israel status not confirmed by docs. | overview page mentions EEA-specific terms only |
| 13 | ⚠ Pricing agreement (quote-only) | pricing SKU list check: Navigation Connect NOT listed |
| 14 | Google Maps API key for the customer page's map rendering (optional; we can stay on Leaflet+OSM) | Not strictly required for Navigation Connect itself |

**No mention** in the docs of an approval / allowlist step ("Google
lets us in"), but the language "verify your app" and the fact that
pricing is quote-only strongly suggest there IS a sales/engagement step
in practice for pre-GA enterprise APIs. Confirm with Google before
counting on it.

---

## C. Recommended architecture (the "if we build it" flow)

Assumes the worker app exists (see §A). Green boxes are things we already
have; blue boxes are new.

```
    ┌───────────────────────────────────────────────────────────────┐
    │  Existing: TaskField + WhatsApp bot                           │
    └───────────────────────────────────────────────────────────────┘
                             │
       (1) worker sends "יצאתי" OR taps a WhatsApp button
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  NEW: bot posts a deep link like:                             │
    │        galitbot://trip/<workerStartToken>                     │
    │  (custom scheme + Universal Link on the worker app)           │
    └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  NEW: minimal worker app                                      │
    │  - resolves <workerStartToken> → calls our backend            │
    │  - user chooses Waze / Google Maps                            │
    │  - hits our backend "launch" endpoint                         │
    └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  BACKEND:                                                     │
    │  POST /v1/projects/PROJECT_ID/trips?tripId={ourTripId}        │
    │  body: { androidAppId, iosAppId, config:{                     │
    │    enablePubsub: true,                                        │
    │    enableRemainingRouteReporting: true,                       │
    │    enableHighFrequencyUpdates: false                          │
    │  }}                                                           │
    │  → response: { name, authToken:{ token, expireTime } }        │
    │  Save trip row (see §D).                                      │
    └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  Worker app fires the LAUNCH URL:                             │
    │  Google Maps → https://www.google.com/maps/dir/?api=1&        │
    │    destination=<latlng>&dir_action=navigate&                  │
    │    action_token=<trip token>                                  │
    │  Waze → https://waze.com/ul?ll=<latlng>&navigate=yes&         │
    │    external_trip_token=<trip token>                           │
    │  Via Android Intent (with PendingIntent) or iOS Universal     │
    │  Link (registered for our worker app).                        │
    └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  Driver approves the consent prompt (every 12 months).        │
    │  Trip state: NEW → ENROUTE.                                   │
    └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  BACKEND receives updates by:                                 │
    │  - Pub/Sub push → POST /webhooks/nav-connect/trip-update      │
    │    (default 60s, or 5s if enableHighFrequencyUpdates)         │
    │    OR                                                         │
    │  - GetTrip polling (fallback, higher latency)                 │
    │  Updates: state, execution.location, execution.               │
    │  remainingDuration, execution.remainingDistanceMeters,        │
    │  execution.remainingRoute + traffic (Waze only).              │
    │  Correlate by "name":"projects/<n>/trips/<uuid>" → our tripId │
    └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  Existing bot sends the customer:                             │
    │  "הבודק בדרך אליך — https://<host>/t/<customerToken>"        │
    │  (existing route from CUSTOMER_TRACKING_PAGE_PLAN)             │
    └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  Customer page reads our TrackingSession + FieldTrackingTrip  │
    │  and renders the Wolt-lite view with Waze polyline & traffic  │
    │  (when Waze), or Google Maps ETA + point (Maps has no route). │
    └───────────────────────────────────────────────────────────────┘
                             │
             Trip state → ARRIVED / SUSPENDED / FAILED / CLIENT_ERROR
                             │
                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  Backend closes FieldTrackingTrip + our existing               │
    │  TrackingSession. Customer link goes to "המעקב הסתיים".        │
    └───────────────────────────────────────────────────────────────┘
```

---

## D. Data model proposal

We extend the current schema rather than replace it.

**Keep as-is:** `TaskField`, `TrackingSession` (customer-facing token +
lifecycle), `WorkerLiveLocation` (used as a fallback source when Navigation
Connect isn't active — e.g., worker cancelled, no Waze/Maps, etc.).

**New table** `FieldTrackingTrip` — one row per Navigation Connect trip,
linked to a TrackingSession. Bot-owned. All fields nullable except
identity + status.

```sql
CREATE TABLE "FieldTrackingTrip" (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "trackingSessionId"       uuid        NOT NULL REFERENCES "TrackingSession"(id),
  "taskFieldId"             uuid        NOT NULL REFERENCES "TaskField"(id),
  "workerUserId"            text        NOT NULL REFERENCES "User"(id),

  "provider"                text        NOT NULL CHECK (provider IN ('WAZE','GOOGLE_MAPS')),
  "workerStartToken"        text        NOT NULL UNIQUE,        -- random, opens the worker app deep link
  "googleTripName"          text,                                -- "projects/PROJECT_NUM/trips/UUID"
  "googleAuthToken"         text,                                -- base64 auth token from CreateTrip
  "authTokenExpiresAt"      timestamptz,                         -- 12h TTL per docs
  "state"                   text        NOT NULL CHECK (state IN (
    'CREATED','WAITING_FOR_WORKER','NAVIGATION_LAUNCHED',
    'ENROUTE','ARRIVED','SUSPENDED','FAILED','CLIENT_ERROR',
    'COMPLETED','EXPIRED'
  )),

  -- destination (denormalized from TaskField for audit and closed-session read)
  "destinationLat"          double precision,
  "destinationLng"          double precision,
  "destinationAddress"      text,

  -- latest telemetry
  "lastLat"                 double precision,
  "lastLng"                 double precision,
  "remainingDurationSecs"   integer,
  "remainingDistanceMeters" integer,
  "traveledDistanceMeters"  integer,
  "etaAt"                   timestamptz,                          -- derived: now + remainingDurationSecs
  "remainingRoute"          jsonb,                                -- encoded polyline + trafficInformation (Waze)
  "lastUpdateAt"            timestamptz,
  "lastPayload"             jsonb,                                -- raw last Pub/Sub / GetTrip response, for debug

  -- lifecycle
  "createdAt"               timestamptz NOT NULL DEFAULT now(),
  "launchedAt"              timestamptz,
  "enrouteAt"               timestamptz,
  "arrivedAt"               timestamptz,
  "endedAt"                 timestamptz,
  "expiresAt"               timestamptz NOT NULL,                 -- ≤ authTokenExpiresAt

  -- errors
  "errorCode"               text,
  "errorMessage"            text,

  "updatedAt"               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_fieldtrackingtrip_active_per_session
  ON "FieldTrackingTrip"("trackingSessionId")
  WHERE state IN ('CREATED','WAITING_FOR_WORKER','NAVIGATION_LAUNCHED','ENROUTE');

CREATE INDEX ix_fieldtrackingtrip_googlename
  ON "FieldTrackingTrip"("googleTripName");    -- Pub/Sub payload correlation
```

**Reuse existing:**
- `TrackingSession.publicToken` — customer token, already served by
  `GET /tracking/:token` and `GET /t/:token`.
- `WorkerLiveLocation` — kept as a secondary source when a Navigation
  Connect trip is not open (e.g., "worker en route but declined to launch
  Waze") and for debug.

**Do NOT extend `TaskField`.** Trip telemetry is per-drive, not per-visit;
one TaskField might have multiple trips over its lifetime (worker aborts
and restarts, or two separate drive attempts).

---

## E. Backend service proposal (`src/services/navigationConnect.ts`)

Contract-first — no code yet. All functions return typed results, never
throw across the boundary.

```ts
export async function startTrip(taskFieldId: string, workerUserId: string,
                                provider: 'WAZE' | 'GOOGLE_MAPS'):
                                Promise<{ trip: FieldTrackingTrip; launchUrl: string }>;

// Wraps POST /v1/projects/PROJECT_ID/trips?tripId={ourTripId}. Uses ADC
// via google-auth-library. Persists the row and returns the launch URL
// the worker app should fire.

export async function handlePubSubUpdate(payload: PubSubEnvelope):
                                Promise<void>;

// Verifies the Pub/Sub push, decodes the wrapped Trip message, finds our
// FieldTrackingTrip by googleTripName, applies state transitions +
// telemetry idempotently. Silent on unknown tripName (do not 500).

export async function pollTripOnce(tripId: string): Promise<void>;

// Fallback path when Pub/Sub isn't set up or a message is missed. Calls
// GET /v1/{name} on the Google API.

export async function markArrivedIfNotAlready(taskFieldId: string):
                                Promise<void>;

// Called from the router when the worker sends "הגעתי" — flips our
// FieldTrackingTrip to ARRIVED if Google hasn't already reported it.
// Idempotent.

export async function endTrip(taskFieldId: string, reason:
                               'FINISHED'|'CANCELED'|'EXPIRED'):
                               Promise<void>;

// Called by our existing performTransition on FINISHED / decline. Closes
// the FieldTrackingTrip. Does NOT need a Google API call — the trip on
// Google's side ends when the driver arrives / the token expires.

export async function getPublicTripView(customerToken: string):
                                Promise<PublicTripView | null>;

// Extends the existing getPublicView. If an ACTIVE FieldTrackingTrip
// exists for the TrackingSession, prefer its telemetry over
// WorkerLiveLocation. Never leaks googleTripName, googleAuthToken,
// workerStartToken, etc.

export async function expireStale(): Promise<void>;

// Cron helper: any FieldTrackingTrip whose expiresAt has passed with no
// end state → EXPIRED. Kept out of MVP (lazy expiry on read is fine for
// customer view).
```

---

## F. API endpoint proposal

**Worker (protected by workerStartToken — random 32-char base64url):**
- `GET  /worker/trip/:workerStartToken` — landing page inside the worker
  app; renders customer name/address/time + "Choose Waze / Google Maps"
  buttons.
- `POST /worker/trip/:workerStartToken/launch` body `{ provider: 'WAZE'|'GOOGLE_MAPS' }`
  → calls `startTrip`, returns `{ launchUrl }`. Worker app then fires
  the URL as an Intent/Universal Link.

**Customer (existing token stays untouched):**
- `GET  /tracking/:token` — JSON. Same shape as today, but when an
  ACTIVE FieldTrackingTrip is attached, includes richer fields
  (`remainingDurationSecs`, `remainingDistanceMeters`, `remainingRoute`).
- `GET  /t/:token` — HTML page. Renders the Waze polyline+traffic when
  present, else the current worker-only view.

**Google Pub/Sub (new webhook):**
- `POST /webhooks/nav-connect/trip-update`
  Push subscription pointed at this endpoint. Must:
  1. Verify the `X-Goog-*` push token per Google docs (out of scope
     here — standard Pub/Sub push auth).
  2. Base64-decode `message.data` → the Trip proto JSON.
  3. Correlate on `name` field → `FieldTrackingTrip.googleTripName`.
  4. Idempotent apply.
  5. Always ack (`200`) unless you truly want redelivery.

**Admin / debug (internal-secret protected, like existing `owntracks/poc/debug`):**
- `GET  /admin/nav-connect/trips` — list active trips + latest payload.
- `POST /admin/nav-connect/trips/:id/expire` — force close.
- `POST /admin/nav-connect/trips/:id/refresh` — trigger `GetTrip`.

---

## G. Customer tracking page plan (delta from existing)

Existing page (`/t/:token`) already renders brand + hero + ETA card +
Leaflet map + `Cache-Control: no-store`. Delta when Navigation Connect
telemetry is available:

- Prefer `remainingDurationSecs` over declared `etaMinutes` for the
  countdown (real number, updates as trip progresses).
- Prefer `remainingDistanceMeters` for the "בעוד NNN מ׳" pill.
- When `remainingRoute.encodedPolyline` is present (Waze only) — decode
  and render as a road-following polyline instead of the current
  straight line. `trafficInformation` → color-code segments
  (NORMAL/SLOW/TRAFFIC_JAM).
- Trip state maps to page state:
  - `ENROUTE` → "הבודק בדרך אליך"
  - `ARRIVED` → "הבודק הגיע לאתר"
  - `SUSPENDED` → "לא התקבל עדכון מיקום בדקות האחרונות" + fallback to
    `WorkerLiveLocation` (OwnTracks) if we have any recent fix.
  - `FAILED` / `CLIENT_ERROR` → "המעקב לא זמין כרגע. הבודק בדרך."
    (do not scare the customer with technical wording)
  - `COMPLETED` / expired customer token → "הבדיקה הסתיימה. תודה!"

**Do not expose:** `googleTripName`, `googleAuthToken`,
`workerStartToken`, worker phone / name (already excluded), raw
Google/Waze payload.

---

## H. Worker flow (delta from existing)

Assumes the minimal worker app is installed (§A conclusion). Flow:

1. Manager (or bot) sends WhatsApp message:
   `"המשימה הבאה: <customer> · <address> · <time>. להתחלת נסיעה: <deep link>"`
   where deep link is `galitbot://trip/<workerStartToken>` OR a
   Universal Link `https://<our-host>/worker/trip/<workerStartToken>`.
2. Worker taps → OS routes to our worker app.
3. Worker app fetches customer name + address + scheduled time from
   `/worker/trip/:workerStartToken`, renders:
   - Big card: name, address, time.
   - Two buttons: `נווט עם Waze`, `נווט עם Google Maps`.
   - Small: `ביטול` (goes back).
4. Tap → app POSTs `/worker/trip/:token/launch { provider }`.
5. Backend `startTrip` → creates FieldTrackingTrip + calls Google
   `CreateTrip` → returns `{ launchUrl }`.
6. App fires the launch URL via Intent (Android with a PendingIntent to
   return home) or Universal Link (iOS).
7. Google Maps / Waze opens the consent prompt (12-month cadence),
   driver approves, navigation starts.
8. Existing "יצאתי / הגעתי / סיימתי" WhatsApp flow continues — the
   Navigation Connect trip is complementary telemetry, not a replacement.

**Explicitly NOT changing:** the whole existing bot flow. The worker
still sends WhatsApp status updates. Navigation Connect just enriches
the customer page.

---

## I. Privacy & security requirements (delta)

We already have most of this from the current tracking page work. New
items for Navigation Connect specifically:

- `workerStartToken` — 32-char base64url, unguessable, single-worker.
  Expires when trip transitions out of `CREATED/WAITING_FOR_WORKER`.
- `googleAuthToken` — server-side only. NEVER in URLs, NEVER in HTML,
  NEVER in the customer payload. Stored encrypted-at-rest (Supabase
  default) with `pg_crypto` optional column encryption if we harden it
  later.
- Consent handoff — Google/Waze owns the consent UI; we display it
  clearly in the worker app before the "Choose Waze/Google Maps"
  screen: "בעת הנווט, ישאלו אם ניתן לשתף את מיקום הנסיעה עם הלקוח.
  אישור נדרש כדי שהלקוח יראה מעקב."
- Consent revocation → trip flips to `CLIENT_ERROR`; customer page
  degrades to "המעקב לא זמין כרגע"; we do NOT re-prompt automatically.
- Post-completion privacy — `FieldTrackingTrip.state IN ('COMPLETED',
  'EXPIRED','FAILED','CANCELED')` → `getPublicTripView` returns no
  location. Mirrors the existing `TrackingSession` discipline.
- Audit — log rows into an existing `AuditLog`-style table (we already
  have `writeAuditLog`) at: `CREATED`, `NAVIGATION_LAUNCHED`,
  `ENROUTE`, `ARRIVED`, `SUSPENDED`, `FAILED`, `COMPLETED`.
- Retention — raw `lastPayload` jsonb retained 30d then nulled. Trip
  metadata retained 1y for support.
- The customer link continues to use the existing `TrackingSession.
  publicToken` — no new customer-facing token needed.

---

## J. Fallback plan (recommended MVP direction)

Given §A's conclusion that Navigation Connect is NOT MVP-ready, three
fallbacks — ordered from what we're already doing to what would need
new work.

### Fallback 1 (**recommended — continue what we're building**): OwnTracks + OSRM road routing

- We already have OwnTracks worker-phone GPS via `WorkerLiveLocation`.
- Add OSRM (`router.project-osrm.org`) for road-following polyline +
  duration. Straight-line fallback if OSRM is down.
- Client-side smooth marker animation, live ETA countdown, distance
  pill — the "Wolt-feel" tier from the earlier discussion.
- Cost: free. Zero new external services with billing.
- Limitations: no traffic (OSRM public is free-flow), no consent flow,
  worker must have OwnTracks configured — but he already is (`guy` key
  seeded).

### Fallback 2: Browser geolocation on the worker

- If we ever ship a worker web page (`/worker/*`), the browser can push
  its own GPS via `navigator.geolocation.watchPosition`.
- Very unreliable when the screen locks or WhatsApp is foregrounded —
  practically useless for a driver.
- **Do not recommend** for this project.

### Fallback 3: Status-only + declared ETA

- The state we were in TWO iterations ago: worker declares ETA at
  "יצאתי", customer sees the countdown but no map.
- Ships in an hour. But it's the very "static" experience the user
  explicitly said isn't good enough.

**Recommendation:** Fallback 1. It gets us 80% of the Wolt feel without
any of the enterprise-grade blockers Navigation Connect introduces.

---

## K. Risks (Navigation Connect route)

Ranked by likelihood of blocking us:

1. **Native worker app required** (documented, near-certain). Blocker
   for the MVP as scoped.
2. **Pre-GA status** — public docs say breaking changes are possible.
   No SLA committed. If Google pivots this, we rebuild.
3. **Unknown pricing** — SKU absent from the public list. Real risk of
   $$$ per-trip cost that scales badly with our field-visit volume.
4. **Regional availability unconfirmed for Israel.** EEA gets called out
   in the docs; Israel isn't mentioned. Could be fine, could be blocked.
   Requires a sales conversation to confirm.
5. **Driver consent** every 12 months + on-first-use. If a driver
   revokes, trip flips to `CLIENT_ERROR` — customer page must degrade
   gracefully (Fallback 1 telemetry as safety net).
6. **App versions** — Waze 5.15.5+ or Maps 26.14+. Old devices may not
   comply and silently fall through.
7. **Traffic + polyline is Waze-only.** Google Maps trips give ETA and
   location only, not the polyline. So the visual richness varies by
   which app the driver picked.
8. **Pub/Sub setup** adds Cloud infra we don't operate today. Polling
   `GetTrip` is a backup but doubles our request cost.
9. **60-second default update cadence.** Not "live" enough for a Wolt
   feel unless we enable `enableHighFrequencyUpdates` (5 s), which likely
   costs more per trip.
10. **CarPlay / Android Auto = no telemetry.** Drivers who use their
    car head-unit will silently produce no trip data. Common in Israel
    (Waze in car).
11. **Trip token expiration** — 12h. Long enough that we never care
    within one visit. But if a driver taps the WhatsApp deep link and
    doesn't actually drive for hours, we'd need to re-create.
12. **Correlation logic** — Google's `name` (`projects/N/trips/UUID`)
    is ours to map. Easy but not free of bugs.

---

## L. Implementation phases (only if we decide to build)

Explicitly phased so we can bail out at any step without wasted large
refactors.

- **Phase 1 — feasibility (this doc).** Done.
- **Phase 2 — Google Cloud sandbox.** New project, enable Navigation
  Connect API, service account, ADC set up, billing attached. No
  customer traffic. ~1 day.
- **Phase 3 — CreateTrip PoC in a script.** `scripts/nav-connect-poc.ts`
  that calls `CreateTrip` with a fake app ID and prints the token. Proves
  API access and pricing enrollment. ~2 hours.
- **Phase 4 — worker app skeleton.** Minimal Android app (Kotlin) that
  handles a deep link, calls our `/worker/trip/:token/launch`, and fires
  the returned URL as an Intent with PendingIntent return. ~1 week.
  iOS deferred to Phase 4b unless needed. This is the phase to bail out
  of if we don't want to own a mobile app.
- **Phase 5 — one real trip end-to-end.** Worker phone: deep link →
  launch → drive to a nearby address → verify our backend gets `NEW →
  ENROUTE → ARRIVED`. ~2 days.
- **Phase 6 — DB migration + `FieldTrackingTrip` persistence** (§D).
  ~1 day.
- **Phase 7 — Pub/Sub push webhook** or polling (whichever we pick).
  Includes verification, idempotency, correlation. ~2 days.
- **Phase 8 — customer page enrichment** (§G delta). Feature flag it
  behind a `NAV_CONNECT_ENABLED` env so we can turn off in seconds.
  ~2 days.
- **Phase 9 — WhatsApp integration.** Bot sends the deep-link message
  on assignment / "יצאתי". ~1 day.
- **Phase 10 — expiry, privacy, logs, error handling.** Cron sweep,
  `AuditLog` writes, retention job. ~2 days.

Rough total: 3–4 weeks including the worker app, most of which is the
Android app + integration. Without the worker app, none of the other
phases matter.

---

## M. Coding instructions for future turns

Everything below is a hard constraint until the user re-scopes:

- No broad refactor of `router.ts`, `services/tracking.ts`, or the
  customer page yet.
- No changes to WhatsApp flows before this report is approved and a
  build direction is picked.
- Do NOT build a browser-geolocation fallback (Fallback 2). It's a
  distraction and doesn't work in practice.
- Do NOT build Waze Share Drive links. Different product, not our
  target.
- Do NOT start a Google Cloud project or enable billing without
  explicit approval — this is a paid enterprise SKU.
- If we go the Navigation Connect route, work strictly in the Phase
  order above. Each phase is a small PR.
- The Wolt-lite continuation (Fallback 1: OSRM + Leaflet + client-side
  animation on top of existing OwnTracks) is the safe path and can ship
  behind the same customer link. It's independent of Navigation Connect
  and would still be useful even if we later add Navigation Connect on
  top for premium telemetry.

---

## What I need from the user

One decision, three sub-questions:

1. **Do we build Navigation Connect?**
   - **Yes** → we spend ~3–4 weeks on Phases 2–10 and ship a
     professional-grade tracking experience — but we own a native Android
     worker app now, and we pay Google an unknown per-trip fee.
   - **No** → we stay on the OSRM + OwnTracks Wolt-lite path, keep
     iterating on the customer page, and re-evaluate Navigation Connect
     when it goes GA + pricing is public.
   - **Not yet, but keep the option open** → I stop here, we ship the
     Wolt-lite path (~2–3 days more work), and we revisit this doc when
     Google GAs the product.

2. **If yes** — Android only, or Android + iOS worker app? Android is
   the fast path (Play Store side-loading is easy for field workers).
   iOS doubles the app work.

3. **If yes** — do you want me to draft a sales-conversation script for
   Google Maps Platform to nail down pricing + Israel availability before
   we commit? I can prepare that from the docs.

**My recommendation:** option 3 in question 1 (defer, keep the option
open). We already have infrastructure that gives us 80% of the feel; the
last 20% requires an org-level bet on Google's Pre-GA enterprise product
and a mobile app team.

---

*End of report. No code changed. No project created. No billing enabled.*
