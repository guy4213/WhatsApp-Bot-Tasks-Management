/**
 * Customer-facing tracking page HTML template.
 *
 * Two exports:
 *   - `renderTrackingPage(token, initial)` — full page for a resolved session.
 *   - `renderNotFound()`                    — friendly 404 page. Same shell.
 *
 * Design constraints (approved plan `docs/CUSTOMER_TRACKING_PAGE_PLAN.md`):
 *  - Hebrew, RTL, mobile-first. Brand text only ("גלית החברה לאיכות הסביבה").
 *  - No new npm deps. Leaflet + OSM tiles loaded from unpkg with SRI hashes
 *    pinned to Leaflet 1.9.4 (hashes taken from the official Leaflet docs).
 *  - All CSS + JS inline in one HTML string so the customer sees the page in
 *    one round-trip and no build step is needed.
 *  - All times formatted in Asia/Jerusalem via `toLocaleTimeString('he-IL')`
 *    regardless of the customer's browser timezone.
 *  - Consumes the existing `GET /tracking/:token` JSON contract as-is —
 *    the frontend hard-codes only the whitelisted keys; any future extra
 *    JSON key is ignored.
 *  - No customer-supplied text ever lands in HTML body. The only interpolated
 *    values are `token` (base64url, safe) and `initial` (JSON, escaped via
 *    `safeJson`), both used exclusively inside a `<script>` block.
 */
import type { PublicTrackingView } from '../services/tracking';

/**
 * Forward contract (additive, documentation-only) for the enriched
 * `/tracking/:token` payload. A parallel workstream (TRACK-A) is adding
 * these fields to `PublicTrackingView` in `services/tracking.ts`; at the
 * time this file was written that type was mid-migration there (some
 * fields required, some optional, still settling), so this type is
 * deliberately declared standalone — NOT `extends PublicTrackingView` —
 * to avoid a structural-compatibility fight with a moving target. Nothing
 * in this file actually needs this type at compile time: `renderTrackingPage`
 * keeps accepting `PublicTrackingView` as before, and the client logic below
 * lives inside a template-string `JS` blob that ships to `tsc` as an opaque
 * string (nothing in it is type-checked). All new fields are read
 * defensively in that JS with a fallback to the legacy fields (`status`,
 * `lastLocation`, `destination`, `etaMinutes`, `expectedArrivalAt`) when
 * absent, so the page renders correctly against both the old and the new
 * backend shape. Keep this comment/type in sync with `services/tracking.ts`
 * whenever either side changes.
 */
interface EnrichedPublicTrackingView {
  headline?: string;
  presentationStatus?:
    | 'WAITING'
    | 'EN_ROUTE'
    | 'NEARBY'
    | 'ARRIVED'
    | 'COMPLETED'
    | 'STALE_LOCATION'
    | 'UNAVAILABLE'
    | 'EXPIRED';
  workerLocation?: { lat: number; lng: number; updatedAt: string };
  destinationLocation?: { lat: number; lng: number; address?: string };
  route?: {
    type: 'OSRM' | 'STRAIGHT_LINE';
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
    distanceMeters?: number;
    durationSeconds?: number;
  };
  distanceMeters?: number;
  durationSeconds?: number;
  etaText?: string;
  lastUpdatedAt?: string;
  locationFreshnessSeconds?: number;
  isLocationFresh?: boolean;
  isRouteAvailable?: boolean;
  fallbackReason?: string;
}

// Official Leaflet 1.9.4 SRI hashes (from leafletjs.com/download.html).
const LEAFLET_CSS_URL = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS_URL  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const LEAFLET_JS_SRI  = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';

const BRAND = 'גלית החברה לאיכות הסביבה';

/**
 * JSON-encode + neutralize `</script>` breakout. Runs on values that live
 * exclusively inside an inline `<script>` block — the only user-influenced
 * values on the page.
 */
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

