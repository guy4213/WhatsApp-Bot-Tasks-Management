/**
 * Pure WhatsApp digest formatters.
 *
 * Each formatter returns `{ text, params }`:
 *   - `params` — the ordered template body variables (compact COUNTS only). These
 *     are what an approved out-of-window template renders.
 *   - `text`   — the RICH in-window free-form message (counts + per-employee
 *     breakdown + unfinished titles), used by notify()'s fallback path while
 *     templates are disabled.
 *
 * No DB / network imports — kept pure so it is trivially unit-testable.
 *
 * Morning = "opening day plan" (what's ahead today).
 * Evening = "end-of-day report" — current end-of-day STATUS, not a "completed
 * today" historical claim (V1 has no reliable completedAt). The evening messages
 * are explicitly labelled "סטטוס נוכחי לסוף היום".
 */
import type { NotificationKey } from './templateNames';
import type {
  EmployeeEndOfDay,
  CompanyMorning,
  CompanyEndOfDay,
} from '../services/tasks';
import type {
  EquipmentChecklistItem,
  InspectionListItem,
} from '../services/inspectionsQueries';
import type {
  FieldExceptionCounts,
  OpenFieldException,
} from '../services/exceptionsQueries';
import type { YoramLeadCounts } from '../services/incomingLeads';
import { problemTypeMenu } from '../ai/menu';
import { DIGEST_PAYLOAD_IDS } from '../ai/digestCommands';
import { fieldStatusHe } from '../ai/inspectionFormatters';

/** One WhatsApp quick-reply button. `id` is a stable digest payload id. */
export interface DigestButton {
  id: string;
  title: string; // ≤ 20 chars (Meta limit)
}

export interface DigestContent {
  text: string;            // rich free-form (in-window)
  params: string[];        // ordered template vars (compact counts)
  buttons: DigestButton[]; // quick-reply buttons (in-window); also the template's quick replies
}

// Shared button labels (each ≤ 20 chars).
const BTN_FREE_TEXT: DigestButton = { id: DIGEST_PAYLOAD_IDS.FREE_TEXT, title: 'כתיבה חופשית' };
const BTN_EMP_TODAY: DigestButton = { id: DIGEST_PAYLOAD_IDS.EMP_TODAY, title: 'משימות להיום' };
const BTN_EMP_EOD: DigestButton = { id: DIGEST_PAYLOAD_IDS.EMP_EOD, title: 'דוח סוף יום שלי' };
const BTN_TEAM_TODAY: DigestButton = { id: DIGEST_PAYLOAD_IDS.TEAM_TODAY, title: 'משימות להיום בצוות' };
const BTN_TEAM_EOD: DigestButton = { id: DIGEST_PAYLOAD_IDS.TEAM_EOD, title: 'דוח סוף יום צוות' };

/** CTA line — tap a button, or type the exact command / free text. */
const cta = (cmd: string) => `👇 לחץ על הכפתור לפירוט, או כתוב "${cmd}" / "כתיבה חופשית".`;

export type DigestType = 'MORNING' | 'EVENING';

/** Current end-of-day status label — reused so the wording stays consistent. */
const EOD_STATUS_LABEL = 'סטטוס נוכחי לסוף היום';

/**
 * Map a user's role + digest type to its template key. ADMIN reuses the MANAGER
 * templates (company-wide scope in V1).
 */
export function digestTemplateKey(
  user: { isElevated: boolean },
  type: DigestType,
): NotificationKey {
  if (type === 'MORNING') {
    return user.isElevated ? 'MANAGER_MORNING_DIGEST' : 'EMPLOYEE_MORNING_DIGEST';
  }
  return user.isElevated ? 'MANAGER_END_OF_DAY_REPORT' : 'EMPLOYEE_END_OF_DAY_REPORT';
}

// ── Morning ("opening day plan") ──────────────────────────────────────────────
//
// X-T3 (2026-07-01): the old CRM `formatEmployeeMorning` used to live here. It
// was replaced by the inspector morning digest below (D2-T4) which is what all
// non-ADMIN users now receive via the K1 branch in `digestDispatcher.ts`. The
// old employee-tasks morning path is dead code — deleted. The corresponding
// service helper `getEmployeeMorningCounts` in `src/services/tasks.ts` is
// removed alongside it. The 17:00 employee evening broadcast (`runDailySummary`)
// is a separate legacy path already gated by `LEGACY_DAILY_SUMMARY_ENABLED` in
// `src/scheduler/index.ts` — out of X-T3 scope, left dormant.

