/**
 * Display helpers for lead list rows and detail views.
 *
 * Rules (product owner UX):
 *  - One field per line — never combine multiple fields on one line.
 *  - Never use the word "משפחה" in user-facing text.
 *  - Do NOT show UUIDs (lead.id / taskId).
 *  - Do NOT show the full body — only a 200-char preview in the detail.
 *  - Subject is never shown as a separate field (it is subsumed by the body preview).
 */

import type { IncomingLeadRow } from '../services/incomingLeads';
import type { LeadEnrichment } from '../services/leadCategorizer';

// ── Time-formatting helpers ───────────────────────────────────────────────────

/**
 * Format a received-at timestamp relative to `now` for list-row display.
 *
 *  - Same calendar day (Jerusalem) → "HH:MM"
 *  - Yesterday (Jerusalem)         → "אתמול HH:MM"
 *  - Older                         → "DD/MM HH:MM"
 */
function formatReceivedTime(receivedAt: Date, now: Date): string {
  const tzOpts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Jerusalem' };

  // Build a parts object for the received timestamp.
  const parts = new Intl.DateTimeFormat('he-IL', {
    ...tzOpts,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(receivedAt);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const rDay   = get('day');
  const rMonth = get('month');
  const rYear  = get('year');
  const rHH    = get('hour');
  const rMM    = get('minute');

  // Build the same date components for `now`.
  const nowParts = new Intl.DateTimeFormat('he-IL', {
    ...tzOpts,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);

  const nDay   = nowParts.find((p) => p.type === 'day')?.value ?? '';
  const nMonth = nowParts.find((p) => p.type === 'month')?.value ?? '';
  const nYear  = nowParts.find((p) => p.type === 'year')?.value ?? '';

  const isSameDay = rDay === nDay && rMonth === nMonth && rYear === nYear;
  if (isSameDay) {
    return `${rHH}:${rMM}`;
  }

  // Check for yesterday.
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yParts = new Intl.DateTimeFormat('he-IL', {
    ...tzOpts,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(yesterdayDate);
  const yDay   = yParts.find((p) => p.type === 'day')?.value ?? '';
  const yMonth = yParts.find((p) => p.type === 'month')?.value ?? '';
  const yYear  = yParts.find((p) => p.type === 'year')?.value ?? '';

  const isYesterday = rDay === yDay && rMonth === yMonth && rYear === yYear;
  if (isYesterday) {
    return `אתמול ${rHH}:${rMM}`;
  }

  return `${rDay}/${rMonth} ${rHH}:${rMM}`;
}

/**
 * Format a received-at timestamp for the detail view: "DD/MM/YYYY HH:MM" (Jerusalem TZ).
 */
function formatReceivedFull(receivedAt: Date): string {
  const parts = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(receivedAt);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/**
 * Format the Hebrew "waiting age" from `receivedAt` to `now`.
 *
 * Returns null when the lead already has an ownerId (caller shows "סטטוס: משויך" instead).
 *
 * Rules:
 *  < 1 minute                 → "כרגע התקבל"
 *  < 1 hour                   → "<M> דקות"
 *  < 24 hours (1h exact)      → "שעה" or "שעה ו־<M> דקות"
 *  < 24 hours (H > 1)         → "<H> שעות" or "<H> שעות ו־<M> דקות"
 *  ≥ 24 hours (1 day exactly) → "יום אחד"
 *  ≥ 24 hours (N days)        → "<N> ימים"
 */
function formatWaitingAge(receivedAt: Date, now: Date): string {
  const diffMs  = now.getTime() - receivedAt.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1)  return 'כרגע התקבל';
  if (diffMin < 60) return `${diffMin} דקות`;

  const totalHours = Math.floor(diffMin / 60);
  const remMin     = diffMin % 60;

  if (totalHours < 24) {
    if (totalHours === 1) {
      return remMin > 0 ? `שעה ו־${remMin} דקות` : 'שעה';
    }
    return remMin > 0 ? `${totalHours} שעות ו־${remMin} דקות` : `${totalHours} שעות`;
  }

  const totalDays = Math.floor(totalHours / 24);
  return totalDays === 1 ? 'יום אחד' : `${totalDays} ימים`;
}

// ── Exported formatters ───────────────────────────────────────────────────────

/**
 * True when the lead is genuinely claimed by a worker. The CRM's assignment
 * transaction (`services/incomingLeads.assignLeadToWorker`) writes BOTH
 * `status='ACTIVE'` AND `ownerId=<worker>` atomically — `status='NEW'` is the
 * pool state and MUST be treated as unassigned, regardless of whether some
 * upstream flow populated `ownerId` (which happens in the CRM UI's draft
 * flow). Checking `ownerId` alone was the 2026-07-19 display bug: the manager
 * menu "לידים לא משויכים" showed 3 NEW leads all labelled "סטטוס: משויך"
 * because ownerId was populated by the CRM draft state.
 */
function isLeadAssigned(lead: IncomingLeadRow): boolean {
  return lead.status === 'ACTIVE' && !!lead.ownerId;
}

/**
 * Sub-type label with a fallback chain. Never returns "לא זוהה בוודאות" —
 * per product decision (2026-07-19) the manager view must always show
 * SOMETHING actionable in the "סוג בדיקה" slot:
 *
 *   1. inspectionType.labelHe     — the categorizer resolved a specific type.
 *   2. `בדיקת ${categoryHe}`      — category was resolved but the sub-type
 *                                    matcher was ambiguous (common: the
 *                                    customer wrote "בדיקת גז ראדון" and 10
 *                                    radon sub-types all tie at score=1).
 *   3. 'כללי'                     — neither category nor sub-type resolved
 *                                    (e.g. web-form leads with no keywords).
 */
function displayInspectionType(enrichment: LeadEnrichment): string {
  if (enrichment.inspectionType) return enrichment.inspectionType.labelHe;
  if (enrichment.category) return `בדיקת ${enrichment.categoryHe}`;
  return 'כללי';
}

/**
 * Format a single lead as a compact list row (numbered block, one field per line).
 *
 * Format:
 *   <N>.
 *   שם: <fromName | 'לא צוין'>
 *   קטגוריית בדיקה: <categoryHe>
 *   סוג בדיקה: <inspectionType.labelHe | 'בדיקת <categoryHe>' | 'כללי'>
 *   מיקום: <location | 'לא צוין'>
 *   התקבל: <relative time>
 *   ממתין: <age>   — OR —   סטטוס: משויך   (only when status='ACTIVE' AND ownerId)
 */
export function formatLeadListRowCompact(
  lead: IncomingLeadRow,
  enrichment: LeadEnrichment,
  now: Date = new Date(),
): string {
  const name      = lead.fromName?.trim() || 'לא צוין';
  const catHe     = enrichment.categoryHe;
  const typeLabel = displayInspectionType(enrichment);
  const location  = enrichment.location ?? 'לא צוין';
  const received  = formatReceivedTime(lead.receivedAt, now);

  const lastLine = isLeadAssigned(lead)
    ? `סטטוס: משויך`
    : `ממתין: ${formatWaitingAge(lead.receivedAt, now)}`;

  return [
    `שם: ${name}`,
    `קטגוריית בדיקה: ${catHe}`,
    `סוג בדיקה: ${typeLabel}`,
    `מיקום: ${location}`,
    `התקבל: ${received}`,
    lastLine,
  ].join('\n');
}

/**
 * Format a lead as a full detail block.
 *
 * Format:
 *   פרטי ליד
 *
 *   שם: <fromName | 'לא צוין'>
 *   אימייל: <fromEmail | 'לא צוין'>
 *   קטגוריית בדיקה: <categoryHe>
 *   סוג בדיקה: <inspectionType.labelHe | 'לא זוהה בוודאות'>
 *   מיקום: <location | 'לא צוין'>
 *   התקבל: <DD/MM/YYYY HH:MM>
 *   סטטוס: <לא משויך | משויך>
 *   ממתין: <age>                    ← omitted when already assigned
 *
 *   תקציר הפנייה:
 *   <first 200 chars of body, "…" if truncated>
 *
 *   מה תרצה לעשות?
 *   1. חזרה ללידים
 *   2. לשיוך ליד — בחר "שיוך ליד לעובד" בתפריט הלידים
 */
export function formatLeadDetailCompact(
  lead: IncomingLeadRow,
  enrichment: LeadEnrichment,
  now: Date = new Date(),
): string {
  const name      = lead.fromName?.trim() || 'לא צוין';
  const email     = lead.fromEmail?.trim() || 'לא צוין';
  const catHe     = enrichment.categoryHe;
  const typeLabel = displayInspectionType(enrichment);
  const location  = enrichment.location ?? 'לא צוין';
  const received  = formatReceivedFull(lead.receivedAt);
  const isAssigned = isLeadAssigned(lead);
  const statusLine = isAssigned ? 'משויך' : 'לא משויך';

  const headerLines = [
    'פרטי ליד',
    '',
    `שם: ${name}`,
    `אימייל: ${email}`,
    `קטגוריית בדיקה: ${catHe}`,
    `סוג בדיקה: ${typeLabel}`,
    `מיקום: ${location}`,
    `התקבל: ${received}`,
    `סטטוס: ${statusLine}`,
  ];

  if (!isAssigned) {
    headerLines.push(`ממתין: ${formatWaitingAge(lead.receivedAt, now)}`);
  }

  // Body preview.
  const rawBody = lead.body?.trim() ?? '';
  let bodyPreview: string;
  if (!rawBody) {
    bodyPreview = 'אין תוכן';
  } else if (rawBody.length > 200) {
    bodyPreview = rawBody.slice(0, 200).trimEnd() + '…';
  } else {
    bodyPreview = rawBody;
  }

  // Note: NO numbered menu here. In the router, `mgr_leads_pick_row` state
  // treats a bare digit as "pick lead #N from the same list" — so a numbered
  // detail menu (1. חזרה / 2. שיוך) would be misleading (typing "1" would
  // fetch lead #1, not go back). Present the follow-ups as text-only guidance:
  // "חזרה" is intercepted by the same handler; assignment happens via the
  // top-level assign_lead intent (free text or sub-menu option 3).
  const footerLines = [
    '',
    'תקציר הפנייה:',
    bodyPreview,
    '',
    'מה תרצה לעשות?',
    '• כתוב "חזרה" — לחזור לרשימת הלידים',
    '• לשיוך — חזור לתפריט הלידים ובחר "שיוך ליד לעובד"',
  ];

  return [...headerLines, ...footerLines].join('\n');
}