/** Shared CSS. Mobile-first, RTL-aware. No animations beyond a subtle fade. */
const CSS = `
  :root {
    --bg: #f5f7fa;
    --card: #ffffff;
    --ink: #1c2b3a;
    --muted: #66748a;
    --brand: #1f7a3b;
    --brand-soft: #e6f4ea;
    --line: #e2e6ec;
    --shadow: 0 2px 8px rgba(0,0,0,0.06);
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  header {
    background: var(--brand);
    color: #fff;
    padding: 14px 18px;
    text-align: center;
    font-weight: 600;
    letter-spacing: 0.2px;
  }
  main {
    max-width: 560px;
    margin: 0 auto;
    padding: 18px 16px 32px;
  }
  #hero {
    font-size: 26px;
    font-weight: 700;
    margin: 18px 4px 8px;
    line-height: 1.25;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 16px 18px;
    margin: 14px 0;
  }
  .eta-time {
    font-size: 22px;
    font-weight: 700;
    color: var(--brand);
  }
  .eta-relative {
    color: var(--muted);
    margin-top: 4px;
    font-size: 15px;
  }
  #updated-line {
    color: var(--muted);
    font-size: 14px;
    margin: 6px 4px 0;
  }
  #accuracy-notice {
    font-size: 13px;
    margin: 6px 4px 0;
  }
  #subheader {
    color: var(--muted);
    font-size: 15px;
    margin: 2px 4px 8px;
  }
  #subheader b { color: var(--ink); }
  /* Destination marker — small green pin drawn as a divIcon. Sits above the
     default Leaflet marker in stacking context (below the tile layer's
     panes but above raster tiles). */
  .dest-pin {
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--brand);
    border: 3px solid #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.35);
  }
  #map {
    height: 320px;
    margin-top: 14px;
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }
  #banner {
    background: #fff8db;
    border: 1px solid #f0d97a;
    color: #6b4a0a;
    border-radius: var(--radius);
    padding: 10px 14px;
    margin: 6px 0 12px;
    font-size: 14px;
    text-align: center;
  }
  /* STALE_LOCATION warning strip — same visual language as #banner (both
     communicate "the data you're seeing may be out of date"). */
  #stale-warning {
    background: #fff8db;
    border: 1px solid #f0d97a;
    color: #6b4a0a;
    border-radius: var(--radius);
    padding: 10px 14px;
    margin: 6px 0 12px;
    font-size: 14px;
    text-align: center;
    line-height: 1.5;
  }
  #distance-line {
    color: var(--muted);
    margin-top: 4px;
    font-size: 15px;
  }
  .muted { color: var(--muted); }
  .hidden { display: none !important; }
  footer {
    text-align: center;
    padding: 16px 18px 28px;
    color: var(--muted);
    font-size: 13px;
  }
  /* State variants */
  body.state-ARRIVED #map { opacity: 0.85; }
  /* RTL sanity: Leaflet's zoom controls default to left; nudge for RTL feel */
  .leaflet-top.leaflet-left { direction: ltr; }
`;