// ── Inspector morning (D2-T4) ────────────────────────────────────────────────
//
// Galit v2 §7 "morning reminder" — inspectors get a numbered list of today's
// field inspections with a status-update CTA. Non-ADMIN users are routed here
// by the dispatcher (per K1: `user.role !== 'ADMIN'` == inspector). No
// per-role emoji noise — the v2 spec calls for clean output.

/**
 * Localize a `fieldStatus` code. D5-T19c: this used to be a second,
 * independently-maintained copy of the Hebrew label table (missing DECLINED
 * / CANCELED, which meant those two statuses displayed as the raw enum in
 * the worker's morning digest / day list). Delegates to the single shared
 * table in `inspectionFormatters.ts` so the two can never drift again.
 */
function fieldStatusLabelHe(status: string): string {
  return fieldStatusHe(status);
}

/**
 * Inspector morning — numbered list of today's field inspections + a CTA to
 * update status by number or free text/voice. Empty list → a one-line "no
 * inspections today" note (spec §7). Template vars: name + count (compact
 * template render uses just the count; the rich in-window text carries the
 * full list). Missing `customerName` / `siteAddress` degrade to Hebrew
 * placeholders — DO NOT invent data.
 */
export function formatInspectorMorning(
  items: InspectionListItem[],
  user: { name: string | null },
): DigestContent {
  const name = user.name ?? '';
  const params = [name, String(items.length)];

  if (items.length === 0) {
    const text =
      `בוקר טוב ${name},\n` +
      `אין בדיקות משובצות להיום.`;
    return { text, params, buttons: [] };
  }

  const lines = items.map((item, i) => {
    const customer = item.customerName ?? 'לקוח לא ידוע';
    const address = item.siteAddress ?? 'כתובת לא ידועה';
    const city = item.siteCity ? `, ${item.siteCity}` : '';
    const statusHe = fieldStatusLabelHe(item.fieldStatus);
    return `${i + 1}. ${customer} — ${address}${city} (${item.typeLabelHe})\n` +
           `   סטטוס: ${statusHe}`;
  });

  const text =
    `בוקר טוב ${name},\n` +
    `הבדיקות שלך להיום:\n\n` +
    `${lines.join('\n')}\n\n` +
    `בחר מספר לעדכון סטטוס, או כתוב חופשי (למשל: יצאתי / הגעתי / סיימתי).`;

  return { text, params, buttons: [] };
}

/**
 * On-demand inspector day list — invoked from worker menu items 1 (today) and
 * 2 (tomorrow). Reuses the same status labels + numbered layout as
 * `formatInspectorMorning`, but with a menu-friendly header (no "בוקר טוב")
 * and no template-params return (this is a one-off in-window send, not a
 * scheduled digest). Returns the raw Hebrew string.
 */
export function formatInspectorDayList(
  items: InspectionListItem[],
  opts: { when: 'today' | 'tomorrow' },
): string {
  const whenLabel = opts.when === 'today' ? 'להיום' : 'למחר';
  if (items.length === 0) {
    return `אין בדיקות משובצות ${whenLabel}.`;
  }
  const lines = items.map((item, i) => {
    const customer = item.customerName ?? 'לקוח לא ידוע';
    const address = item.siteAddress ?? 'כתובת לא ידועה';
    const city = item.siteCity ? `, ${item.siteCity}` : '';
    const statusHe = fieldStatusLabelHe(item.fieldStatus);
    return `${i + 1}. ${customer} — ${address}${city} (${item.typeLabelHe})\n` +
           `   סטטוס: ${statusHe}`;
  });
  return `הבדיקות שלך ${whenLabel}:\n\n${lines.join('\n')}`;
}

/** Manager/Admin morning — company totals + per-employee breakdown. Template vars: name + 4 counts. */
export function formatManagerMorning(name: string, co: CompanyMorning): DigestContent {
  const params = [
    name,
    String(co.dueToday),
    String(co.overdue),
    String(co.open),
    String(co.employeesWithOverdue),
  ];

  const lines = co.employees.map((e) => {
    const flag = e.overdue > 0 ? ' ⚠️' : '';
    return `• ${e.ownerName}: ${e.dueToday} להיום, ${e.overdue} באיחור, ${e.open} פתוחות${flag}`;
  });

  const breakdown = lines.length
    ? `\n\nפירוט לפי עובד:\n${lines.join('\n')}`
    : '';

  const text =
    `☀️ בוקר טוב ${name}!\n` +
    `תמונת בוקר לצוות:\n` +
    `📋 ${co.dueToday} להיום · ⚠️ ${co.overdue} באיחור · 🔄 ${co.open} פתוחות\n` +
    `👥 ${co.employeesWithOverdue} עובדים עם משימות באיחור` +
    breakdown +
    `\n\n${cta('משימות להיום בצוות')}`;

  return { text, params, buttons: [BTN_TEAM_TODAY, BTN_FREE_TEXT] };
}

