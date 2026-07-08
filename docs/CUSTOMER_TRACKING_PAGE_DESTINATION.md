# Customer Tracking Page — destination marker + route line (MVP+1)

**Status:** DRAFT — awaiting approval before any code / migration / deploy.
**Predecessor:** `docs/CUSTOMER_TRACKING_PAGE_PLAN.md` (customer page shipping;
one worker marker only).

**Goal:** turn the customer page from "single blinking dot" into a Waze-lite
feel — worker marker + destination marker + line between them + auto-zoom to
fit both. Straight line only for MVP. No road-routing service, no Google.

**Model recommendation** (CLAUDE.md §3): **Opus** — this touches a migration,
`services/tracking.ts` (the `getPublicView` shape), a new geocoding module,
and the frontend template together. Small in lines but crosses the migration
boundary. Switch with `/model <name>`, or say "go".

---

## 1. What exists today

### 1.1 On `TaskField` (migration 009:74–80)
- `siteAddress text` — street + house number (e.g., "אלופי צה\"ל 48")
- `siteCity text`    — city ("חולון")
- `navigationUrl text` — deep link (Waze / Google Maps) written by the CRM
  scheduling form. Format is **inconsistent** — sometimes contains coords in
  `ll=...` or `q=...`, sometimes not.
- `specialInstructions text` — free-form

### 1.2 What does NOT exist
- **No `siteLat` / `siteLng` on `TaskField`.**
- **No geocode cache table.** Comment in migration 013:11 explicitly notes
  the geocode cache is a "later, only if the POC passes" item.
- **No geocoding library** in `package.json`. No calls to Nominatim / Google
  Geocoding / Photon / MapTiler anywhere in `src/`.

### 1.3 Current `PublicTrackingView` (JSON contract from Phase 016)
```ts
{
  status: 'ACTIVE' | 'ARRIVED' | 'FINISHED' | 'CANCELED' | 'EXPIRED' | 'SUPERSEDED';
  taskFieldStatus: string;
  updatedAt: string;
  lastLocation?: { lat, lng, at, accuracy? };  // worker only
  etaMinutes?: number;
  expectedArrivalAt?: string;
}
```
No destination anywhere in the payload.

### 1.4 Current customer page (`src/routes/trackingPage.template.ts`)
- One `L.marker([workerLat, workerLng])`. Centered + zoom 14.
- No destination marker, no polyline, no `fitBounds`.

---

## 2. What is missing to display the destination

Three things, in order:

1. **Persistent `siteLat` / `siteLng` for a TaskField** — so the customer page
   doesn't geocode on every refresh.
2. **A way to fill those coordinates** — geocode `siteAddress` + `siteCity`
   once, cache the result. Skip if either is null (no destination shown).
3. **JSON + frontend surface** — expose destination in `getPublicView`, draw
   two markers + a polyline in the page, `fitBounds` to include both.

---

## 3. Do we already have lat/lng for the address?

**No.** Neither on `TaskField` nor anywhere else. `navigationUrl` sometimes
encodes coords, but the format is CRM-driven and inconsistent — parsing it is
a fragile shortcut I do **not** recommend for MVP (a wrong extract could pin
the destination on the wrong side of town).

Verified via grep: no existing code path resolves an address to coordinates.

---

## 4. Proposed geocoding + cache design

### 4.1 Where to store the coordinates

**Recommendation: add columns to `TaskField`** (option 1). TaskField is
bot-owned (project rule §6 — the bot owns `TaskField`), additive columns are
consistent with earlier migrations (014 added ETA columns the same way), and
there's no reason to fan out to a separate cache table for MVP.

Migration `017_taskfield_site_geocode.sql` — additive only, idempotent:

