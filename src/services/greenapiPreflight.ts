/**
 * Green API outbound preflight — decide whether the WhatsApp phone is reachable
 * BEFORE issuing `sendMessage`, so that a phone-side outage doesn't cause the
 * REST endpoint to silently queue the message for 24h and then flood users on
 * reconnect (2026-07-19 incident).
 *
 * Why it exists:
 *   `/sendMessage` returns HTTP 200 + idMessage EVEN when the phone socket is
 *   offline — the message is accepted into Green API's server-side 24h queue.
 *   From the bot's point of view every send looks successful; a dedup row is
 *   written with status='SENT', and the batch delivers as a "surprise" flood
 *   when the socket recovers.
 *
 *   This module gives the provider a way to ask "is it worth trying now?"
 *   using two Green API endpoints:
 *     - getStateInstance   → authorized | notAuthorized | yellowCard | ...
 *     - getStatusInstance  → online | offline (socket state)
 *
 *   Block ONLY on states that genuinely prevent delivery — see `decide()` for
 *   the exact list. `yellowCard` is a WhatsApp SOFT warning ("slow down or
 *   risk a ban"); messages STILL deliver during yellowCard, so we do NOT
 *   block on it — the right lever is `delaySendMessagesMilliseconds` in the
 *   console, not silencing the bot for ~24h. The 2026-07-19 incident was
 *   caused by `statusInstance=offline`, which we DO block.
 *
 * Fail-open policy (deliberate):
 *   - The check itself failed (network / timeout / non-2xx / missing creds)
 *     → allow=true (do not silence the bot on top of a REST outage).
 *   - The check succeeded and returned a bad signal (offline / yellowCard / …)
 *     → allow=false (definitive).
 *   These two paths are DIFFERENT and must not be conflated. `source` on the
 *   returned decision distinguishes them (`check-failed` vs `live`/`cache`).
 *
 * Cost: a 30-second in-memory TTL cache. A burst of 18 digests at 08:00 pays
 * at most one live check (2 parallel HTTP calls, 3s timeout each); every
 * subsequent send hits the cache.
 *
 * This module lives here (services/) and NOT inside greenapiHealth.ts to avoid
 * a circular import: greenapi.ts imports this module; greenapiHealth.ts imports
 * sender.ts; sender.ts imports provider.ts; provider.ts imports greenapi.ts.
 * Keeping preflight standalone breaks the cycle.
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('greenapi-preflight');

const API_URL     = () => (process.env.GREENAPI_API_URL ?? 'https://api.green-api.com').replace(/\/+$/, '');
const ID_INSTANCE = () => process.env.GREENAPI_ID_INSTANCE ?? '';
const API_TOKEN   = () => process.env.GREENAPI_API_TOKEN_INSTANCE ?? '';

/** How long a fresh live snapshot is trusted before we re-fetch. */
const CACHE_TTL_MS    = 30_000;
/** Per-call timeout for the live health check (both endpoints combined). */
const LIVE_TIMEOUT_MS = 3_000;

type StateInstance =
  | 'authorized'
  | 'notAuthorized'
  | 'blocked'
  | 'sleepMode'
  | 'starting'
  | 'yellowCard'
  | 'unknown';

type StatusInstance = 'online' | 'offline' | 'unknown';

interface HealthSnapshot {
  stateInstance:  StateInstance;
  statusInstance: StatusInstance;
  observedAt:     number;
}

let lastSnapshot: HealthSnapshot | null = null;

/**
 * `source`:
 *   'cache'         — reused a snapshot within CACHE_TTL_MS.
 *   'live'          — fetched fresh; both endpoints returned something.
 *   'check-failed'  — the fetch itself threw (network / timeout / non-2xx /
 *                     missing creds). ALWAYS pairs with allow=true (fail-open).
 */
export interface PreflightDecision {
  allow:  boolean;
  reason: string;
  source: 'cache' | 'live' | 'check-failed';
}

export async function checkOutboundHealth(): Promise<PreflightDecision> {
  const now = Date.now();
  if (lastSnapshot && now - lastSnapshot.observedAt < CACHE_TTL_MS) {
    return decide(lastSnapshot, 'cache');
  }
  let snap: HealthSnapshot;
  try {
    snap = await fetchLive(LIVE_TIMEOUT_MS);
  } catch (err) {
    // The check itself failed. Fail-open: we cannot say the phone is down,
    // and silencing the bot on top of a Green API REST outage is worse than
    // letting httpDelivery.ts's retry+DLQ own the real-send failure path.
    const msg = (err as Error).message;
    log.warn({ err: msg }, 'preflight: check failed — fail-open (allow send)');
    return { allow: true, reason: `check_failed: ${msg}`, source: 'check-failed' };
  }
  lastSnapshot = snap;
  return decide(snap, 'live');
}