// ── Evening ("end-of-day report" — current status) ────────────────────────────

/** Employee end-of-day — current status of own tasks + unfinished titles. Template vars: name + 5 counts. */
export function formatEmployeeEndOfDay(name: string, e: EmployeeEndOfDay): DigestContent {
  const params = [
    name,
    String(e.dueToday),
    String(e.completed),
    String(e.notCompleted),
    String(e.overdue),
    String(e.openCarry),
  ];

  const unfinished = e.unfinishedTitles.length
    ? `\n\nמשימות שטרם הושלמו:\n${e.unfinishedTitles.map((t) => `• ${t}`).join('\n')}`
    : '';

  const text =
    `🌆 ערב טוב ${name}!\n` +
    `דוח סוף יום — ${EOD_STATUS_LABEL}:\n` +
    `מתוך ${e.dueToday} משימות להיום: ✅ ${e.completed} בוצעו · ❌ ${e.notCompleted} לא בוצעו\n` +
    `⚠️ ${e.overdue} באיחור · 🔄 ${e.openCarry} פתוחות שעוברות למחר` +
    unfinished +
    `\n\n${cta('דוח סוף יום שלי')}`;

  return { text, params, buttons: [BTN_EMP_EOD, BTN_FREE_TEXT] };
}

/** Manager/Admin end-of-day — company current status + per-employee breakdown. Template vars: name + 6 counts. */
export function formatManagerEndOfDay(name: string, co: CompanyEndOfDay): DigestContent {
  const params = [
    name,
    String(co.dueToday),
    String(co.completed),
    String(co.notCompleted),
    String(co.overdue),
    String(co.openCarry),
    String(co.employeesWithUnfinishedOrOverdue),
  ];

  const lines = co.employees.map((e) => {
    const flag = e.notCompleted > 0 || e.overdue > 0 ? ' ⚠️' : '';
    return `• ${e.ownerName}: ${e.dueToday} להיום, ✅ ${e.completed} בוצעו, ❌ ${e.notCompleted} לא בוצעו, ${e.overdue} באיחור${flag}`;
  });

  const breakdown = lines.length
    ? `\n\nפירוט לפי עובד:\n${lines.join('\n')}`
    : '';

  const text =
    `🌆 ערב טוב ${name}!\n` +
    `דוח סוף יום (צוות) — ${EOD_STATUS_LABEL}:\n` +
    `מתוך ${co.dueToday} להיום: ✅ ${co.completed} בוצעו · ❌ ${co.notCompleted} לא בוצעו\n` +
    `⚠️ ${co.overdue} באיחור · 🔄 ${co.openCarry} פתוחות למחר\n` +
    `👥 ${co.employeesWithUnfinishedOrOverdue} עובדים עם משימות פתוחות/באיחור` +
    breakdown +
    `\n\n${cta('דוח סוף יום צוות')}`;

  return { text, params, buttons: [BTN_TEAM_EOD, BTN_FREE_TEXT] };
}

// ── Galit v2 manager (Yoram) — D4-T1 ─────────────────────────────────────────
//
// SPEC_FIELD_V2 §13 — Yoram gets a compact exceptions digest (morning +
// evening). The FIELD portion (5 counts + numbered "פתוחים:" list) is what this
// module renders. The LEADS portion is B2-blocked (columns of `lead incoming`
// not resolved yet); a visually distinct TODO placeholder line stands in until
// B2 lands.
//
// Content style follows the spec verbatim — no emojis, no CTA button (Yoram
// reads and reacts in the CRM, not the bot).

/** Hebrew label for a `TaskField.problemType` code (7 CHECK values in migration 009). */
function problemTypeLabelHe(code: string): string {
  const item = problemTypeMenu().find((p) => p.problemType === code);
  return item?.label ?? code;
}