/** Inline JS. Consumes `TOKEN` and `INITIAL_STATE` injected by the wrapper. */
const JS = `
  const POLL_ACTIVE_MS = 12000;
  const POLL_ARRIVED_MS = 60000;
  // Legacy terminal set — keyed on the OLD \`status\` field. Kept for backend
  // payloads that don't send \`presentationStatus\` yet.
  const TERMINAL = new Set(['FINISHED','CANCELED','EXPIRED','SUPERSEDED']);
  // New terminal set — keyed on \`presentationStatus\`. UNAVAILABLE is
  // intentionally included here per product decision: when the bot has no
  // usable location fix, the page stops polling rather than hammering the
  // endpoint hoping for a recovery (a fresh page load will pick it back up).
  const PRESENTATION_TERMINAL = new Set(['COMPLETED', 'EXPIRED', 'UNAVAILABLE']);
  const IL_TZ = 'Asia/Jerusalem';

  // Legacy hero text, keyed on the OLD \`status\` field. Used only as a
  // fallback when the backend sends neither \`headline\` nor
  // \`presentationStatus\` (old contract) — preserved byte-for-byte so old
  // payloads keep rendering exactly as before.
  const STATUS_HERO = {
    ACTIVE:     'הבודק בדרך אליך',
    ARRIVED:    'הבודק הגיע לאתר',
    FINISHED:   'הבדיקה הסתיימה. תודה!',
    CANCELED:   'המעקב אינו פעיל',
    EXPIRED:    'המעקב אינו פעיל',
    SUPERSEDED: 'המעקב אינו פעיל'
  };

  // New hero text, keyed on \`presentationStatus\` (enriched contract).
  // Only consulted when the backend actually sends \`presentationStatus\`.
  const PRESENTATION_HERO = {
    WAITING:        'הבודק יצא לדרך. מיקום חי יופיע בעוד רגע.',
    EN_ROUTE:       'הבודק בדרך אליך',
    NEARBY:         'הבודק קרוב אליך',
    STALE_LOCATION: 'הבודק בדרך אליך',
    ARRIVED:        'הבודק הגיע לאתר.',
    COMPLETED:      'הבדיקה הסתיימה. תודה.',
    UNAVAILABLE:    'המעקב לא זמין כרגע, אך הבודק בדרך.',
    EXPIRED:        'המעקב אינו פעיל'
  };

  // Presentations where the map / worker marker may be shown at all.
  const MAP_VISIBLE_PRESENTATIONS = new Set(['EN_ROUTE', 'NEARBY', 'STALE_LOCATION', 'ARRIVED']);
  // Presentations where the subheader ("בדרך אל <address>") may be shown.
  const SUB_VISIBLE_PRESENTATIONS = new Set(['EN_ROUTE', 'NEARBY', 'STALE_LOCATION']);
  // Presentations where the ETA card may be shown.
  const ETA_VISIBLE_PRESENTATIONS = new Set(['EN_ROUTE', 'NEARBY', 'STALE_LOCATION']);

  let pollTimer = null;
  let backoff = 0;
  let map = null, marker = null, accuracyCircle = null;
  let destMarker = null, routeLine = null;
  // fitBounds discipline (MVP+1): don't re-fit on every poll. Only when:
  //   - fresh page load / first geometry
  //   - presentation transitions (e.g. EN_ROUTE -> NEARBY -> ARRIVED)
  //   - the worker moved more than REFIT_METERS from the last fitted position
  let lastFittedWorkerLL = null, lastFittedStatus = null;
  const REFIT_METERS = 500;
  let lastState = null;

  // Marker animation state — smooth interpolation between polls.
  let markerAnimFrame = null;
  // Live ETA countdown baseline — reset on every poll, ticked once per
  // second in between. NOTE (product requirement): this is always an
  // ESTIMATE — never present it as an exact or traffic-aware arrival time.
  // The visible label is always "זמן הגעה משוער" (estimated arrival time).
  let countdownBaseline = null; // { sec: number, at: epoch-ms }

  const $ = (id) => document.getElementById(id);

  // Small HTML escape for the "בדרך אל <address>" subheader — the only place
  // any string from the payload lands in body innerHTML.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Rough equirectangular distance in metres. Fine for the < 1 km scale
  // we care about for re-fit gating and the marker-snap guard.
  function metersBetween(a, b) {
    const dLat = (a.lat - b.lat) * 111000;
    const midLatRad = (a.lat + b.lat) * Math.PI / 360;
    const dLng = (a.lng - b.lng) * 111000 * Math.cos(midLatRad);
    return Math.hypot(dLat, dLng);
  }

  function formatIlTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString('he-IL', {
        timeZone: IL_TZ, hour: '2-digit', minute: '2-digit'
      });
    } catch (_) { return ''; }
  }

  function formatRelative(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60)   return 'לפני ' + diffSec + ' שניות';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60)   return 'לפני ' + diffMin + ' דקות';
    const diffHr = Math.round(diffMin / 60);
    return 'לפני ' + diffHr + ' שעות';
  }

  // 'מרחק משוער: X ק״מ' (1 decimal) or 'מרחק משוער: X מטרים' under 1000m.
  function formatDistance(meters) {
    if (meters == null || !Number.isFinite(meters)) return '';
    if (meters < 1000) return 'מרחק משוער: ' + Math.round(meters) + ' מטרים';
    return 'מרחק משוער: ' + (meters / 1000).toFixed(1) + ' ק״מ';
  }

  // mm:ss countdown text, floored at 'פחות מדקה' under one minute.
  // Defensive Math.round: durationSeconds arrives from OSRM as a float
  // (e.g. 2969.400000000001) — without rounding, "remainingSec % 60" keeps
  // the fractional remainder and gets string-concatenated verbatim
  // ("22:49.40000000000009"). Round once here so any caller is safe,
  // regardless of whether the baseline itself was rounded.
  function formatCountdown(remainingSec) {
    const total = Math.round(remainingSec);
    if (total < 60) return 'פחות מדקה';
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Resolve the bucket that drives map/ETA/subheader visibility. Prefers the
  // enriched \`presentationStatus\`; falls back to a mapping off the legacy
  // \`status\` field so old backend payloads keep behaving as before.
  function effectivePresentation(state) {
    if (state.presentationStatus) return state.presentationStatus;
    switch (state.status) {
      case 'ACTIVE':  return 'EN_ROUTE';
      case 'ARRIVED': return 'ARRIVED';
      case 'FINISHED': return 'COMPLETED';
      case 'EXPIRED': return 'EXPIRED';
      default: return 'EXPIRED'; // CANCELED / SUPERSEDED / unknown — terminal, no map.
    }
  }

  // Resolve the hero text. Server-provided \`headline\` wins outright; then
  // \`presentationStatus\` (new contract); then the legacy \`status\` map —
  // this last branch is what keeps old payloads pixel/text-identical to
  // pre-upgrade behavior.
  function resolveHero(state) {
    if (state.headline) return state.headline;
    if (state.presentationStatus && PRESENTATION_HERO[state.presentationStatus] != null) {
      return PRESENTATION_HERO[state.presentationStatus];
    }
    return STATUS_HERO[state.status] || STATUS_HERO.CANCELED;
  }

  // Worker position — prefers the enriched \`workerLocation\`, falls back to
  // the legacy \`lastLocation\`.
  function pickWorkerLL(state) {
    const wl = state.workerLocation || state.lastLocation;
    if (wl && Number.isFinite(wl.lat) && Number.isFinite(wl.lng)) {
      return { lat: wl.lat, lng: wl.lng };
    }
    return null;
  }

  // Destination — prefers the enriched \`destinationLocation\`, falls back to
  // the legacy \`destination\`.
  function pickDestLL(state) {
    const dl = state.destinationLocation || state.destination;
    if (dl && Number.isFinite(dl.lat) && Number.isFinite(dl.lng)) {
      return { lat: dl.lat, lng: dl.lng, address: dl.address };
    }
    return null;
  }

  // Smoothly animate the marker from its current position to the new one
  // over ~1.5s (ease-out). Jumps over ~2km snap instantly instead — a
  // multi-kilometer "flight" reads as a bug, not a smooth update (typically
  // a GPS fix resuming after being offline, not real travel).
  function animateMarkerTo(newLat, newLng) {
    if (!marker) return;
    if (markerAnimFrame != null) { cancelAnimationFrame(markerAnimFrame); markerAnimFrame = null; }
    const from = marker.getLatLng();
    const to = { lat: newLat, lng: newLng };
    const jumpMeters = metersBetween({ lat: from.lat, lng: from.lng }, to);
    if (jumpMeters > 2000) {
      marker.setLatLng([to.lat, to.lng]);
      return;
    }
    const durationMs = 1500;
    const startTime = (window.performance && performance.now) ? performance.now() : Date.now();
    const fromLat = from.lat, fromLng = from.lng;
    function step(now) {
      const t = Math.max(0, Math.min(1, (now - startTime) / durationMs));
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      marker.setLatLng([
        fromLat + (to.lat - fromLat) * eased,
        fromLng + (to.lng - fromLng) * eased,
      ]);
      if (t < 1) {
        markerAnimFrame = requestAnimationFrame(step);
      } else {
        markerAnimFrame = null;
      }
    }
    markerAnimFrame = requestAnimationFrame(step);
  }

  function ensureMap(lat, lng) {
    if (!window.L) return; // Leaflet script hasn't loaded (offline / SRI mismatch)
    if (!map) {
      // Initial view only. Subsequent positioning is via fitIfNeeded() so we
      // don't yank the map on every 12 s poll.
      map = L.map('map', { attributionControl: true }).setView([lat, lng], 14);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
      }).addTo(map);
      marker = L.marker([lat, lng]).addTo(map);
    } else {
      animateMarkerTo(lat, lng);
    }
  }

  function ensureDestination(destLL) {
    if (!map || !destLL) return;
    if (!destMarker) {
      const icon = L.divIcon({
        className: '',
        html: '<div class="dest-pin" aria-label="יעד"></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      destMarker = L.marker([destLL.lat, destLL.lng], { icon }).addTo(map);
    } else {
      destMarker.setLatLng([destLL.lat, destLL.lng]);
    }
  }

  // Draws the road route when \`route.type === 'OSRM'\` (solid line, following
  // the actual road geometry); falls back to the straight dashed line
  // otherwise (no route / STRAIGHT_LINE). Replaced wholesale on every poll.
  function ensureRoute(workerLL, destLL, route) {
    if (!map || !workerLL || !destLL) return;
    let pts;
    let dashed = true;
    if (route && route.type === 'OSRM' && route.geometry && Array.isArray(route.geometry.coordinates)) {
      // GeoJSON LineString coordinates are [lng, lat] — Leaflet wants [lat, lng].
      pts = route.geometry.coordinates.map((c) => [c[1], c[0]]);
      dashed = false;
    } else {
      pts = [[workerLL.lat, workerLL.lng], [destLL.lat, destLL.lng]];
      dashed = true;
    }
    const style = { color: '#1f7a3b', weight: 4, opacity: 0.7, dashArray: dashed ? '6 8' : null };
    if (!routeLine) {
      routeLine = L.polyline(pts, style).addTo(map);
    } else {
      routeLine.setLatLngs(pts);
      routeLine.setStyle(style);
    }
  }

  function removeDestinationLayers() {
    if (routeLine) { routeLine.remove(); routeLine = null; }
    if (destMarker) { destMarker.remove(); destMarker = null; }
  }

  function fitIfNeeded(presentation, workerLL, destLL) {
    if (!map || !workerLL) return;
    const statusChanged = lastFittedStatus !== presentation;
    const movedFar =
      lastFittedWorkerLL == null ||
      metersBetween(lastFittedWorkerLL, workerLL) > REFIT_METERS;
    if (!statusChanged && !movedFar) return;
    if (destLL) {
      map.fitBounds(
        [[workerLL.lat, workerLL.lng], [destLL.lat, destLL.lng]],
        { padding: [40, 40], maxZoom: 15, animate: true },
      );
    } else {
      map.setView([workerLL.lat, workerLL.lng], 14, { animate: true });
    }
    lastFittedWorkerLL = { lat: workerLL.lat, lng: workerLL.lng };
    lastFittedStatus = presentation;
  }

  function updateAccuracy(lat, lng, accuracy) {
    if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; }
    const notice = $('accuracy-notice');
    if (map && accuracy != null && accuracy > 50) {
      accuracyCircle = L.circle([lat, lng], {
        radius: accuracy, color: '#888', weight: 1,
        opacity: 0.5, fillOpacity: 0.12
      }).addTo(map);
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }
  }

  function destroyMap() {
    if (map) { map.remove(); }
    map = null; marker = null; accuracyCircle = null;
    destMarker = null; routeLine = null;
    lastFittedWorkerLL = null; lastFittedStatus = null;
    if (markerAnimFrame != null) { cancelAnimationFrame(markerAnimFrame); markerAnimFrame = null; }
  }

  // Paints the current countdown baseline, if any. Called once per second
  // by the shared interval AND immediately whenever a fresh baseline is set
  // so the number doesn't sit stale for up to a second after a poll.
  function tickCountdown() {
    if (!countdownBaseline) return;
    const elapsedSec = Math.round((Date.now() - countdownBaseline.at) / 1000);
    const remainingSec = Math.max(0, countdownBaseline.sec - elapsedSec);
    // "זמן הגעה משוער" (estimated arrival time) — never phrase this as exact
    // or traffic-aware; it is always a rough estimate derived server-side.
    $('eta-time').textContent = 'זמן הגעה משוער: ' + formatCountdown(remainingSec);
  }

  function renderEtaCard(state, presentation) {
    const card = $('eta-card');
    const timeEl = $('eta-time');
    const relEl = $('eta-relative');
    const distEl = $('distance-line');

    const hasEtaData = state.etaMinutes != null || state.expectedArrivalAt
      || state.etaText || state.durationSeconds != null;
    const showEta = ETA_VISIBLE_PRESENTATIONS.has(presentation) && hasEtaData;

    if (!showEta) {
      card.classList.add('hidden');
      countdownBaseline = null;
      distEl.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');

    // Live countdown ONLY when the location is fresh and we're actively
    // en route / nearby — per product requirement, a stale fix must freeze
    // the estimate rather than keep ticking down against reality.
    const canCountdown = state.isLocationFresh === true
      && (presentation === 'EN_ROUTE' || presentation === 'NEARBY')
      && Number.isFinite(state.durationSeconds);

    if (canCountdown) {
      // Root-cause fix: round OSRM's fractional duration to whole seconds
      // before it enters the countdown baseline (see formatCountdown above).
      countdownBaseline = { sec: Math.round(state.durationSeconds), at: Date.now() };
      tickCountdown(); // paint immediately, don't wait for the 1s tick
      relEl.textContent = state.expectedArrivalAt
        ? ('הגעה משוערת: ' + formatIlTime(state.expectedArrivalAt))
        : '';
    } else {
      countdownBaseline = null;
      if (presentation === 'STALE_LOCATION' && state.etaText) {
        // Server already appends the "(הערכה בלבד)" qualifier to etaText.
        timeEl.textContent = state.etaText;
      } else if (state.expectedArrivalAt) {
        timeEl.textContent = 'הגעה משוערת: ' + formatIlTime(state.expectedArrivalAt);
      } else if (state.etaText) {
        timeEl.textContent = state.etaText;
      } else {
        timeEl.textContent = '';
      }
      relEl.textContent = state.etaMinutes != null
        ? ('בעוד כ־' + state.etaMinutes + ' דקות')
        : '';
    }

    const dm = state.distanceMeters;
    if (dm != null && Number.isFinite(dm)) {
      distEl.textContent = formatDistance(dm);
      distEl.classList.remove('hidden');
    } else {
      distEl.textContent = '';
      distEl.classList.add('hidden');
    }
  }

  function applyState(state) {
    lastState = state;
    const presentation = effectivePresentation(state);
    document.body.className = 'state-' + (state.presentationStatus || state.status);

    $('hero').textContent = resolveHero(state);

    const destLL = pickDestLL(state);

    // Subheader — "בדרך אל <address>" while en route / nearby / stale.
    const subEl = $('subheader');
    if (SUB_VISIBLE_PRESENTATIONS.has(presentation) && destLL && destLL.address) {
      subEl.innerHTML = 'בדרך אל <b>' + escapeHtml(destLL.address) + '</b>';
      subEl.classList.remove('hidden');
    } else {
      subEl.textContent = '';
      subEl.classList.add('hidden');
    }

    // STALE_LOCATION warning strip.
    const staleEl = $('stale-warning');
    if (presentation === 'STALE_LOCATION') {
      staleEl.classList.remove('hidden');
    } else {
      staleEl.classList.add('hidden');
    }

    renderEtaCard(state, presentation);

    // Map — only for presentations where a worker fix is meaningful.
    const workerLL = MAP_VISIBLE_PRESENTATIONS.has(presentation) ? pickWorkerLL(state) : null;
    const mapDestLL = workerLL ? destLL : null;

    if (workerLL) {
      $('map').classList.remove('hidden');
      ensureMap(workerLL.lat, workerLL.lng);
      const accuracy = state.lastLocation ? state.lastLocation.accuracy : null;
      updateAccuracy(workerLL.lat, workerLL.lng, accuracy);
      if (mapDestLL && presentation !== 'ARRIVED') {
        ensureDestination(mapDestLL);
        ensureRoute(workerLL, mapDestLL, state.route);
      } else if (mapDestLL && presentation === 'ARRIVED') {
        // Show the destination pin but drop the route line — worker is there.
        ensureDestination(mapDestLL);
        if (routeLine) { routeLine.remove(); routeLine = null; }
      } else {
        removeDestinationLayers();
      }
      fitIfNeeded(presentation, workerLL, mapDestLL);
    } else {
      $('map').classList.add('hidden');
      $('accuracy-notice').classList.add('hidden');
      destroyMap();
    }

    updateRelative();
  }

  function updateRelative() {
    if (!lastState) return;
    const presentation = effectivePresentation(lastState);
    const line = $('updated-line');
    if (TERMINAL.has(lastState.status) || PRESENTATION_TERMINAL.has(presentation)) {
      line.textContent = '';
      return;
    }
    const ts = lastState.lastUpdatedAt
      || (lastState.workerLocation && lastState.workerLocation.updatedAt)
      || (lastState.lastLocation && lastState.lastLocation.at)
      || lastState.updatedAt;
    line.textContent = ts ? ('עודכן ' + formatRelative(ts)) : '';
  }

  function nextDelay(state, presentation) {
    if (TERMINAL.has(state.status)) return null;
    if (PRESENTATION_TERMINAL.has(presentation)) return null;
    if (presentation === 'ARRIVED') return POLL_ARRIVED_MS;
    // STALE_LOCATION keeps polling at the active cadence — location may
    // resume at any time.
    return POLL_ACTIVE_MS;
  }

  async function poll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    try {
      const res = await fetch('/tracking/' + encodeURIComponent(TOKEN), { cache: 'no-store' });
      if (res.status === 404) {
        // Session revoked or expired hard — treat as expired locally.
        applyState({ status: 'EXPIRED', updatedAt: new Date().toISOString() });
        return;
      }
      if (!res.ok) throw new Error('http ' + res.status);
      const state = await res.json();
      backoff = 0;
      $('banner').classList.add('hidden');
      applyState(state);
      const presentation = effectivePresentation(state);
      const d = nextDelay(state, presentation);
      if (d != null && !document.hidden) pollTimer = setTimeout(poll, d);
    } catch (_) {
      $('banner').classList.remove('hidden');
      backoff = Math.min(6, backoff + 1);
      const d = Math.min(60000, 3000 * Math.pow(2, backoff - 1));
      pollTimer = setTimeout(poll, d);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    } else {
      poll();
    }
  });

  // Boot from server-embedded initial state.
  applyState(INITIAL_STATE);
  // One shared 1s tick drives both the relative "עודכן לפני..." line and the
  // live ETA countdown (when active) between polls.
  setInterval(() => { updateRelative(); tickCountdown(); }, 1000);
  {
    const initialPresentation = effectivePresentation(INITIAL_STATE);
    if (!TERMINAL.has(INITIAL_STATE.status) && !PRESENTATION_TERMINAL.has(initialPresentation)) {
      const d = nextDelay(INITIAL_STATE, initialPresentation) || POLL_ACTIVE_MS;
      pollTimer = setTimeout(poll, d);
    }
  }
`;

