/**
 * Green API instance-health monitor.
 *
 * Green API is an unofficial WhatsApp-Web transport — the WhatsApp session
 * lives on a physical phone that scanned the QR. If the phone dies, loses
 * Wi-Fi, gets its WhatsApp Business app killed by Android battery optimization,
 * or Green API detects a "yellow card" pre-ban warning, the bot goes silent
 * with NO error message on our side (`sendMessage` calls just queue up on
 * Green API's server for up to 24h before being dropped).
 *
 * This module surfaces that class of failure via two paths, wired by the
 * webhook and the scheduler:
 *
 *  1. REACTIVE — a `stateInstanceChanged` webhook fires when Green API detects
 *     the instance state has changed. Requires the console setting
 *     `stateInstanceChanged=ON` (docs/GREENAPI_OPS.md §1).
 *
 *  2. PROACTIVE — every 5 min the scheduler polls `GET /getStateInstance`.
 *     Works even if the webhook setting is off; also catches slow-degrading
 *     failures (e.g. yellowCard) that don't fire a webhook.
 *
 * Both paths funnel into `handleGreenApiStateChange` for dedup + Hebrew
 * alert delivery to OPS_ALERT_NAMES (see services/specialUsers.ts). Dedup is
 * in-memory (module-scoped): we alert on TRANSITION (state changed vs. last
 * known) plus a floor of one "still broken" reminder per RE_ALERT_INTERVAL_MS
 * so a phone left dead all night doesn't spam every 5 minutes.
 *
 * The alert message itself is intentionally simple text (numbered checklist)
 * — no interactive buttons — because if Green API is broken, buttons rendered
 * as numbered text will queue behind the outage anyway. The alert goes through
 * the SAME provider (Green API) that's failing, which is a known limitation:
 * if Green API is fully down, the alert may not deliver in real time either.
 * It will still deliver as soon as the transport recovers.
 */
import { moduleLogger } from '../utils/logger';
import { getOpsAlertPhones } from './specialUsers';
import { sendOpsAlertText } from '../whatsapp/sender';

const log = moduleLogger('greenapi-health');

const API_URL     = (process.env.GREENAPI_API_URL ?? 'https://api.green-api.com').replace(/\/+$/, '');
const ID_INSTANCE = () => process.env.GREENAPI_ID_INSTANCE ?? '';
const API_TOKEN   = () => process.env.GREENAPI_API_TOKEN_INSTANCE ?? '';

/** Values Green API returns for `stateInstance`. Anything else is treated as unknown. */
export type GreenApiState =
  | 'authorized'    // green — connected, all good
  | 'notAuthorized' // needs a fresh QR scan (session expired / logged out)
  | 'blocked'       // banned by WhatsApp
  | 'sleepMode'     // instance stopped (not paused — actually stopped)
  | 'starting'      // instance is booting
  | 'yellowCard'    // pre-ban warning
  | 'unknown';      // unparseable / never seen

const OK_STATE: GreenApiState = 'authorized';

/** Cool down between "still broken" reminders when the state stays bad. */
const RE_ALERT_INTERVAL_MS = 30 * 60 * 1000; // 30 min

// ── Module-scoped transition dedup ────────────────────────────────────────────
// Not persisted — a restart just re-alerts, which is desirable ("bot restarted
// and state is still bad" is useful ops info). Multi-instance deploys use the
// scheduler's advisory lock, so only one instance polls at a time.

let lastKnownState: GreenApiState | null = null;
let lastAlertAt: number = 0;

/** Reset internal dedup state — for tests. */
export function __resetHealthStateForTests(): void {
  lastKnownState = null;
  lastAlertAt = 0;
}

// ── Public: called by the webhook + the poll ──────────────────────────────────

/**
 * Called from the webhook (source='webhook') OR the scheduler poll (source='poll').
 * Decides whether to alert based on state transition + cooldown, and sends the
 * WhatsApp alert to every ops recipient.
 */
export async function handleGreenApiStateChange(
  raw: string | null | undefined,
  source: 'webhook' | 'poll',
): Promise<void> {
  const state = normalizeState(raw);
  const prev = lastKnownState;
  const now  = Date.now();

  // Update last-known BEFORE deciding — a crash mid-alert must not re-drive the
  // same transition on the next tick.
  lastKnownState = state;

  const isOk       = state === OK_STATE;
  const wasOk      = prev === OK_STATE || prev === null;
  const changed    = state !== prev;
  const cooldownOk = now - lastAlertAt >= RE_ALERT_INTERVAL_MS;

  let shouldAlert = false;
  let reason: 'went_bad' | 'recovered' | 'still_bad' | null = null;

  if (!isOk && wasOk) {
    // authorized → anything bad, OR first-ever observation of a bad state
    shouldAlert = true;
    reason = 'went_bad';
  } else if (isOk && !wasOk) {
    // recovery — but only alert if we alerted on the outage in the first place
    shouldAlert = true;
    reason = 'recovered';
  } else if (!isOk && !wasOk && (changed || cooldownOk)) {
    // still bad — re-alert if the specific bad state changed
    // (notAuthorized → blocked is worth surfacing) OR the cooldown elapsed.
    shouldAlert = true;
    reason = 'still_bad';
  }

  log.info(
    { source, state, prev, shouldAlert, reason },
    'Green API state observed',
  );

  if (!shouldAlert) return;

  lastAlertAt = now;
  const message = buildAlertMessage(state, reason ?? 'went_bad', source);
  await sendToOpsRecipients(message);
}

