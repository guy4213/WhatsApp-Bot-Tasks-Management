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
  const TERMINAL = new Set(['FINISHED','CANCELED','EXPIRED','SUPERSEDED']);
  const IL_TZ = 'Asia/Jerusalem';
  const HERO = {
    ACTIVE:     'הבודק בדרך אליך',
    ARRIVED:    'הבודק הגיע לאתר',
    FINISHED:   'הבדיקה הסתיימה. תודה!',
    CANCELED:   'המעקב אינו פעיל',
    EXPIRED:    'המעקב אינו פעיל',
    SUPERSEDED: 'המעקב אינו פעיל'
  };

  let pollTimer = null;
  let backoff = 0;
  let map = null, marker = null, accuracyCircle = null;
  let lastState = null;

  const $ = (id) => document.getElementById(id);

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

  function ensureMap(lat, lng) {
    if (!window.L) return; // Leaflet script hasn't loaded (offline / SRI mismatch)
    if (!map) {
      map = L.map('map', { attributionControl: true }).setView([lat, lng], 14);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
      }).addTo(map);
      marker = L.marker([lat, lng]).addTo(map);
    } else {
      marker.setLatLng([lat, lng]);
      map.setView([lat, lng]);
    }
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
  }

  function applyState(state) {
    lastState = state;
    document.body.className = 'state-' + state.status;

    $('hero').textContent = HERO[state.status] || HERO.CANCELED;

    // ETA card — only ACTIVE, only when we actually have data.
    const showEta = state.status === 'ACTIVE'
      && (state.etaMinutes != null || state.expectedArrivalAt);
    if (showEta) {
      $('eta-card').classList.remove('hidden');
      $('eta-time').textContent = state.expectedArrivalAt
        ? ('הגעה משוערת: ' + formatIlTime(state.expectedArrivalAt))
        : '';
      $('eta-relative').textContent = state.etaMinutes != null
        ? ('בעוד כ־' + state.etaMinutes + ' דקות')
        : '';
    } else {
      $('eta-card').classList.add('hidden');
    }

    // Map — only when ACTIVE|ARRIVED and location present.
    const showLoc = (state.status === 'ACTIVE' || state.status === 'ARRIVED')
      && state.lastLocation
      && Number.isFinite(state.lastLocation.lat)
      && Number.isFinite(state.lastLocation.lng);
    if (showLoc) {
      $('map').classList.remove('hidden');
      ensureMap(state.lastLocation.lat, state.lastLocation.lng);
      updateAccuracy(state.lastLocation.lat, state.lastLocation.lng, state.lastLocation.accuracy);
    } else {
      $('map').classList.add('hidden');
      $('accuracy-notice').classList.add('hidden');
      destroyMap();
    }

    updateRelative();
  }

  function updateRelative() {
    if (!lastState) return;
    const line = $('updated-line');
    if (TERMINAL.has(lastState.status)) { line.textContent = ''; return; }
    const ts = (lastState.lastLocation && lastState.lastLocation.at) || lastState.updatedAt;
    line.textContent = ts ? ('עודכן ' + formatRelative(ts)) : '';
  }

  function nextDelay(status) {
    if (TERMINAL.has(status)) return null;
    if (status === 'ARRIVED') return POLL_ARRIVED_MS;
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
      const d = nextDelay(state.status);
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
  setInterval(updateRelative, 1000);
  if (!TERMINAL.has(INITIAL_STATE.status)) {
    const d = nextDelay(INITIAL_STATE.status) || POLL_ACTIVE_MS;
    pollTimer = setTimeout(poll, d);
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
  <div id="eta-card" class="card hidden">
    <div id="eta-time" class="eta-time"></div>
    <div id="eta-relative" class="eta-relative"></div>
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