```sql
BEGIN;
ALTER TABLE "TaskField"
  ADD COLUMN IF NOT EXISTS "siteLat"           double precision,
  ADD COLUMN IF NOT EXISTS "siteLng"           double precision,
  ADD COLUMN IF NOT EXISTS "siteGeocodedAt"    timestamptz,
  ADD COLUMN IF NOT EXISTS "siteGeocodeSource" text,
  ADD COLUMN IF NOT EXISTS "siteGeocodeQuery"  text;    -- what we geocoded, for cache-bust
COMMIT;
```

- `siteGeocodedAt` — timestamp we geocoded. Rarely used, but useful for debugging.
- `siteGeocodeSource` — free-form label (`'nominatim'`, `'manual'`), keeps
  future providers auditable.
- `siteGeocodeQuery` — the exact string we sent to the geocoder
  (`'<siteAddress>, <siteCity>'`). We cache-bust automatically when a manager
  corrects the address (query differs → re-geocode on next read).

### 4.2 Geocoder choice

**Recommendation: Nominatim (OpenStreetMap)** — free, no key, terms allow
"modest, non-batch" use. Rate-limited to 1 req/s; we're well under.

Requirements from Nominatim ToS:
- Custom `User-Agent` (identifying our app).
- Attribution on the customer page (already present via OSM tile layer).
- No auto-batch: we call it **only** on-demand from `getPublicView` when a
  TaskField's destination coords are missing. In practice: once per TaskField,
  ever.

Alternative providers I evaluated (not chosen for MVP):
- **Photon** — free, no rate limit published — but less Hebrew coverage.
- **MapTiler / LocationIQ** — API key needed. Overhead we don't need yet.
- **Google Geocoding** — paid, deferred per your rule.

Fallback path: if Nominatim returns 0 results or errors, we cache
`siteLat = null, siteLng = null, siteGeocodedAt = now(), siteGeocodeSource =
'nominatim:no_hit'`. The frontend shows worker marker only (current behavior).

### 4.3 When to geocode

**Lazily, from `getPublicView`.** First time a token is fetched for a
TaskField whose `siteLat`/`siteLng` is null (or whose `siteGeocodeQuery`
differs from the current `<siteAddress>, <siteCity>`), fire the geocode call,
persist the result, then return the enriched view.

Rationale:
- No new scheduler job, no cron.
- Called at most ~once per TaskField per address change.
- If Nominatim is slow (>800 ms), the customer's first page load is slightly
  slower on the initial hit — subsequent polls hit the cache. Acceptable.
- If Nominatim is down, we cache the miss and don't retry until the address
  changes. To be re-evaluated if this bites.

Non-goals:
- No client-side geocoding.
- No pre-warm at DEPARTED time (kept simple; no coupling to `router.ts`).

---

## 5. Minimum JSON change

Add ONE optional field to `PublicTrackingView`:

```ts
destination?: {
  lat: number;
  lng: number;
  address?: string;   // e.g. "אלופי צה\"ל 48, חולון" — safe to display
};
```

Rules:
- **Only** included when the token maps to a TaskField that has
  non-null cached coords.
- **Never** included for terminal statuses
  (`FINISHED`/`CANCELED`/`EXPIRED`/`SUPERSEDED`) — same discipline as
  `lastLocation`.
- **Never** exposes `siteGeocodedAt`, `siteGeocodeSource`, or
  `siteGeocodeQuery` — internal diagnostics only.
- Address label is a joined `siteAddress + siteCity` string. Deliberate
  decision: the customer already implicitly knows their own address via the
  destination pin; showing the text label is a UX improvement, not new
  information. If the token is shared, the address is still whatever the
  recipient already sees on the map.

Contract compatibility: purely additive. Existing consumers (QA scripts, the
current customer page) ignore the new key.

---

## 6. Minimum frontend change

`src/routes/trackingPage.template.ts` — small, contained edits:

1. Import a second Leaflet marker icon color for the destination — either
   reuse the default and rely on a small custom `divIcon` for the destination
   pin (a green circle labeled "יעד"), OR add a small inline SVG. Keeps
   dependencies unchanged (no Leaflet plugins).