/**
 * Labeled multi-line counts block per product-owner UX update.
 *
 * שטח:
 * - בוצעו: X
 * - לא אושרו: Y
 * - עם בעיה: Z
 * - ממתין למידע: W
 * - לא סגרו יום: V
 */
function formatCountsBlock(c: FieldExceptionCounts): string {
  return (
    `שטח:\n` +
    `- בוצעו: ${c.finishedFieldToday}\n` +
    `- לא אושרו: ${c.notConfirmedToday}\n` +
    `- עם בעיה: ${c.hasProblemToday}\n` +
    `- ממתין למידע: ${c.waitingForInfoToday}\n` +
    `- לא סגרו יום: ${c.notClosedDayToday}`
  );
}

/**
 * Labeled leads block per product-owner UX update (2026-07-02).
 *
 * לידים:
 * - ממתינים מהלילה: N
 *
 * Product decision: the CEO-facing digest must show only ACTIONABLE overnight
 * leads (received overnight AND still unassigned). A raw arrival count would
 * mislead the reader into thinking work exists when the leads may already be
 * assigned. `lc.overnight` is now the shared source of truth with Sasha's
 * pending queue (`findOvernightUnassignedLeads`) — same predicate, same number.
 *
 * `lc.unassigned` (legacy total-open-queue snapshot) is intentionally NOT
 * rendered; kept as a `YoramLeadCounts` field only for `params` slot stability.
 */
function formatLeadsBlock(lc: YoramLeadCounts): string {
  return (
    `לידים:\n` +
    `- ממתינים מהלילה: ${lc.overnight}`
  );
}

/** Render one row of the numbered "פתוחים:" list. */
function formatExceptionRow(ex: OpenFieldException, n: number): string {
  const worker   = ex.workerName   ?? 'עובד לא ידוע';
  const customer = ex.customerName ?? 'לקוח לא ידוע';
  const note =
    ex.note && ex.note.trim().length > 0
      ? ex.note.trim()
      : ex.problemType
        ? problemTypeLabelHe(ex.problemType)
        : '—';
  return `${n}. ${worker} — ${customer}: ${note}`;
}

/**
 * Yoram morning — §13 format.
 *
 * Template vars (compact): [name, 5 counts, overnight leads, unassigned leads].
 * Rich text carries the full open-exceptions list and the leads summary line.
 * Empty open-exceptions list renders a one-liner "אין חריגים פתוחים." between
 * the counts and leads blocks.
 */
export function formatGalitManagerMorning(input: {
  counts: FieldExceptionCounts;
  exceptions: OpenFieldException[];
  user: { name: string | null };
  leadCounts: YoramLeadCounts;
}): DigestContent {
  const { counts, exceptions, user, leadCounts } = input;
  const name = user.name ?? '';
  const params = [
    name,
    String(counts.finishedFieldToday),
    String(counts.notConfirmedToday),
    String(counts.hasProblemToday),
    String(counts.waitingForInfoToday),
    String(counts.notClosedDayToday),
    String(leadCounts.overnight),
    String(leadCounts.unassigned),
  ];

  const openBlock = exceptions.length === 0
    ? 'אין חריגים פתוחים.'
    : `פתוחים:\n${exceptions.map((e, i) => formatExceptionRow(e, i + 1)).join('\n')}`;

  const text =
    `סיכום גלית — בוקר טוב ${name}\n\n` +
    `${formatCountsBlock(counts)}\n\n` +
    `${formatLeadsBlock(leadCounts)}\n\n` +
    `${openBlock}`;

  return { text, params, buttons: [] };
}

/**
 * Yoram end-of-day — §13 format.
 *
 * Same shape as the morning; the header line switches to a "סיכום סוף יום"
 * label. Empty open-exceptions list renders the same one-liner.
 * Template vars: [name, 5 counts, overnight leads, unassigned leads].
 */
export function formatGalitManagerEndOfDay(input: {
  counts: FieldExceptionCounts;
  exceptions: OpenFieldException[];
  user: { name: string | null };
  leadCounts: YoramLeadCounts;
}): DigestContent {
  const { counts, exceptions, user, leadCounts } = input;
  const name = user.name ?? '';
  const params = [
    name,
    String(counts.finishedFieldToday),
    String(counts.notConfirmedToday),
    String(counts.hasProblemToday),
    String(counts.waitingForInfoToday),
    String(counts.notClosedDayToday),
    String(leadCounts.overnight),
    String(leadCounts.unassigned),
  ];

  const openBlock = exceptions.length === 0
    ? 'אין חריגים פתוחים.'
    : `פתוחים:\n${exceptions.map((e, i) => formatExceptionRow(e, i + 1)).join('\n')}`;

  const text =
    `סיכום סוף יום — ${name}\n\n` +
    `${formatCountsBlock(counts)}\n\n` +
    `${formatLeadsBlock(leadCounts)}\n\n` +
    `${openBlock}`;

  return { text, params, buttons: [] };
}