function decide(snap: HealthSnapshot, source: 'cache' | 'live'): PreflightDecision {
  // Two DIFFERENT classes of "not authorized":
  //
  //   HARD BLOCKERS (sends genuinely cannot deliver):
  //     notAuthorized   — QR expired / logged out. Message enters queue but
  //                       never leaves.
  //     blocked         — WhatsApp banned the account. Never delivers.
  //     sleepMode       — Instance is stopped. Not just paused — stopped.
  //     statusInstance=offline — Phone-side socket detached from Green API.
  //                       Green API's 24h queue accepts but the phone won't
  //                       deliver until it reconnects. THIS was the actual
  //                       2026-07-19 failure mode (state=authorized + socket
  //                       down).
  //
  //   SOFT WARNINGS (sends WORK, just at risk):
  //     yellowCard      — WhatsApp pre-ban warning. Messages ARE delivered.
  //                       Blocking here would silence the bot for ~24h for a
  //                       warning that only asks for reduced volume — the
  //                       right lever is `delaySendMessagesMilliseconds` in
  //                       the Green API console, not stopping outbound. Ops
  //                       is already alerted via handleGreenApiStateChange.
  //     starting        — Transient bootup, will resolve in seconds.
  //     unknown         — Never seen state string; fail-open rather than
  //                       silence on a Green API schema change.
  //
  // Rationale: the 19/07 incident happened because status=offline was
  // silently accepting sends into a dead queue, NOT because yellowCard was
  // ignored. Blocking on yellowCard adds no protection against escalation to
  // `blocked` — volume management does. Blocking on yellowCard DOES prevent
  // in-window customer replies and daily digests during the warning window.
  const FATAL_STATES = new Set<StateInstance>(['notAuthorized', 'blocked', 'sleepMode']);
  if (FATAL_STATES.has(snap.stateInstance)) {
    return { allow: false, reason: `stateInstance=${snap.stateInstance}`, source };
  }
  if (snap.statusInstance === 'offline') {
    return { allow: false, reason: `statusInstance=offline`, source };
  }
  return {
    allow: true,
    reason: `${snap.stateInstance} + ${snap.statusInstance}`,
    source,
  };
}

async function fetchLive(timeoutMs: number): Promise<HealthSnapshot> {
  const id    = ID_INSTANCE();
  const token = API_TOKEN();
  if (!id || !token) throw new Error('missing Green API credentials');

  const base      = API_URL();
  const stateUrl  = `${base}/waInstance${id}/getStateInstance/${token}`;
  const statusUrl = `${base}/waInstance${id}/getStatusInstance/${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [stateRes, statusRes] = await Promise.all([
      fetch(stateUrl,  { method: 'GET', signal: controller.signal }),
      fetch(statusUrl, { method: 'GET', signal: controller.signal }),
    ]);
    if (!stateRes.ok)  throw new Error(`getStateInstance ${stateRes.status}`);
    if (!statusRes.ok) throw new Error(`getStatusInstance ${statusRes.status}`);
    const stateBody  = (await stateRes.json())  as { stateInstance?:  string };
    const statusBody = (await statusRes.json()) as { statusInstance?: string };
    return {
      stateInstance:  normalizeState(stateBody?.stateInstance),
      statusInstance: normalizeStatus(statusBody?.statusInstance),
      observedAt:     Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

const KNOWN_STATES: ReadonlySet<StateInstance> = new Set<StateInstance>([
  'authorized', 'notAuthorized', 'blocked', 'sleepMode', 'starting', 'yellowCard',
]);

function normalizeState(raw: string | null | undefined): StateInstance {
  if (typeof raw !== 'string' || !raw) return 'unknown';
  return KNOWN_STATES.has(raw as StateInstance) ? (raw as StateInstance) : 'unknown';
}

function normalizeStatus(raw: string | null | undefined): StatusInstance {
  return raw === 'online' ? 'online' : raw === 'offline' ? 'offline' : 'unknown';
}

/** Test-only: clear the cached snapshot so the next call refetches. */
export function __resetPreflightCacheForTests(): void {
  lastSnapshot = null;
}