2. On `applyState`, when `state.destination` present:
   - Create/update `destMarker = L.marker([dest.lat, dest.lng], { icon: destIcon })`.
   - Create/update `routeLine = L.polyline([[worker.lat, worker.lng], [dest.lat, dest.lng]], { color: brand, weight: 4, opacity: 0.7, dashArray: '6 6' })`.
   - `map.fitBounds([[worker.lat, worker.lng], [dest.lat, dest.lng]], { padding: [40, 40], maxZoom: 15 })` **only when** the pair meaningfully changed (fresh page load, ARRIVED transition, or worker moved > 500 m from the last-fitted position). Not on every 12 s poll — jumpy UX.
3. Copy tweak: subheader "בדרך אל <address>" under the existing "הבודק בדרך אליך" hero, but only when `destination.address` is present.
4. On ARRIVED: destination marker stays, polyline hides (worker is there).
5. On any terminal status: both destination marker and polyline are removed
   along with the worker marker (existing behavior).

Behavior when destination is absent (Nominatim miss / no address):
- Fall back to the current single-marker view. No error, no warning banner.
  Silent degradation.

---

## 7. Files that will change

New:
| File | Purpose |
|---|---|
| `src/db/migrations/017_taskfield_site_geocode.sql` | Additive columns on `TaskField` (see §4.1). Idempotent. |
| `src/services/geocoder.ts` | Nominatim client. Single async `geocodeAddress(query): Promise<{lat,lng}|null>`. Timeouts, single-attempt (no retries this iteration), User-Agent header, JSON parse guard. Wrapped in a per-process token-bucket at 1 req/s to satisfy Nominatim ToS. |
| `src/services/siteGeocodeCache.ts` | `resolveTaskFieldDestination(taskFieldId): Promise<{lat,lng,address}|null>` — reads TaskField row, decides cache-hit/miss/stale, calls `geocoder.geocodeAddress` on miss, upserts columns, returns the resolved destination. Single entry point. |

Edited:
| File | Change |
|---|---|
| `src/services/tracking.ts` | `PublicTrackingView` grows `destination?`. `getPublicView` calls `resolveTaskFieldDestination` when `showLocation` is true and returns it in the payload. |
| `src/routes/trackingPage.template.ts` | Second marker + polyline + smart `fitBounds`. Optional subheader when `destination.address` is set. |

Untouched:
- `src/services/workerLocation.ts`
- `src/routes/tracking.ts`, `src/routes/trackingPage.ts`, `src/app.ts`
- `src/ai/router.ts`, any scheduler, any WhatsApp path

---

## 8. Tests

Backend (all colocated in `src/__tests__/`):
1. **`geocoder.test.ts`** — mocks `fetch`. Assertions:
   - Sends `User-Agent` header and the exact query string built from
     `siteAddress + siteCity`.
   - Returns `null` on empty response, on HTTP 4xx/5xx, on invalid JSON,
     on `[]` result set — without throwing.
   - Respects a 3 s timeout (`AbortController`).
2. **`siteGeocodeCache.test.ts`** — mocks pool + geocoder. Assertions:
   - **Hit:** TaskField already has `siteLat`/`siteLng` matching current
     `siteGeocodeQuery` → returns immediately, geocoder NOT called.
   - **Miss:** null coords → geocoder called → upsert writes lat/lng +
     `siteGeocodedAt` + `siteGeocodeSource='nominatim'` + `siteGeocodeQuery`.
   - **Stale (address changed):** `siteGeocodeQuery` differs from current
     address → geocoder called, columns overwritten.
   - **Nominatim miss:** geocoder returns null → we cache
     `siteGeocodeSource='nominatim:no_hit'`, return null. Next call within N
     minutes does NOT retry.
   - **Missing address:** siteAddress OR siteCity null → returns null without
     calling geocoder.