// ── Equipment reminder (D2-T9) ───────────────────────────────────────────────
//
// SPEC_FIELD_V2 §10 — after the D2-T4 inspector morning digest, the dispatcher
// sends this ONE consolidated equipment list per worker: for every family the
// worker is inspecting today, list the required checklist items DEDUPED across
// families (so 2 radiation inspections + 1 noise inspection → one merged list,
// with `tripod` appearing exactly once even though both families require it).
//
// D5-T4 button-policy exception: this is one of the two surfaces where
// `sendButtonMessage` is explicitly permitted (the other is the §6 inspection
// card, D2-T2). Every other menu stays numbered text — see the JSDoc on
// `problemTypeMenu` in `src/ai/menu.ts` and on `sendButtonMessage` in
// `src/whatsapp/sender.ts`.

/** Stable equipment-reminder payload IDs.
 *
 *  Deterministic on `userId` + `localDate` so the router can (a) validate the
 *  tap belongs to the tapping user and (b) resolve the intended local day
 *  without a DB lookup. Slashes/whitespace never occur in either component
 *  (userId is a UUID; localDate is 'YYYY-MM-DD'), so a simple '_'-split works.
 */
export function equipmentTakenAllPayloadId(userId: string, localDate: string): string {
  return `EQUIP_ALL_${userId}_${localDate}`;
}
export function equipmentMissingPayloadId(userId: string, localDate: string): string {
  return `EQUIP_MISSING_${userId}_${localDate}`;
}

/**
 * Equipment reminder — deduped by `labelHe`, alphabetically stable within a
 * family block. The 2 buttons match the two allowed responses per §10:
 *   - "לקחתי הכל"   → clear/ack via `EQUIP_ALL_*`
 *   - "חסר לי ציוד" → free-text prompt via `EQUIP_MISSING_*`
 *
 * Empty item list → returns { buttons: [], text: '' } so the dispatcher can
 * short-circuit and skip the send. The dispatcher already guards on the
 * inspection list being non-empty (a worker with 0 inspections doesn't reach
 * this formatter), so this is defense-in-depth for edge cases (checklist seed
 * gap for a new family).
 *
 * Template vars (compact): [name, item count]. Rich text carries the list.
 */
export function formatEquipmentReminder(
  items: EquipmentChecklistItem[],
  user: { id: string; name: string | null; localDate: string },
): DigestContent {
  const name = user.name ?? '';
  // Dedup by labelHe — preserve FIRST occurrence in the (family, sortOrder)
  // order the query returned, so a stable set of dupes always renders the
  // same way. E.g. 'חצובה' is seeded for both radiation and noise; the first
  // family in the input decides where it lands.
  const seen = new Set<string>();
  const uniqueLabels: string[] = [];
  for (const it of items) {
    if (seen.has(it.labelHe)) continue;
    seen.add(it.labelHe);
    uniqueLabels.push(it.labelHe);
  }

  const params = [name, String(uniqueLabels.length)];

  if (uniqueLabels.length === 0) {
    return { text: '', params, buttons: [] };
  }

  const listBlock = uniqueLabels.map((l) => `• ${l}`).join('\n');
  const text =
    `${name ? `היי ${name},\n` : ''}` +
    `לפני שיוצאים לשטח — נא לוודא שכל הציוד נמצא:\n` +
    `${listBlock}`;

  const buttons: DigestButton[] = [
    { id: equipmentTakenAllPayloadId(user.id, user.localDate), title: 'לקחתי הכל' },
    { id: equipmentMissingPayloadId(user.id, user.localDate), title: 'חסר לי ציוד' },
  ];

  return { text, params, buttons };
}

// ── D2-T10: on-demand worker day summary (menu item 7) ──────────────────────
//
// SPEC_FIELD_V2 §11 — a live "day summary" the worker asks for from menu item
// 7. Compact Hebrew, no emojis. Lists the finished inspections in one line
// (deduped, comma-separated by customer name / type family), plus a count of
// WAITING_FOR_INFO rows when > 0. Null customer / type degrade to Hebrew
// placeholders (mirrors `formatInspectorMorning`). No CTA button — the
// follow-up 4-option menu is rendered separately (`renderDaySummaryFollowUpMenu`).