/**
 * One-shot poll of `getStateInstance`. Returns the normalized state (or 'unknown'
 * on any error) and feeds `handleGreenApiStateChange`. Idempotent.
 */
export async function pollGreenApiState(): Promise<GreenApiState> {
  const id    = ID_INSTANCE();
  const token = API_TOKEN();

  if (!id || !token) {
    log.warn('Green API credentials missing — skipping health poll');
    return 'unknown';
  }

  const url = `${API_URL}/waInstance${id}/getStateInstance/${token}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      log.warn({ status: res.status }, 'getStateInstance returned non-2xx — treated as transient, no alert');
      return 'unknown';
    }

    const body = (await res.json()) as { stateInstance?: string };
    const state = normalizeState(body?.stateInstance);
    await handleGreenApiStateChange(state, 'poll');
    return state;
  } catch (err) {
    // Transient network failure — a getStateInstance call that can't leave our
    // host is an infrastructure problem separate from "phone died". Don't spam
    // the ops recipients about it; a persistent problem will surface on the next
    // successful poll returning a non-authorized state.
    log.error({ err }, 'getStateInstance request failed — treated as transient, no alert');
    return 'unknown';
  }
}

// ── Message construction ──────────────────────────────────────────────────────

function buildAlertMessage(
  state: GreenApiState,
  reason: 'went_bad' | 'recovered' | 'still_bad',
  source: 'webhook' | 'poll',
): string {
  const via = source === 'webhook' ? 'התראה של Green API' : 'בדיקה תקופתית';

  if (reason === 'recovered') {
    return (
      '✅ *הבוט חזר לפעולה*\n' +
      '\n' +
      `סטטוס Green API: *${state}* (${via})\n` +
      'הודעות יוצאות ונכנסות אמורות לעבוד שוב.'
    );
  }

  const header =
    reason === 'still_bad'
      ? '⚠️ *הבוט עדיין מנותק*'
      : '🚨 *הבוט מנותק מ-WhatsApp*';

  const explain = explainState(state);

  return (
    `${header}\n` +
    '\n' +
    `סטטוס Green API: *${state}*\n` +
    `זוהה דרך: ${via}\n` +
    '\n' +
    `${explain}\n` +
    '\n' +
    '*מה לבדוק בטלפון של הבוט:*\n' +
    '1. WhatsApp Business פתוח (לא נסגר על ידי אנדרואיד)\n' +
    '2. הטלפון מחובר לחשמל ול-Wi-Fi יציב\n' +
    '3. סוללה → הגדרות → אפליקציות → WhatsApp Business → "ללא הגבלה"\n' +
    '4. אם המצב הוא notAuthorized — צריך לסרוק QR מחדש בקונסולה של Green API'
  );
}

function explainState(state: GreenApiState): string {
  switch (state) {
    case 'notAuthorized':
      return 'הסשן פג — יש לסרוק QR מחדש דרך https://console.green-api.com.';
    case 'blocked':
      return 'המספר נחסם על ידי WhatsApp. יש לבדוק דחוף בקונסולה של Green API.';
    case 'sleepMode':
      return 'האינסטנס במצב שינה. הפעל מחדש בקונסולה של Green API.';
    case 'starting':
      return 'האינסטנס עולה כרגע — אם זה נמשך יותר מכמה דקות, זה סימן לתקלה.';
    case 'yellowCard':
      return '⚠️ אזהרת קדם-חסימה מ-WhatsApp. הפחת בדחיפות את קצב השליחה בקונסולה.';
    case 'unknown':
      return 'סטטוס לא ידוע — יכול להיות תקלת רשת או תגובה חריגה מ-Green API.';
    case 'authorized':
      return 'הכל תקין.';
  }
}

// ── Delivery ──────────────────────────────────────────────────────────────────

async function sendToOpsRecipients(text: string): Promise<void> {
  let recipients: string[] = [];
  try {
    recipients = await getOpsAlertPhones();
  } catch (err) {
    log.error({ err }, 'Failed to resolve ops-alert recipients');
    return;
  }

  if (recipients.length === 0) {
    log.warn('No ops-alert recipients configured — Green API alert dropped');
    return;
  }

  for (const to of recipients) {
    try {
      // sendOpsAlertText bypasses WHATSAPP_OUTBOUND_SUPPRESSED + Green-API
      // preflight. The alert about "outbound is blocked / Green API is offline"
      // must not itself be blocked by the same mechanism it's warning about.
      await sendOpsAlertText({ to, text });
    } catch (err) {
      log.error({ err, to }, 'Failed to send Green API alert');
    }
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

const KNOWN_STATES: ReadonlySet<GreenApiState> = new Set([
  'authorized', 'notAuthorized', 'blocked', 'sleepMode', 'starting', 'yellowCard',
]);

function normalizeState(raw: string | null | undefined): GreenApiState {
  if (!raw || typeof raw !== 'string') return 'unknown';
  return KNOWN_STATES.has(raw as GreenApiState) ? (raw as GreenApiState) : 'unknown';
}