3. **`tracking.test.ts`** (extend existing) — new cases:
   - ACTIVE + cached destination → `getPublicView` returns `destination`
     with `{lat,lng,address}`.
   - FINISHED + cached destination → `getPublicView` does NOT return
     `destination`.
   - ACTIVE + no cached destination → payload has no `destination` key.

Frontend (`trackingPage.test.ts` — extend):
4. When `destination` present, served HTML embeds both destination lat/lng
   in the initial state.
5. When `destination` absent, no destination lat/lng appear in the HTML.
6. `taskFieldId` / `workerUserId` / `siteGeocodeSource` / `siteGeocodeQuery`
   / `siteGeocodedAt` never appear in the served HTML (defense-in-depth).

Manual QA additions to the previous script:
- Open the tracking link with a TaskField that has a valid address → see
  both markers, a dashed line between them, map auto-fits both.
- Refresh the page 30 s later → no jitter re-zoom on every poll, only when
  worker moves meaningfully.
- Open a link where `siteAddress` is empty → single-marker fallback, no
  broken UI.
- Update a TaskField's `siteAddress` in Supabase → next open triggers a
  fresh Nominatim call (verify via server log), coords change.

---

## 9. Risks / open questions

- **Q1 — Address privacy.** OK to include `destination.address` (text) in
  the JSON, or destination lat/lng only? Recommendation: include the text —
  the customer already knows their own address, and the shared-link risk is
  the same as the coordinates that are already there.
- **Q2 — Nominatim ToS.** Requires custom `User-Agent` and attribution on
  the page. Attribution is already there via the OSM tile layer. The
  `User-Agent` will be something like
  `GalitTrackingBot/1.0 (contact: <you@example.com>)`. **What contact string
  do you want me to use?**
- **Q3 — Straight line vs road route.** Recommending straight line for MVP.
  If you want the road route: one-shot OSRM call
  (`router.project-osrm.org/route/v1/driving/...`) at page-load time, cache
  in memory for the session. Adds ~200 ms on first paint, no per-poll cost.
  I can add this as an optional Phase 2 the same day, but it's NOT in MVP.
- **Q4 — Nominatim reliability.** Public instance is throttled and
  occasionally slow. For your traffic today (single-digit customers at
  once) this is fine. If ever needed, swap to a paid provider by changing
  one function — the interface stays.
- **Q5 — Address change after geocode.** Handled by `siteGeocodeQuery`
  comparison. But a manager could also correct the address without changing
  it visually (whitespace / punctuation). Recommendation: compare after
  `.trim().toLowerCase()` so trivial diffs don't force a re-geocode.
- **Q6 — Nominatim JSON key differences with Hebrew.** Verified on a couple
  of samples in advance — Hebrew queries return valid `lat`/`lon` fields.
  Rare edge cases (typos, ambiguous street names) will just miss; frontend
  degrades gracefully to worker-only.
- **Q7 — Migration timing.** New columns are additive and safe on a live
  DB. Same discipline as 014/016 — apply outside deploy window.

---

## Recommendation for what to build first (approve to proceed):

1. Migration `017_taskfield_site_geocode.sql` — 4 additive columns.
2. `src/services/geocoder.ts` — Nominatim client + rate limit.
3. `src/services/siteGeocodeCache.ts` — resolve + upsert wrapper.
4. Extend `getPublicView` to include `destination?`.
5. Extend `trackingPage.template.ts` — destination marker, polyline,
   smart `fitBounds`, optional address subheader.
6. All the tests in §8.
7. Manual QA per the extended script.

No deploy, no migration apply, until you approve.

---

## Guardrails I will hold to during implementation

- No Google APIs.
- No road-routing service (straight line only).
- No new scheduler job.
- No cron sweep.
- No customer WhatsApp sending.
- No breaking changes to the JSON contract — `destination` is additive
  and optional.
- Nominatim called at most once per TaskField per address change.