/**
 * Day-summary body per §11. Not a template message (worker asked for it in
 * real time), so we don't emit `params` or `buttons` — this is a plain text
 * block the router sends and then follows up with the 4-option menu.
 */
export function formatDayFieldSummary(
  finished: InspectionListItem[],
  waitingForInfoCount: number,
  userName: string | null,
): string {
  const name = userName ?? '';
  const greet = `סיכום יום${name ? ` — ${name}` : ''}:`;

  const finishedLine = finished.length === 0
    ? 'בוצעו: אין'
    : `בוצעו: ${finished
        .map((f) => {
          const customer = f.customerName ?? 'לקוח לא ידוע';
          const type = f.typeLabelHe && f.typeLabelHe.trim().length > 0
            ? f.typeLabelHe
            : 'בדיקה';
          return `${customer} (${type})`;
        })
        .join(', ')}`;

  const waitingLine = waitingForInfoCount > 0
    ? `\nממתינות למידע: ${waitingForInfoCount}`
    : '';

  return `${greet}\n${finishedLine}${waitingLine}`;
}

// ── D3-T2: Sasha 09:30 leads morning digest ─────────────────────────────────
//
// SPEC_FIELD_V2 §12 — Sasha receives overnight unassigned leads (17:00 prev
// day → 09:30 today) with an AI suggestion per lead. No emojis; no CTA button
// (Sasha manages assignments in the CRM, not the bot).

export interface LeadDigestRow {
  id: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  body: string | null;
  receivedAt: Date;
}

export interface LeadDigestSuggestion {
  leadId: string;
  workerName: string | null;
  reason: string;
}

const LEAD_BODY_MAX = 200;

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + '...' : t;
}

/**
 * Sasha overnight leads digest — numbered list of unassigned leads with AI
 * worker suggestions. Empty leads list → one-liner "no overnight leads" note.
 * Body is truncated to LEAD_BODY_MAX chars to keep the message readable.
 * Template vars: [name, lead count].
 */
export function formatSashaLeadsMorning(
  leads: LeadDigestRow[],
  suggestions: LeadDigestSuggestion[],
  user: { name: string | null },
): DigestContent {
  const name = user.name ?? '';
  const header = `בוקר טוב ${name}\nסיכום לידים — הלילה (ממתינים לשיבוץ):`;
  const params = [name, String(leads.length)];

  if (leads.length === 0) {
    return {
      // "אין לידים לשיבוץ מהלילה" is more precise than the old
      // "לא התקבלו לידים ממתינים מהלילה" — it signals that the
      // ASSIGNMENT QUEUE is empty, not that no leads arrived (which could
      // have happened but were already assigned before 09:30).
      text: `${header}\n\nאין לידים לשיבוץ מהלילה.`,
      params,
      buttons: [],
    };
  }

  const sugMap = new Map(suggestions.map((s) => [s.leadId, s]));

  // Standard label vocabulary for Sasha lead rows
  const L_SENDER  = 'שולח';
  const L_SUBJECT = 'נושא';
  const L_BODY    = 'תוכן';
  const L_SUGGES  = 'הצעת שיבוץ';

  const rows = leads.map((lead, i) => {
    const parts: string[] = [];
    const sender = [
      lead.fromName,
      lead.fromEmail ? `(${lead.fromEmail})` : null,
    ].filter(Boolean).join(' ');
    parts.push(`${i + 1}. ${L_SENDER}: ${sender || 'לא ידוע'}`);
    if (lead.subject) parts.push(`   ${L_SUBJECT}: ${lead.subject}`);
    if (lead.body?.trim()) parts.push(`   ${L_BODY}: ${truncate(lead.body, LEAD_BODY_MAX)}`);
    const sug = sugMap.get(lead.id);
    if (sug) {
      const sugLine = sug.workerName
        ? `${L_SUGGES}: ${sug.workerName} — ${sug.reason}`
        : `${L_SUGGES}: לא נמצאה התאמה`;
      parts.push(`   ${sugLine}`);
    }
    return parts.join('\n');
  });

  const text = `${header}\n\n${rows.join('\n\n')}\n\nלשיבוץ ב-CRM`;
  return { text, params, buttons: [] };
}