/**
 * Full page for a resolved session. `initial` is the same shape the JSON
 * endpoint returns; the page starts by rendering it, then polls the JSON
 * endpoint for updates.
 */
export function renderTrackingPage(token: string, initial: PublicTrackingView): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>מעקב | ${BRAND}</title>
<link rel="stylesheet" href="${LEAFLET_CSS_URL}" integrity="${LEAFLET_CSS_SRI}" crossorigin="">
<style>${CSS}</style>
</head>
<body>
<header>${BRAND}</header>
<main>
  <div id="banner" class="hidden" role="status">מנסים לרענן…</div>
  <h1 id="hero" role="status" aria-live="polite"></h1>
  <div id="subheader" class="hidden"></div>
  <div id="stale-warning" class="hidden" role="status">
    <div>לא התקבל עדכון מיקום בדקות האחרונות.</div>
    <div>זמן ההגעה מוצג כהערכה בלבד.</div>
  </div>
  <div id="eta-card" class="card hidden">
    <div id="eta-time" class="eta-time"></div>
    <div id="eta-relative" class="eta-relative"></div>
    <div id="distance-line" class="hidden"></div>
  </div>
  <div id="updated-line"></div>
  <div id="accuracy-notice" class="muted hidden">מיקום משוער</div>
  <div id="map" class="hidden"></div>
</main>
<footer>© ${BRAND}</footer>
<script src="${LEAFLET_JS_URL}" integrity="${LEAFLET_JS_SRI}" crossorigin=""></script>
<script>
(function(){
  const TOKEN = ${safeJson(token)};
  const INITIAL_STATE = ${safeJson(initial)};
  ${JS}
})();
</script>
</body>
</html>`;
}

/**
 * Friendly 404 page. No mention of what a valid token looks like — do not
 * leak whether the token ever existed. Same visual shell as the main page.
 */
export function renderNotFound(): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>מעקב | ${BRAND}</title>
<style>${CSS}</style>
</head>
<body>
<header>${BRAND}</header>
<main>
  <h1 id="hero">הקישור אינו תקף</h1>
  <div class="muted">אם הגעת לכאן בטעות — פנה אלינו במספר המשרד.</div>
</main>
<footer>© ${BRAND}</footer>
</body>
</html>`;
}
