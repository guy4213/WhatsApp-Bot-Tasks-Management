/**
 * VOICE-4 — Tool registry + executor for the Hebrew voice assistant.
 *
 * Every capability the WhatsApp bot exposes is mirrored here as a callable
 * tool. Handlers call the SAME service functions the WhatsApp router calls —
 * no new business logic, no new DB writes beyond what the bot already does.
 * Role gates replicate the router's checks (isManagerMenuUser / isElevated /
 * own-rows-only), because the services deliberately leave enforcement to the
 * caller.
 *
 * Contract with the realtime voice model:
 *   - `buildOpenAiTools(user)` returns ONLY the tools this user may call, in
 *     the OpenAI Realtime `session.tools` shape ({type:'function', ...}).
 *   - `executeVoiceTool(user, name, args)` validates the gate again (defense
 *     in depth — the browser is not trusted), runs the handler, audits to
 *     "VoiceToolCall", and always resolves to a VoiceToolResult (never throws).
 *   - Results are deliberately SMALL (lists capped) — the model reads them
 *     aloud; a 200-row dump would be spoken, not rendered.
 *   - `speak` is a ready-made Hebrew one-liner the model may relay verbatim.
 *
 * The DEPARTED ordering bug-trap (documented in TASKS/知识): the customer
 * "worker en route" WhatsApp only carries a live-tracking link when a
 * TrackingSession already exists, so DEPARTED here does
 * openTrackingSession → advanceFieldStatus (which fires the customer notify)
 * → optional writeTravelEta — the exact order the WhatsApp router uses.
 */

import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import type { ResolvedUser, FieldProblemType } from '../types';
import { isManagerMenuUser } from '../ai/menu';
import {
  parseHebrewInspectionRange,
  localJerusalemDate,
} from '../ai/dateRangeParser';
import {
  advanceFieldStatus,
  declineInspection,
  writeProblem,
  writeMissingInfo,
  writeTravelEta,
  writeFieldNotes,
  findOpenTaskFieldForWorker,
  validateWorkerTaskField,
  resolveOpenTaskFieldByHint,
  dayFieldSummary,
  notifyOfficeProblem,
  notifyOfficeMissingInfo,
  notifyOfficeMissingEquipment,
  notifyOfficeDeclined,
  type AdvanceTransition,
} from './inspections';
import { getMyInspectionsInRange, getAllMyInspections } from './myInspectionsRange';
import {
  getManagementSnapshot,
  getTodayFieldInspections,
  getFieldExceptionRows,
  getAllWorkersDayOverview,
  getWorkerDayDetail,
  getTaskFieldDetail,
  searchTasksByCustomerName,
  searchTasksByWorkerName,
  searchTasksByProductCode,
  searchTasksByAddress,
  searchTasksByPhone,
  searchTasksByTaskId,
  searchTasksByFieldStatus,
  type FieldExceptionFilter,
  type DateRangeParam,
  type TodayFieldInspectionRow,
} from './managerViews';
import {
  findUnassignedLeadsForAssignment,
  getLeadById,
  assignLead,
  type IncomingLeadRow,
} from './incomingLeads';
import {
  updateSiteMetadata,
  reassignTask,
  getTaskFieldForCorrection,
} from './taskFieldCorrections';
import {
  scheduleTaskField,
  findOpenTasksForOwner,
  findOpenTasksForAdmin,
  findOpenTasksForCustomer,
  findCustomersByName,
  type TaskCandidate,
} from './taskFieldScheduling';
import { openTrackingSession, markArrived, closeSession } from './tracking';
import { buildTrackingUrl, getActiveTrackingToken } from './trackingLink';
import { createProvisioning } from './owntracksProvisioning';
import { findUsersByName } from './tasks';
import { sendTextMessage } from '../whatsapp/sender';
import { normalizeIsraeliPhone } from '../auth/phoneNormalizer';
import {
  createCrmTask,
  updateCrmTask,
  listCrmTasksForOwner,
  listAllCrmTasks,
  getCrmTaskById,
  crmApiConfigured,
  listCrmCalendarEvents,
  createCrmCalendarEvent,
  updateCrmCalendarEvent,
  deleteCrmCalendarEvent,
} from './crmApi';
import { auditVoiceToolCall } from './voiceAccess';
import { canAssignLeads } from './specialUsers';

const logger = moduleLogger('voice-tools');

// ── Result shape ──────────────────────────────────────────────────────────────

export interface VoiceToolResult {
  ok: boolean;
  /** Ready-made short Hebrew line the model may speak verbatim. */
  speak?: string;
  /** Friendly Hebrew error when ok=false. */
  error?: string;
  /** When a target is ambiguous — options the assistant should read out. */
  options?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

type JsonSchema = Record<string, unknown>;

interface VoiceToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 'any' — every authenticated user; 'manager' — isManagerMenuUser;
   *  'elevated' — MANAGER/ADMIN only; 'leadAssign' — canAssignLeads (leads
   *  viewers OR elevated; matches the WhatsApp router's lead-assign gate so
   *  exceptions-only viewers like Yoram cannot assign leads via voice). */
  gate: 'any' | 'manager' | 'elevated' | 'leadAssign';
  /** Hidden from the session when a required env integration is missing. */
  available?: () => boolean;
  handler: (user: ResolvedUser, args: Record<string, unknown>) => Promise<VoiceToolResult>;
}

// ── Small shared helpers ──────────────────────────────────────────────────────

const STATUS_HE: Record<string, string> = {
  ASSIGNED: 'לא אושרה',
  CONFIRMED: 'אושרה',
  EN_ROUTE: 'בדרך',
  ARRIVED: 'באתר',
  FINISHED_FIELD: 'הסתיימה',
  WAITING_FOR_INFO: 'ממתינה למידע',
  HAS_PROBLEM: 'יש בעיה',
  NEEDS_MORE_INFO: 'צריך פרטים',
  DECLINED: 'נדחתה',
  CANCELED: 'בוטלה',
};

function statusHe(s: string): string {
  return STATUS_HE[s] ?? s;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Cap a list for speech; report how many were dropped. */
function cap<T>(rows: T[], n = 15): { items: T[]; more: number } {
  return { items: rows.slice(0, n), more: Math.max(0, rows.length - n) };
}

/**
 * Resolve {when?, from?, to?} into a half-open local-date range.
 * Explicit from/to (YYYY-MM-DD) win; else a Hebrew phrase ("מחר", "השבוע",
 * "בין 1/7 ל-10/7"); else today.
 */
function resolveDateScope(args: Record<string, unknown>): {
  from: string;
  to: string;
  label: string;
} {
  const from = str(args.from);
  const to = str(args.to);
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { from, to, label: `${from} עד ${to}` };
  }
  const phrase = str(args.when);
  if (phrase) {
    const parsed = parseHebrewInspectionRange(phrase);
    if (parsed) {
      return { from: parsed.fromLocalDate, to: parsed.toLocalDate, label: parsed.label };
    }
  }
  const today = localJerusalemDate();
  const tomorrow = addDays(today, 1);
  return { from: today, to: tomorrow, label: 'היום' };
}

/** 'YYYY-MM-DD' + n days (UTC-safe — date-only math). */
function addDays(localDate: string, n: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtWhen(d: Date | string | null): string | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Truncate a possibly-null text to `n` chars for speech-friendly snippets in
 * list results. Full text stays behind the dedicated `get_*_details` tools.
 */
function snippet(text: string | null | undefined, n: number): string | null {
  if (!text) return null;
  const t = text.trim();
  if (t.length === 0) return null;
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Name for a bot user by id — used to enrich detail-tool responses. */
async function getUserNameById(userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ name: string | null }>(
    `SELECT name FROM "User" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0]?.name ?? null;
}

/** Phone for a bot user (findUsersByName returns id+name only). */
async function getUserPhone(userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ phone: string | null }>(
    `SELECT phone FROM "User" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const raw = rows[0]?.phone ?? null;
  if (!raw) return null;
  return normalizeIsraeliPhone(raw);
}

/**
 * Resolve which TaskField a worker action targets.
 * Priority: explicit task_field_id (ownership re-validated) → free-text hint
 * (customer/address) → the single open TaskField. Ambiguity returns options.
 */
async function resolveTargetTaskField(
  user: ResolvedUser,
  args: Record<string, unknown>,
): Promise<
  | { ok: true; taskFieldId: string; label: string }
  | { ok: false; result: VoiceToolResult }
> {
  const explicitId = str(args.task_field_id);
  if (explicitId) {
    const v = await validateWorkerTaskField(user.id, explicitId);
    if (!v.ok) {
      const reasonHe =
        v.reason === 'missing' ? 'הבדיקה לא נמצאה' :
        v.reason === 'not_owner' ? 'הבדיקה הזו לא משויכת אליך' :
        'הבדיקה הזו כבר סגורה';
      return { ok: false, result: { ok: false, error: reasonHe } };
    }
    return { ok: true, taskFieldId: v.taskFieldId, label: v.customerName ?? v.taskTitle ?? '' };
  }

  const hint = str(args.hint);
  const found = hint
    ? await resolveOpenTaskFieldByHint(user.id, hint)
    : await findOpenTaskFieldForWorker(user.id);

  if (!found) {
    return {
      ok: false,
      result: { ok: false, error: 'לא מצאתי בדיקה פתוחה שמתאימה. אפשר לנסות לפי שם לקוח או עיר.' },
    };
  }
  if ('ambiguous' in found) {
    // The hint-based resolver reports ambiguity without previews; the no-hint
    // resolver includes them. Offer options when we have them.
    const previews = (found as { items?: Array<Record<string, unknown>> }).items;
    const options = previews?.map((i) => ({ ...i }));
    return {
      ok: false,
      result: {
        ok: false,
        error: `יש ${found.count} בדיקות פתוחות שמתאימות — אפשר לדייק לפי שם לקוח או עיר?`,
        ...(options ? { options } : {}),
      },
    };
  }
  return { ok: true, taskFieldId: found.taskFieldId, label: found.customerName ?? found.taskTitle ?? '' };
}

/** Resolve one active user by (partial) name — ambiguity returns options. */
async function resolveUserByName(
  name: string,
): Promise<
  | { ok: true; id: string; name: string }
  | { ok: false; result: VoiceToolResult }
> {
  const matches = await findUsersByName(name);
  if (matches.length === 0) {
    return { ok: false, result: { ok: false, error: `לא מצאתי עובד בשם "${name}"` } };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      result: {
        ok: false,
        error: `יש כמה עובדים שמתאימים ל"${name}" — למי הכוונה?`,
        options: matches.map((m) => ({ id: m.id, name: m.name })),
      },
    };
  }
  return { ok: true, id: matches[0].id, name: matches[0].name };
}

/**
 * Resolve which calendar event an edit/delete targets. Priority: explicit
 * event_id → fuzzy match over the user's upcoming events by subject. Ambiguity
 * (or no match) returns options / a friendly error. Looks 60 days ahead + 7 back.
 */
async function resolveCalendarEvent(
  userId: string,
  args: Record<string, unknown>,
): Promise<
  | { ok: true; eventId: string; subject: string }
  | { ok: false; result: VoiceToolResult }
> {
  const explicitId = str(args.event_id);
  const match = str(args.match);

  let events: Awaited<ReturnType<typeof listCrmCalendarEvents>>;
  try {
    const now = new Date();
    events = await listCrmCalendarEvents(userId, {
      startIso: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      endIso: new Date(now.getTime() + 60 * 86_400_000).toISOString(),
      top: 50,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      result: {
        ok: false,
        error: msg.includes('מחובר')
          ? 'חשבון ה-Outlook שלך עדיין לא מחובר. יש להתחבר פעם אחת דרך ה-CRM.'
          : msg,
      },
    };
  }

  if (explicitId) {
    const found = events.find((e) => e.id === explicitId);
    return { ok: true, eventId: explicitId, subject: found?.subject ?? 'האירוע' };
  }

  if (!match) {
    return { ok: false, result: { ok: false, error: 'לאיזה אירוע להתייחס? אפשר לומר חלק מהנושא.' } };
  }
  const q = match.toLowerCase();
  const hits = events.filter((e) => (e.subject ?? '').toLowerCase().includes(q));
  if (hits.length === 0) {
    return { ok: false, result: { ok: false, error: `לא מצאתי ביומן אירוע שמתאים ל"${match}".` } };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      result: {
        ok: false,
        error: `יש כמה אירועים שמתאימים ל"${match}" — לאיזה מהם הכוונה?`,
        options: hits.slice(0, 6).map((e) => ({
          event_id: e.id,
          subject: e.subject,
          when: e.start ? fmtWhen(e.start.dateTime) : null,
        })),
      },
    };
  }
  return { ok: true, eventId: hits[0].id, subject: hits[0].subject ?? 'האירוע' };
}

function trimInspectionRow(r: {
  taskFieldId: string;
  customerName: string | null;
  siteAddress?: string | null;
  siteCity: string | null;
  fieldContactName?: string | null;
  fieldContactPhone?: string | null;
  fieldNotes?: string | null;
  fieldStatus: string;
  typeLabelHe: string;
  scheduledStartAt?: Date;
  timeHm?: string | null;
  workerName?: string | null;
}): Record<string, unknown> {
  // Contact + notes are the safety net for "המודל ענה מהרשימה במקום לקרוא
  // ל-get_inspection_details". Address + contact_name + contact_phone are
  // short — passed as-is; notes may be long — 200-char snippet. All included
  // only when the caller's query supplies them (matches the existing
  // `siteAddress !== undefined` conditional pattern used above).
  return {
    task_field_id: r.taskFieldId,
    customer: r.customerName,
    city: r.siteCity,
    ...(r.siteAddress !== undefined ? { address: r.siteAddress } : {}),
    ...(r.fieldContactName !== undefined ? { contact_name: r.fieldContactName } : {}),
    ...(r.fieldContactPhone !== undefined ? { contact_phone: r.fieldContactPhone } : {}),
    ...(r.fieldNotes !== undefined ? { notes_snippet: snippet(r.fieldNotes, 200) } : {}),
    status: statusHe(r.fieldStatus),
    type: r.typeLabelHe,
    ...(r.scheduledStartAt ? { when: fmtWhen(r.scheduledStartAt) } : {}),
    ...(r.timeHm ? { time: r.timeHm } : {}),
    ...(r.workerName !== undefined ? { worker: r.workerName } : {}),
  };
}

const PROBLEM_TYPES: FieldProblemType[] = [
  'CUSTOMER_NOT_ANSWERING',
  'NO_ACCESS',
  'CUSTOMER_NOT_PRESENT',
  'MISSING_EQUIPMENT',
  'CANNOT_PERFORM',
  'PROFESSIONAL_ISSUE',
  'OTHER',
];

const customerNotificationsEnabled = () =>
  (process.env.CUSTOMER_NOTIFICATIONS_ENABLED ?? '').toLowerCase() === 'true';

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS: VoiceToolDef[] = [
  // ═══════════════ Worker: lists & details ═══════════════
  {
    name: 'get_my_inspections',
    gate: 'any',
    description:
      'רשימת הבדיקות (ביקורי שטח) של המשתמש. ברירת מחדל: היום. אפשר טווח בעברית ("מחר", "השבוע", "בין 1/7 ל-10/7") או תאריכים מפורשים, או all_time=true להיסטוריה. כל שורה כוללת סיכום קצר (לקוח, כתובת, איש קשר, טלפון, ותקציר הערות 200 תווים); לפרטים מלאים של בדיקה בודדת (הערות מלאות, בעיות, קישור מעקב) — קרא ל-get_inspection_details.',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'ביטוי טווח בעברית: היום/מחר/השבוע/שבוע שעבר/בין X ל-Y' },
        from: { type: 'string', description: 'YYYY-MM-DD (כולל)' },
        to: { type: 'string', description: 'YYYY-MM-DD (לא כולל)' },
        all_time: { type: 'boolean', description: 'true = כל הבדיקות אי-פעם (מוגבל 200)' },
      },
    },
    handler: async (user, args) => {
      if (args.all_time === true) {
        const rows = await getAllMyInspections(user.id, 200);
        const { items, more } = cap(rows);
        return {
          ok: true,
          count: rows.length,
          more,
          inspections: items.map(trimInspectionRow),
          speak: rows.length === 0 ? 'אין בדיקות בכלל.' : `יש ${rows.length} בדיקות בסך הכול.`,
        };
      }
      const scope = resolveDateScope(args);
      const rows = await getMyInspectionsInRange(user.id, scope.from, scope.to);
      const { items, more } = cap(rows);
      return {
        ok: true,
        range: scope.label,
        count: rows.length,
        more,
        inspections: items.map(trimInspectionRow),
        speak:
          rows.length === 0
            ? `אין בדיקות ${scope.label}.`
            : `יש ${rows.length} בדיקות ${scope.label}.`,
      };
    },
  },
  {
    name: 'get_inspection_details',
    gate: 'any',
    description:
      'פרטים מלאים של בדיקה אחת: לקוח, כתובת, איש קשר וטלפון, סטטוס, שעה, הערות, בעיות. זיהוי לפי task_field_id או hint (שם לקוח/עיר).',
    parameters: {
      type: 'object',
      properties: {
        task_field_id: { type: 'string' },
        hint: { type: 'string', description: 'שם לקוח / כתובת / עיר לזיהוי הבדיקה' },
      },
    },
    handler: async (user, args) => {
      // Managers may inspect ANY TaskField by explicit id (mirrors manager
      // search → detail in WhatsApp); workers resolve within their own rows.
      const explicitId = str(args.task_field_id);
      let taskFieldId: string;
      if (explicitId && isManagerMenuUser(user)) {
        taskFieldId = explicitId;
      } else {
        const target = await resolveTargetTaskField(user, args);
        if (!target.ok) return target.result;
        taskFieldId = target.taskFieldId;
      }
      const d = await getTaskFieldDetail(taskFieldId);
      if (!d) return { ok: false, error: 'הבדיקה לא נמצאה' };
      const token = await getActiveTrackingToken(taskFieldId);
      return {
        ok: true,
        detail: {
          task_field_id: d.taskFieldId,
          customer: d.customerName,
          title: d.taskTitle,
          worker: d.workerName,
          address: d.siteAddress,
          city: d.siteCity,
          contact_name: d.fieldContactName,
          contact_phone: d.fieldContactPhone,
          status: statusHe(d.fieldStatus),
          when: fmtWhen(d.scheduledStartAt),
          type: d.typeLabelHe,
          special_instructions: d.specialInstructions,
          notes: d.fieldNotes,
          problem: d.problemNote,
          missing_info: d.missingReportInfoNote,
          tracking_url: token ? buildTrackingUrl(token) : null,
        },
      };
    },
  },

  // ═══════════════ Worker: status flow ═══════════════
  {
    name: 'update_inspection_status',
    gate: 'any',
    description:
      'עדכון סטטוס בדיקה: CONFIRM (אישרתי) / DEPARTED (יצאתי — שולח ללקוח אוטומטית הודעת "הבודק בדרך" + קישור מעקב חי) / ARRIVED (הגעתי) / FINISHED (סיימתי). eta_minutes אופציונלי ליציאה.',
    parameters: {
      type: 'object',
      required: ['transition'],
      properties: {
        transition: { type: 'string', enum: ['CONFIRM', 'DEPARTED', 'ARRIVED', 'FINISHED'] },
        task_field_id: { type: 'string' },
        hint: { type: 'string', description: 'שם לקוח / עיר לזיהוי הבדיקה' },
        eta_minutes: { type: 'number', description: 'זמן נסיעה משוער בדקות (רק ליציאה)' },
        notes: { type: 'string', description: 'הערות סיום (רק לסיום)' },
      },
    },
    handler: async (user, args) => {
      const transition = str(args.transition) as AdvanceTransition | null;
      if (!transition || !['CONFIRM', 'DEPARTED', 'ARRIVED', 'FINISHED'].includes(transition)) {
        return { ok: false, error: 'סטטוס לא מוכר' };
      }
      const target = await resolveTargetTaskField(user, args);
      if (!target.ok) return target.result;
      const { taskFieldId, label } = target;

      let trackingUrl: string | null = null;

      if (transition === 'DEPARTED') {
        // Order matters: session first so the customer WhatsApp carries the link.
        try {
          await openTrackingSession({ taskFieldId, workerUserId: user.id });
        } catch (err) {
          logger.warn({ err, taskFieldId }, 'openTrackingSession failed — continuing without link');
        }
      }

      await advanceFieldStatus({ taskFieldId, transition, updatedBy: user.id });

      if (transition === 'DEPARTED') {
        const eta = num(args.eta_minutes);
        if (eta && eta > 0 && eta < 600) {
          await writeTravelEta({ taskFieldId, minutes: Math.round(eta), updatedBy: user.id });
        }
        const token = await getActiveTrackingToken(taskFieldId);
        trackingUrl = token ? buildTrackingUrl(token) : null;
      } else if (transition === 'ARRIVED') {
        await markArrived(taskFieldId);
      } else if (transition === 'FINISHED') {
        await closeSession(taskFieldId, 'FINISHED');
        const notes = str(args.notes);
        if (notes) await writeFieldNotes({ taskFieldId, notes, updatedBy: user.id });
      }

      const speakByTransition: Record<AdvanceTransition, string> = {
        CONFIRM: `אישרתי את הבדיקה של ${label}.`,
        DEPARTED: customerNotificationsEnabled()
          ? `עודכן שיצאת ל${label} — הלקוח קיבל הודעה שאתה בדרך${trackingUrl ? ' עם קישור מעקב חי' : ''}.`
          : `עודכן שיצאת ל${label}.`,
        ARRIVED: `עודכן שהגעת ל${label}. בהצלחה בבדיקה!`,
        FINISHED: `הבדיקה של ${label} סומנה כהסתיימה. כל הכבוד!`,
      };

      return {
        ok: true,
        task_field_id: taskFieldId,
        new_status: statusHe(
          transition === 'CONFIRM' ? 'CONFIRMED'
          : transition === 'DEPARTED' ? 'EN_ROUTE'
          : transition === 'ARRIVED' ? 'ARRIVED'
          : 'FINISHED_FIELD',
        ),
        customer_notified: transition === 'DEPARTED' ? customerNotificationsEnabled() : undefined,
        tracking_url: trackingUrl ?? undefined,
        speak: speakByTransition[transition],
      };
    },
  },
  {
    name: 'decline_inspection',
    gate: 'any',
    description: 'דיווח שהעובד לא יכול להגיע לבדיקה (דחייה) עם סיבה. המשרד מקבל התראה.',
    parameters: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: 'סיבת הדחייה' },
        task_field_id: { type: 'string' },
        hint: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const reason = str(args.reason);
      if (!reason) return { ok: false, error: 'צריך סיבה לדחייה' };
      const target = await resolveTargetTaskField(user, args);
      if (!target.ok) return target.result;
      await declineInspection({ taskFieldId: target.taskFieldId, reason, updatedBy: user.id });
      await closeSession(target.taskFieldId, 'CANCELED');
      const notified = await notifyOfficeDeclined(target.taskFieldId, reason);
      return {
        ok: true,
        office_notified: notified,
        speak: `הבדיקה של ${target.label} סומנה כלא-זמינה והמשרד עודכן.`,
      };
    },
  },
  {
    name: 'report_problem',
    gate: 'any',
    description:
      'דיווח בעיה בבדיקה. סוגים: CUSTOMER_NOT_ANSWERING (לקוח לא עונה), NO_ACCESS (אין גישה), CUSTOMER_NOT_PRESENT (לקוח לא נמצא), MISSING_EQUIPMENT (חסר ציוד), CANNOT_PERFORM (לא ניתן לבצע), PROFESSIONAL_ISSUE (בעיה מקצועית), OTHER (אחר). המנהלים מקבלים התראה מיידית.',
    parameters: {
      type: 'object',
      required: ['problem_type'],
      properties: {
        problem_type: { type: 'string', enum: PROBLEM_TYPES as unknown as string[] },
        note: { type: 'string', description: 'פירוט חופשי' },
        task_field_id: { type: 'string' },
        hint: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const problemType = str(args.problem_type) as FieldProblemType | null;
      if (!problemType || !PROBLEM_TYPES.includes(problemType)) {
        return { ok: false, error: 'סוג בעיה לא מוכר' };
      }
      const target = await resolveTargetTaskField(user, args);
      if (!target.ok) return target.result;
      await writeProblem({
        taskFieldId: target.taskFieldId,
        problemType,
        note: str(args.note),
        updatedBy: user.id,
      });
      const notified = await notifyOfficeProblem(target.taskFieldId);
      return {
        ok: true,
        office_notified: notified,
        speak: `הבעיה נרשמה על הבדיקה של ${target.label} והמשרד קיבל התראה.`,
      };
    },
  },
  {
    name: 'report_missing_info',
    gate: 'any',
    description: 'דיווח שחסר מידע לדוח (טופס דגימה, מספר היתר וכו\'). הבדיקה עוברת ל"ממתין למידע" והמשרד מעודכן.',
    parameters: {
      type: 'object',
      required: ['note'],
      properties: {
        note: { type: 'string', description: 'מה חסר' },
        task_field_id: { type: 'string' },
        hint: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const note = str(args.note);
      if (!note) return { ok: false, error: 'צריך לציין מה חסר' };
      const target = await resolveTargetTaskField(user, args);
      if (!target.ok) return target.result;
      await writeMissingInfo({ taskFieldId: target.taskFieldId, note, updatedBy: user.id });
      const notified = await notifyOfficeMissingInfo(target.taskFieldId);
      return {
        ok: true,
        office_notified: notified,
        speak: `נרשם שחסר מידע לדוח של ${target.label} — המשרד עודכן.`,
      };
    },
  },
  {
    name: 'report_missing_equipment',
    gate: 'any',
    description: 'דיווח כללי שחסר ציוד (לא צמוד לבדיקה ספציפית). המשרד מקבל התראה.',
    parameters: {
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string', description: 'איזה ציוד חסר' } },
    },
    handler: async (user, args) => {
      const note = str(args.note);
      if (!note) return { ok: false, error: 'צריך לציין איזה ציוד חסר' };
      const notified = await notifyOfficeMissingEquipment({
        userId: user.id,
        userName: user.name,
        note,
        localDate: localJerusalemDate(),
      });
      return {
        ok: true,
        office_notified: notified,
        speak: notified ? 'הדיווח על הציוד החסר נשלח למשרד.' : 'הדיווח נרשם אך לא נמצאו מנהלים זמינים להתראה.',
      };
    },
  },
  {
    name: 'add_inspection_notes',
    gate: 'any',
    description: 'הוספת הערות טקסט חופשי לבדיקה (בלי לשנות סטטוס).',
    parameters: {
      type: 'object',
      required: ['notes'],
      properties: {
        notes: { type: 'string' },
        task_field_id: { type: 'string' },
        hint: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const notes = str(args.notes);
      if (!notes) return { ok: false, error: 'אין תוכן להערה' };
      const target = await resolveTargetTaskField(user, args);
      if (!target.ok) return target.result;
      await writeFieldNotes({ taskFieldId: target.taskFieldId, notes, updatedBy: user.id });
      return { ok: true, speak: `ההערה נשמרה על הבדיקה של ${target.label}.` };
    },
  },
  {
    name: 'get_day_summary',
    gate: 'any',
    description: 'סיכום היום של המשתמש: כמה בדיקות בוצעו וכמה ממתינות למידע.',
    parameters: { type: 'object', properties: {} },
    handler: async (user) => {
      const s = await dayFieldSummary(user.id, localJerusalemDate());
      return {
        ok: true,
        finished_count: s.finished.length,
        waiting_for_info: s.waitingForInfoCount,
        finished: s.finished.map(trimInspectionRow),
        speak: `סיימת היום ${s.finished.length} בדיקות${s.waitingForInfoCount ? `, ו-${s.waitingForInfoCount} ממתינות למידע` : ''}.`,
      };
    },
  },
  {
    name: 'correct_site_details',
    gate: 'any',
    description: 'תיקון פרטי אתר על בדיקה: כתובת, עיר, שם איש קשר, טלפון איש קשר. עובד — רק על בדיקות שלו.',
    parameters: {
      type: 'object',
      properties: {
        task_field_id: { type: 'string' },
        hint: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const fields = {
        ...(str(args.address) ? { siteAddress: str(args.address)! } : {}),
        ...(str(args.city) ? { siteCity: str(args.city)! } : {}),
        ...(str(args.contact_name) ? { fieldContactName: str(args.contact_name)! } : {}),
        ...(str(args.contact_phone) ? { fieldContactPhone: str(args.contact_phone)! } : {}),
      };
      if (Object.keys(fields).length === 0) {
        return { ok: false, error: 'לא צוין מה לתקן (כתובת/עיר/איש קשר/טלפון)' };
      }

      // Elevated users may correct any row by explicit id; workers only their own.
      const explicitId = str(args.task_field_id);
      let taskFieldId: string;
      let label = '';
      if (explicitId && user.isElevated) {
        const row = await getTaskFieldForCorrection(explicitId);
        if (!row) return { ok: false, error: 'הבדיקה לא נמצאה' };
        taskFieldId = row.taskFieldId;
      } else {
        const target = await resolveTargetTaskField(user, args);
        if (!target.ok) return target.result;
        taskFieldId = target.taskFieldId;
        label = target.label;
      }

      await updateSiteMetadata(taskFieldId, user.id, fields);
      return {
        ok: true,
        updated_fields: Object.keys(fields),
        speak: `פרטי האתר עודכנו${label ? ` על הבדיקה של ${label}` : ''}.`,
      };
    },
  },
  {
    name: 'schedule_inspection_visit',
    gate: 'any',
    description:
      'תזמון ביקור/בדיקה חדשה תחת משימה קיימת. חובה מועד התחלה (start_iso). זיהוי המשימה לפי customer_name או task_id. עובד — רק על המשימות שלו; מנהל — על כולן.',
    parameters: {
      type: 'object',
      required: ['start_iso'],
      properties: {
        start_iso: { type: 'string', description: 'מועד התחלה ISO 8601, למשל 2026-07-15T10:00:00' },
        customer_name: { type: 'string' },
        task_id: { type: 'string' },
        duration_minutes: { type: 'number', description: 'ברירת מחדל 60' },
        notes: { type: 'string', description: 'הוראות מיוחדות' },
      },
    },
    handler: async (user, args) => {
      const startIso = str(args.start_iso);
      if (!startIso) return { ok: false, error: 'צריך מועד התחלה' };
      const start = new Date(startIso);
      if (Number.isNaN(start.getTime())) return { ok: false, error: 'מועד ההתחלה לא תקין' };
      if (start.getTime() < Date.now() - 5 * 60_000) {
        return { ok: false, error: 'המועד שביקשת כבר עבר — צריך מועד עתידי' };
      }

      // Resolve the parent Task → candidates by explicit id, customer, or owner.
      let candidates: TaskCandidate[] = [];
      const taskId = str(args.task_id);
      const customerName = str(args.customer_name);
      if (customerName) {
        const customers = await findCustomersByName(customerName);
        if (customers.length === 0) {
          return { ok: false, error: `לא מצאתי לקוח בשם "${customerName}"` };
        }
        if (customers.length > 1) {
          return {
            ok: false,
            error: 'יש כמה לקוחות מתאימים — לאיזה מהם?',
            options: customers.map((c) => ({ customer_id: c.id, name: c.name, open_tasks: c.openTaskCount })),
          };
        }
        candidates = await findOpenTasksForCustomer(customers[0].id);
        if (!user.isElevated) candidates = candidates.filter((t) => t.ownerId === user.id);
      } else if (user.isElevated) {
        candidates = await findOpenTasksForAdmin(20);
      } else {
        candidates = await findOpenTasksForOwner(user.id, 20);
      }
      if (taskId) candidates = candidates.filter((t) => t.id === taskId);

      if (candidates.length === 0) {
        return { ok: false, error: 'לא נמצאה משימה פתוחה מתאימה לתזמון' };
      }
      if (candidates.length > 1) {
        return {
          ok: false,
          error: 'יש כמה משימות מתאימות — לאיזו מהן לתזמן?',
          options: candidates.slice(0, 8).map((t) => ({
            task_id: t.id,
            customer: t.customerName,
            title: t.title,
            type: t.inspectionLabelHe,
          })),
        };
      }

      const task = candidates[0];
      if (!task.inspectionTypeId || !task.inspectionFamily) {
        return { ok: false, error: 'למשימה הזו אין סוג בדיקה (מק"ט) תקין — צריך לתקן ב-CRM קודם' };
      }

      const { taskFieldId } = await scheduleTaskField({
        taskId: task.id,
        inspectionTypeId: task.inspectionTypeId,
        family: task.inspectionFamily,
        appointmentTitle: `ביקור ל-${task.customerName ?? task.title}`,
        scheduledStartAt: start.toISOString(),
        durationMinutes: Math.min(Math.max(num(args.duration_minutes) ?? 60, 15), 480),
        siteAddress: task.siteAddress,
        siteCity: task.siteCity,
        fieldContactName: task.fieldContactName,
        fieldContactPhone: task.fieldContactPhone,
        navigationUrl: task.navigationUrl,
        specialInstructions: str(args.notes),
        updatedByUserId: user.id,
      });

      return {
        ok: true,
        task_field_id: taskFieldId,
        speak: `נקבע ביקור ל${task.customerName ?? task.title} ב-${fmtWhen(start)}. העובד המשובץ יקבל כרטיס שיבוץ בוואטסאפ.`,
      };
    },
  },

  // ═══════════════ Calendar (Outlook via the CRM's stored connection) ═══════════════
  {
    name: 'get_calendar_events',
    gate: 'any',
    available: crmApiConfigured,
    description: 'קריאת היומן (Outlook) של המשתמש: הפגישות הקרובות. ברירת מחדל: 7 הימים הקרובים.',
    parameters: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'כמה ימים קדימה (ברירת מחדל 7)' },
        from_iso: { type: 'string', description: 'התחלה ISO (אופציונלי)' },
        to_iso: { type: 'string', description: 'סוף ISO (אופציונלי)' },
      },
    },
    handler: async (user, args) => {
      const now = new Date();
      const days = Math.min(Math.max(num(args.days_ahead) ?? 7, 1), 60);
      const startIso = str(args.from_iso) ?? now.toISOString();
      const endIso =
        str(args.to_iso) ?? new Date(now.getTime() + days * 86_400_000).toISOString();
      try {
        const events = await listCrmCalendarEvents(user.id, { startIso, endIso, top: 25 });
        const { items, more } = cap(events, 12);
        return {
          ok: true,
          count: events.length,
          more,
          events: items.map((e) => ({
            id: e.id,
            subject: e.subject,
            start: e.start ? fmtWhen(e.start.dateTime) : null,
            location: e.location ?? null,
            is_online: e.isOnlineMeeting,
            all_day: e.isAllDay,
          })),
          speak:
            events.length === 0
              ? 'היומן פנוי בתקופה הזו.'
              : `יש ${events.length} אירועים ביומן.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: msg.includes('מחובר')
            ? 'חשבון ה-Outlook שלך עדיין לא מחובר. יש להתחבר פעם אחת דרך ה-CRM (הגדרות → Outlook).'
            : msg,
        };
      }
    },
  },
  {
    name: 'create_calendar_event',
    gate: 'any',
    available: crmApiConfigured,
    description: 'יצירת אירוע ביומן Outlook של המשתמש. חובה: נושא ומועד התחלה. ברירת מחדל: שעה אחת.',
    parameters: {
      type: 'object',
      required: ['subject', 'start_iso'],
      properties: {
        subject: { type: 'string' },
        start_iso: { type: 'string', description: 'שעה מקומית ISO, למשל 2026-07-15T14:00:00' },
        end_iso: { type: 'string' },
        duration_minutes: { type: 'number', description: 'ברירת מחדל 60 (אם אין end_iso)' },
        location: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const subject = str(args.subject);
      const startIso = str(args.start_iso);
      if (!subject || !startIso) return { ok: false, error: 'חסר נושא או מועד' };
      const start = new Date(startIso);
      if (Number.isNaN(start.getTime())) return { ok: false, error: 'מועד ההתחלה לא תקין' };
      let endIso = str(args.end_iso);
      if (!endIso) {
        const mins = Math.min(Math.max(num(args.duration_minutes) ?? 60, 5), 720);
        endIso = new Date(start.getTime() + mins * 60_000).toISOString().slice(0, 19);
      }
      try {
        const ev = await createCrmCalendarEvent(user.id, {
          subject,
          // Graph expects wall-clock without offset when timeZone is provided.
          start: startIso.replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)$/, ''),
          end: endIso.replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)$/, ''),
          timeZone: 'Asia/Jerusalem',
          location: str(args.location),
          body: str(args.notes),
        });
        return {
          ok: true,
          event_id: ev.id,
          speak: `האירוע "${subject}" נקבע ביומן ל-${fmtWhen(start)}.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: msg.includes('מחובר')
            ? 'חשבון ה-Outlook שלך עדיין לא מחובר. יש להתחבר פעם אחת דרך ה-CRM (הגדרות → Outlook).'
            : msg,
        };
      }
    },
  },
  {
    name: 'update_calendar_event',
    gate: 'any',
    available: crmApiConfigured,
    description:
      'עדכון אירוע קיים ביומן Outlook: שינוי נושא/מועד/מיקום. זיהוי האירוע לפי event_id, או לפי match (טקסט מנושא האירוע — אם יש כמה תואמים אחזיר רשימה לבחירה).',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'מזהה האירוע (אם ידוע)' },
        match: { type: 'string', description: 'טקסט לזיהוי האירוע לפי הנושא (למשל "היטאצ\'י")' },
        subject: { type: 'string', description: 'נושא חדש' },
        start_iso: { type: 'string', description: 'מועד התחלה חדש, ISO מקומי' },
        end_iso: { type: 'string' },
        duration_minutes: { type: 'number', description: 'משך חדש (אם יש start בלי end)' },
        location: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const resolved = await resolveCalendarEvent(user.id, args);
      if (!resolved.ok) return resolved.result;

      const patch: Record<string, unknown> = {};
      const subject = str(args.subject);
      if (subject) patch.subject = subject;
      const loc = str(args.location);
      if (loc) patch.location = loc;
      const startIso = str(args.start_iso);
      if (startIso) {
        const s = new Date(startIso);
        if (Number.isNaN(s.getTime())) return { ok: false, error: 'מועד ההתחלה החדש לא תקין' };
        patch.start = startIso.replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)$/, '');
        let endIso = str(args.end_iso);
        if (!endIso) {
          const mins = Math.min(Math.max(num(args.duration_minutes) ?? 60, 5), 720);
          endIso = new Date(s.getTime() + mins * 60_000).toISOString().slice(0, 19);
        }
        patch.end = endIso.replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)$/, '');
      } else if (str(args.end_iso)) {
        patch.end = str(args.end_iso)!.replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)$/, '');
      }

      if (Object.keys(patch).length === 0) {
        return { ok: false, error: 'לא צוין מה לשנות (נושא / מועד / מיקום)' };
      }

      try {
        await updateCrmCalendarEvent(user.id, resolved.eventId, patch);
        return { ok: true, speak: `האירוע "${resolved.subject}" עודכן ביומן.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: msg.includes('מחובר')
            ? 'חשבון ה-Outlook שלך עדיין לא מחובר. יש להתחבר פעם אחת דרך ה-CRM.'
            : msg,
        };
      }
    },
  },
  {
    name: 'delete_calendar_event',
    gate: 'any',
    available: crmApiConfigured,
    description:
      'מחיקת אירוע מהיומן. זיהוי לפי event_id או match (טקסט מהנושא). חשוב: לפני קריאה לכלי הזה — ודאי עם המשתמש שהוא בטוח שברצונו למחוק את האירוע הספציפי.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        match: { type: 'string', description: 'טקסט לזיהוי האירוע לפי הנושא' },
      },
    },
    handler: async (user, args) => {
      const resolved = await resolveCalendarEvent(user.id, args);
      if (!resolved.ok) return resolved.result;
      try {
        await deleteCrmCalendarEvent(user.id, resolved.eventId);
        return { ok: true, speak: `האירוע "${resolved.subject}" נמחק מהיומן.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: msg.includes('מחובר')
            ? 'חשבון ה-Outlook שלך עדיין לא מחובר. יש להתחבר פעם אחת דרך ה-CRM.'
            : msg,
        };
      }
    },
  },

  // ═══════════════ CRM tasks (through the CRM API) ═══════════════
  {
    name: 'create_crm_task',
    gate: 'any',
    available: crmApiConfigured,
    description:
      'יצירת משימת משרד חדשה ב-CRM. חובה: כותרת. אופציונלי: תיאור, תאריך יעד, עדיפות. מנהל יכול ליצור עבור עובד אחר (for_worker_name).',
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        due_date_iso: { type: 'string', description: 'תאריך יעד ISO' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
        for_worker_name: { type: 'string', description: 'שם עובד (מנהלים בלבד)' },
      },
    },
    handler: async (user, args) => {
      const title = str(args.title);
      if (!title) return { ok: false, error: 'צריך כותרת למשימה' };

      let ownerId = user.id;
      let ownerName = user.name;
      const forName = str(args.for_worker_name);
      if (forName) {
        if (!user.isElevated) {
          return { ok: false, error: 'רק מנהל יכול ליצור משימה עבור עובד אחר' };
        }
        const resolved = await resolveUserByName(forName);
        if (!resolved.ok) return resolved.result;
        ownerId = resolved.id;
        ownerName = resolved.name;
      }

      const created = await createCrmTask({
        title,
        ownerId,
        description: str(args.description) ?? undefined,
        dueDate: str(args.due_date_iso) ?? undefined,
        priority: (str(args.priority) as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' | null) ?? undefined,
      });
      if (!created) return { ok: false, error: 'יצירת המשימה ב-CRM נכשלה — כדאי לנסות שוב או לבדוק את החיבור' };
      return {
        ok: true,
        task_id: created.id,
        speak: `המשימה "${title}" נוצרה ב-CRM${ownerId !== user.id ? ` עבור ${ownerName}` : ''}.`,
      };
    },
  },
  {
    name: 'update_crm_task',
    gate: 'any',
    available: crmApiConfigured,
    description: 'עדכון משימת CRM קיימת לפי task_id: כותרת, תיאור, תאריך יעד, עדיפות או סטטוס (OPEN/IN_PROGRESS/DONE/CANCELLED).',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        due_date_iso: { type: 'string' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
        status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] },
      },
    },
    handler: async (user, args) => {
      const taskId = str(args.task_id);
      if (!taskId) return { ok: false, error: 'חסר מזהה משימה' };

      // Non-elevated users may only touch their own CRM tasks.
      if (!user.isElevated) {
        const mine = await listCrmTasksForOwner(user.id, { limit: 50 });
        if (!mine || !mine.some((t) => t.id === taskId)) {
          return { ok: false, error: 'המשימה הזו לא שלך או שלא נמצאה' };
        }
      }

      const patch = {
        ...(str(args.title) ? { title: str(args.title)! } : {}),
        ...(str(args.description) ? { description: str(args.description)! } : {}),
        ...(str(args.due_date_iso) ? { dueDate: str(args.due_date_iso)! } : {}),
        ...(str(args.priority) ? { priority: str(args.priority) as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' } : {}),
        ...(str(args.status) ? { status: str(args.status) as 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' } : {}),
      };
      if (Object.keys(patch).length === 0) return { ok: false, error: 'לא צוין מה לעדכן' };

      const updated = await updateCrmTask(taskId, patch);
      if (!updated) return { ok: false, error: 'עדכון המשימה נכשל' };
      return { ok: true, speak: 'המשימה עודכנה ב-CRM.' };
    },
  },
  {
    name: 'list_my_crm_tasks',
    gate: 'any',
    available: crmApiConfigured,
    description: 'רשימת משימות המשרד הפתוחות של המשתמש מה-CRM (לא בדיקות שטח). מחזיר סיכום קצר לכל משימה (כולל 200 תווים ראשונים של התיאור); לתוכן מלא של משימה בודדת קרא ל-get_crm_task_details.',
    parameters: {
      type: 'object',
      properties: {
        include_done: { type: 'boolean', description: 'לכלול גם משימות שהסתיימו' },
      },
    },
    handler: async (user, args) => {
      const rows = await listCrmTasksForOwner(user.id, {
        status: args.include_done === true ? undefined : undefined,
        limit: 20,
      });
      if (!rows) return { ok: false, error: 'לא הצלחתי לקרוא את המשימות מה-CRM' };
      const filtered = args.include_done === true ? rows : rows;
      return {
        ok: true,
        count: filtered.length,
        tasks: filtered.map((t) => ({
          task_id: t.id,
          title: t.title,
          // 200-char snippet so the model can hint at what the task is about;
          // full description stays behind get_crm_task_details.
          description_snippet: snippet(t.description, 200),
          product_name: t.productName,
          due: t.dueDate ? fmtWhen(t.dueDate) : null,
          priority: t.priority,
          status: t.status,
        })),
        speak: filtered.length === 0 ? 'אין לך משימות משרד פתוחות.' : `יש לך ${filtered.length} משימות משרד פתוחות.`,
      };
    },
  },
  {
    name: 'get_crm_task_details',
    gate: 'any',
    available: crmApiConfigured,
    description:
      'פרטים מלאים של משימת CRM בודדת: כותרת, תיאור מלא, תאריך יעד, עדיפות, סטטוס, מוצר, לקוח, ובעל המשימה. עובד — רק על משימות שלו; מנהל — על כל משימה.',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    handler: async (user, args) => {
      const taskId = str(args.task_id);
      if (!taskId) return { ok: false, error: 'חסר מזהה משימה' };

      const task = await getCrmTaskById(taskId);
      if (!task) {
        // Either the CRM answered non-2xx (missing task / endpoint not yet
        // deployed) or the network failed. crmFetch already logged the reason;
        // surface a friendly Hebrew line.
        return { ok: false, error: 'לא הצלחתי לקרוא את פרטי המשימה מה-CRM' };
      }

      // Enforce the same ownership rule as update_crm_task: non-elevated users
      // may only see their own office tasks.
      if (!user.isElevated && task.ownerId !== user.id) {
        return { ok: false, error: 'המשימה הזו לא שלך' };
      }

      const ownerName = await getUserNameById(task.ownerId);
      return {
        ok: true,
        detail: {
          task_id: task.id,
          title: task.title,
          description: task.description,
          due: task.dueDate ? fmtWhen(task.dueDate) : null,
          priority: task.priority,
          status: task.status,
          product_name: task.productName,
          customer_id: task.customerId,
          owner_id: task.ownerId,
          owner_name: ownerName,
        },
      };
    },
  },
  {
    name: 'list_all_crm_tasks',
    gate: 'manager',
    available: crmApiConfigured,
    description:
      'רשימת משימות המשרד (CRM) של כל העובדים בארגון — למנהלים. אפשר לסנן לעובד ספציפי (worker_name) או להביא גם משימות שהסתיימו (include_done).',
    parameters: {
      type: 'object',
      properties: {
        worker_name: { type: 'string', description: 'סינון לעובד ספציפי (אופציונלי)' },
        include_done: { type: 'boolean', description: 'לכלול גם משימות שהסתיימו/בוטלו' },
      },
    },
    handler: async (_user, args) => {
      let ownerId: string | undefined;
      let workerLabel = '';
      const workerName = str(args.worker_name);
      if (workerName) {
        const resolved = await resolveUserByName(workerName);
        if (!resolved.ok) return resolved.result;
        ownerId = resolved.id;
        workerLabel = resolved.name;
      }
      const rows = await listAllCrmTasks({
        ownerId,
        status: args.include_done === true ? undefined : undefined,
        limit: 40,
      });
      if (!rows) return { ok: false, error: 'לא הצלחתי לקרוא את המשימות מה-CRM' };
      const { items, more } = cap(rows, 20);
      const scope = workerLabel ? `של ${workerLabel}` : 'בארגון';
      return {
        ok: true,
        count: rows.length,
        more,
        tasks: items.map((t) => ({
          task_id: t.id,
          title: t.title,
          worker: t.ownerName,
          due: t.dueDate ? fmtWhen(t.dueDate) : null,
          priority: t.priority,
          status: t.status,
        })),
        speak:
          rows.length === 0
            ? `אין משימות משרד פתוחות ${scope}.`
            : `יש ${rows.length} משימות משרד פתוחות ${scope}.`,
      };
    },
  },

  // ═══════════════ Messaging ═══════════════
  {
    name: 'send_whatsapp_message',
    gate: 'any',
    description: 'שליחת הודעת וואטסאפ לעובד אחר בארגון (לפי שם). ההודעה נשלחת מטעם הבוט עם ציון השולח.',
    parameters: {
      type: 'object',
      required: ['to_name', 'text'],
      properties: {
        to_name: { type: 'string', description: 'שם העובד' },
        text: { type: 'string', description: 'תוכן ההודעה' },
      },
    },
    handler: async (user, args) => {
      const toName = str(args.to_name);
      const text = str(args.text);
      if (!toName || !text) return { ok: false, error: 'חסר נמען או תוכן' };
      const resolved = await resolveUserByName(toName);
      if (!resolved.ok) return resolved.result;
      const phone = await getUserPhone(resolved.id);
      if (!phone) return { ok: false, error: `ל${resolved.name} אין מספר וואטסאפ במערכת` };
      const wamid = await sendTextMessage({
        to: phone,
        text: `🎙️ הודעה מ${user.name} (דרך העוזרת הקולית):\n\n${text}`,
      });
      if (!wamid) return { ok: false, error: 'שליחת ההודעה נכשלה' };
      return { ok: true, speak: `ההודעה נשלחה ל${resolved.name} בוואטסאפ.` };
    },
  },

  // ═══════════════ Manager: views & search ═══════════════
  {
    name: 'management_snapshot',
    gate: 'manager',
    description: 'תמונת מצב ניהולית: בדיקות היום (סה"כ/בוצעו/בתהליך/ממתינות), חריגים פתוחים, ולידים לא משויכים.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const s = await getManagementSnapshot(localJerusalemDate());
      return {
        ok: true,
        today: s.today,
        open_exceptions: s.openExceptions,
        leads: s.leads,
        speak: `היום ${s.today.total} בדיקות: ${s.today.finished} בוצעו, ${s.today.inProgress} בתהליך, ${s.today.pending} ממתינות. ${s.openExceptions} חריגים פתוחים ו-${s.leads.totalOpen} לידים לא משויכים.`,
      };
    },
  },
  {
    name: 'list_all_inspections',
    gate: 'manager',
    description: 'רשימת כל בדיקות השטח בארגון (עם שם העובד). ברירת מחדל: היום; אפשר טווח בעברית או תאריכים.',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'ביטוי טווח בעברית' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
    },
    handler: async (_user, args) => {
      const scope = resolveDateScope(args);
      const today = localJerusalemDate();
      const isToday = scope.from === today && scope.to === addDays(today, 1);
      const rows = await getTodayFieldInspections(
        today,
        isToday ? undefined : { from: scope.from, to: scope.to },
      );
      const { items, more } = cap(rows);
      return {
        ok: true,
        range: scope.label,
        count: rows.length,
        more,
        inspections: items.map(trimInspectionRow),
        speak: rows.length === 0 ? `אין בדיקות ${scope.label}.` : `יש ${rows.length} בדיקות ${scope.label}.`,
      };
    },
  },
  {
    name: 'list_exceptions',
    gate: 'manager',
    description:
      'חריגים ודיווחים. filter: open_exceptions (כל החריגים) / not_confirmed (לא אושרו) / has_problem (עם בעיה) / waiting_for_info (ממתינות למידע) / not_closed (לא נסגרו).',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['open_exceptions', 'not_confirmed', 'has_problem', 'waiting_for_info', 'not_closed'],
        },
        when: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
    },
    handler: async (_user, args) => {
      const filter = (str(args.filter) ?? 'open_exceptions') as FieldExceptionFilter;
      const scope = resolveDateScope(args);
      const today = localJerusalemDate();
      const isToday = scope.from === today && scope.to === addDays(today, 1);
      const rows = await getFieldExceptionRows(
        today,
        filter,
        isToday ? undefined : { from: scope.from, to: scope.to },
      );
      const { items, more } = cap(rows);
      return {
        ok: true,
        filter,
        count: rows.length,
        more,
        exceptions: items.map((r) => ({
          task_field_id: r.taskFieldId,
          worker: r.workerName,
          customer: r.customerName,
          city: r.siteCity,
          status: statusHe(r.fieldStatus),
          description: r.description,
        })),
        speak: rows.length === 0 ? 'אין חריגים — הכול תקין.' : `יש ${rows.length} חריגים.`,
      };
    },
  },
  {
    name: 'workers_overview',
    gate: 'manager',
    description: 'סקירת כל העובדים: כמה בדיקות סיים כל אחד מתוך כמה, וכמה חריגים.',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
    },
    handler: async (_user, args) => {
      const scope = resolveDateScope(args);
      const today = localJerusalemDate();
      const isToday = scope.from === today && scope.to === addDays(today, 1);
      const rows = await getAllWorkersDayOverview(
        today,
        isToday ? undefined : { from: scope.from, to: scope.to },
      );
      const active = rows.filter((r) => r.total > 0);
      return {
        ok: true,
        range: scope.label,
        workers: rows.map((r) => ({
          worker_id: r.workerId,
          name: r.workerName,
          finished: r.finished,
          total: r.total,
          exceptions: r.exceptions,
        })),
        speak:
          active.length === 0
            ? `אין בדיקות משובצות ${scope.label}.`
            : `${active.length} עובדים עם בדיקות ${scope.label}.`,
      };
    },
  },
  {
    name: 'worker_day_detail',
    gate: 'manager',
    description: 'פירוט היום של עובד ספציפי: אילו בדיקות, סטטוסים וחריגים. worker_name חובה.',
    parameters: {
      type: 'object',
      required: ['worker_name'],
      properties: {
        worker_name: { type: 'string' },
        when: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
    },
    handler: async (_user, args) => {
      const name = str(args.worker_name);
      if (!name) return { ok: false, error: 'חסר שם עובד' };
      const resolved = await resolveUserByName(name);
      if (!resolved.ok) return resolved.result;
      const scope = resolveDateScope(args);
      const today = localJerusalemDate();
      const isToday = scope.from === today && scope.to === addDays(today, 1);
      const d = await getWorkerDayDetail(
        resolved.id,
        today,
        isToday ? undefined : { from: scope.from, to: scope.to },
      );
      const { items, more } = cap(d.inspections);
      return {
        ok: true,
        worker: resolved.name,
        range: scope.label,
        finished: d.finished,
        total: d.total,
        open_exceptions: d.openExceptions,
        more,
        inspections: items.map(trimInspectionRow),
        speak: `${resolved.name}: ${d.finished} מתוך ${d.total} בדיקות הושלמו ${scope.label}${d.openExceptions ? `, ${d.openExceptions} חריגים` : ''}.`,
      };
    },
  },
  {
    name: 'search_inspections',
    gate: 'manager',
    description:
      'חיפוש בדיקות לפי מימד: customer (שם לקוח) / worker (שם עובד) / product (מק"ט) / address (כתובת או עיר) / phone (טלפון) / task_id (מזהה) / status (סטטוס שטח).',
    parameters: {
      type: 'object',
      required: ['by', 'query'],
      properties: {
        by: { type: 'string', enum: ['customer', 'worker', 'product', 'address', 'phone', 'task_id', 'status'] },
        query: { type: 'string' },
      },
    },
    handler: async (_user, args) => {
      const by = str(args.by);
      const query = str(args.query);
      if (!by || !query) return { ok: false, error: 'חסר מימד חיפוש או ערך' };

      const STATUS_HE_TO_ENUM: Record<string, string> = {
        'לא אושרה': 'ASSIGNED', 'לא אושרו': 'ASSIGNED', 'אושרה': 'CONFIRMED',
        'בדרך': 'EN_ROUTE', 'באתר': 'ARRIVED', 'הסתיימה': 'FINISHED_FIELD',
        'הסתיימו': 'FINISHED_FIELD', 'ממתינה למידע': 'WAITING_FOR_INFO',
        'בעיה': 'HAS_PROBLEM', 'נדחתה': 'DECLINED', 'בוטלה': 'CANCELED',
      };

      let rows: TodayFieldInspectionRow[];
      switch (by) {
        case 'customer': rows = await searchTasksByCustomerName(query); break;
        case 'worker': rows = await searchTasksByWorkerName(query); break;
        case 'product': rows = await searchTasksByProductCode(query); break;
        case 'address': rows = await searchTasksByAddress(query); break;
        case 'phone': rows = await searchTasksByPhone(query); break;
        case 'task_id': rows = await searchTasksByTaskId(query); break;
        case 'status':
          rows = await searchTasksByFieldStatus(STATUS_HE_TO_ENUM[query] ?? query.toUpperCase());
          break;
        default:
          return { ok: false, error: 'מימד חיפוש לא מוכר' };
      }
      const { items, more } = cap(rows);
      return {
        ok: true,
        count: rows.length,
        more,
        results: items.map(trimInspectionRow),
        speak: rows.length === 0 ? 'לא נמצאו תוצאות.' : `נמצאו ${rows.length} תוצאות.`,
      };
    },
  },

  // ═══════════════ Manager: leads & assignment ═══════════════
  {
    name: 'list_pending_leads',
    gate: 'manager',
    description: 'לידים נכנסים שממתינים לשיוך לעובד. מחזיר סיכום קצר לכל ליד (כולל 200 תווים ראשונים של גוף ההודעה); לתוכן מלא של ליד בודד קרא ל-get_lead_details.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const rows = await findUnassignedLeadsForAssignment(20);
      const { items, more } = cap(rows, 10);
      return {
        ok: true,
        count: rows.length,
        more,
        leads: items.map((l) => ({
          lead_id: l.id,
          from: l.fromName ?? l.fromEmail,
          subject: l.subject,
          // 200-char snippet so the model can speak roughly what the lead is
          // about; the full body stays behind get_lead_details.
          body_snippet: snippet(l.body, 200),
          status: l.status,
          received: fmtWhen(l.receivedAt),
        })),
        speak: rows.length === 0 ? 'אין לידים שממתינים לשיוך.' : `יש ${rows.length} לידים שממתינים לשיוך.`,
      };
    },
  },
  {
    name: 'get_lead_details',
    gate: 'manager',
    description:
      'פרטים מלאים של ליד בודד: נושא, גוף ההודעה המלא, פרטי השולח, סטטוס, קישור למשימה, ובעל טיפול נוכחי. זיהוי לפי lead_id (UUID) או hint (שם השולח / חלק מהנושא — מתוך רשימת הלידים הממתינים).',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'UUID של הליד' },
        hint: { type: 'string', description: 'שם השולח או חלק מהנושא — לזיהוי ליד ממתין' },
      },
    },
    handler: async (_user, args) => {
      const explicitId = str(args.lead_id);
      const hint = str(args.hint);
      if (!explicitId && !hint) {
        return { ok: false, error: 'צריך lead_id או רמז לזיהוי הליד' };
      }

      // UUID → direct fetch (works even for already-assigned leads).
      // hint → fuzzy over pending leads (same shape as assign_lead's resolver).
      let lead: IncomingLeadRow | null = null;
      if (explicitId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(explicitId)) {
        lead = await getLeadById(explicitId);
        if (!lead) return { ok: false, error: 'הליד לא נמצא' };
      } else if (hint) {
        const pending = await findUnassignedLeadsForAssignment(50);
        const q = hint.toLowerCase();
        const matches = pending.filter(
          (l) =>
            (l.fromName ?? '').toLowerCase().includes(q) ||
            (l.subject ?? '').toLowerCase().includes(q) ||
            (l.fromEmail ?? '').toLowerCase().includes(q),
        );
        if (matches.length === 0) {
          return { ok: false, error: `לא מצאתי ליד ממתין שמתאים ל"${hint}"` };
        }
        if (matches.length > 1) {
          return {
            ok: false,
            error: 'יש כמה לידים מתאימים — לאיזה מהם?',
            options: matches.slice(0, 8).map((l) => ({
              lead_id: l.id,
              from: l.fromName ?? l.fromEmail,
              subject: l.subject,
              received: fmtWhen(l.receivedAt),
            })),
          };
        }
        lead = matches[0];
      } else {
        return { ok: false, error: 'מזהה הליד לא בפורמט תקין' };
      }

      const ownerName = lead.ownerId ? await getUserNameById(lead.ownerId) : null;
      return {
        ok: true,
        detail: {
          lead_id: lead.id,
          subject: lead.subject,
          body: lead.body,
          from_name: lead.fromName,
          from_email: lead.fromEmail,
          status: lead.status,
          task_id: lead.taskId,
          owner_name: ownerName,
          received: fmtWhen(lead.receivedAt),
        },
      };
    },
  },
  {
    name: 'assign_lead',
    // canAssignLeads (leads viewers OR ADMIN/MANAGER) — mirrors the WhatsApp
    // router's gate. Exceptions-only viewers (e.g. Yoram) are intentionally
    // blocked here even though they see the broader manager menu.
    gate: 'leadAssign',
    description: 'שיוך ליד נכנס לעובד. lead_query = שם השולח / נושא / מזהה ליד. worker_name = שם העובד. העובד יקבל התראה בוואטסאפ.',
    parameters: {
      type: 'object',
      required: ['lead_query', 'worker_name'],
      properties: {
        lead_query: { type: 'string' },
        worker_name: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const leadQuery = str(args.lead_query);
      const workerName = str(args.worker_name);
      if (!leadQuery || !workerName) return { ok: false, error: 'חסר זיהוי ליד או שם עובד' };

      // Lead resolution: explicit UUID, else fuzzy match over pending leads.
      let leadId: string | null = null;
      let leadLabel = '';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadQuery)) {
        const lead = await getLeadById(leadQuery);
        if (!lead) return { ok: false, error: 'הליד לא נמצא' };
        leadId = lead.id;
        leadLabel = lead.fromName ?? lead.subject ?? lead.id;
      } else {
        const pending = await findUnassignedLeadsForAssignment(50);
        const q = leadQuery.toLowerCase();
        const matches = pending.filter(
          (l) =>
            (l.fromName ?? '').toLowerCase().includes(q) ||
            (l.subject ?? '').toLowerCase().includes(q) ||
            (l.fromEmail ?? '').toLowerCase().includes(q),
        );
        if (matches.length === 0) {
          return { ok: false, error: `לא מצאתי ליד ממתין שמתאים ל"${leadQuery}" (${pending.length} לידים ממתינים)` };
        }
        if (matches.length > 1) {
          return {
            ok: false,
            error: 'יש כמה לידים מתאימים — לאיזה מהם?',
            options: matches.slice(0, 8).map((l) => ({
              lead_id: l.id,
              from: l.fromName ?? l.fromEmail,
              subject: l.subject,
              received: fmtWhen(l.receivedAt),
            })),
          };
        }
        leadId = matches[0].id;
        leadLabel = matches[0].fromName ?? matches[0].subject ?? matches[0].id;
      }

      const worker = await resolveUserByName(workerName);
      if (!worker.ok) return worker.result;

      try {
        await assignLead(leadId, worker.id, user.id, user.phone);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Race with a parallel manager — the guarded UPDATE hit 0 rows.
        if (msg === 'הליד כבר שויך') {
          return { ok: false, error: 'הליד כבר שויך למישהו אחר לפניך.' };
        }
        throw err;
      }
      return {
        ok: true,
        speak: `הליד של ${leadLabel} שויך ל${worker.name} — הוא יקבל התראה בוואטסאפ.`,
      };
    },
  },
  {
    name: 'reassign_task',
    gate: 'elevated',
    description: 'שיוך משימה מחדש לעובד אחר (מנהלים בלבד). זיהוי לפי task_id או customer_name. העובד החדש יקבל כרטיס שיבוץ.',
    parameters: {
      type: 'object',
      required: ['new_worker_name'],
      properties: {
        task_id: { type: 'string' },
        customer_name: { type: 'string' },
        new_worker_name: { type: 'string' },
      },
    },
    handler: async (user, args) => {
      const newWorkerName = str(args.new_worker_name);
      if (!newWorkerName) return { ok: false, error: 'חסר שם העובד החדש' };

      let taskId = str(args.task_id);
      if (!taskId) {
        const customerName = str(args.customer_name);
        if (!customerName) return { ok: false, error: 'צריך task_id או שם לקוח' };
        const rows = await searchTasksByCustomerName(customerName);
        const unique = [...new Map(rows.map((r) => [r.taskId, r])).values()];
        if (unique.length === 0) return { ok: false, error: `לא נמצאה משימה ללקוח "${customerName}"` };
        if (unique.length > 1) {
          return {
            ok: false,
            error: 'יש כמה משימות מתאימות — לאיזו מהן?',
            options: unique.slice(0, 8).map((r) => ({
              task_id: r.taskId,
              customer: r.customerName,
              worker: r.workerName,
              type: r.typeLabelHe,
            })),
          };
        }
        taskId = unique[0].taskId;
      }

      const worker = await resolveUserByName(newWorkerName);
      if (!worker.ok) return worker.result;

      const result = await reassignTask(taskId, worker.id, user.id);
      return {
        ok: true,
        reset_count: result.resetCount,
        had_in_progress: result.hadInProgressRows,
        speak: `המשימה שויכה ל${worker.name} — הוא יקבל כרטיס שיבוץ${result.hadInProgressRows ? '. שים לב: היו בה בדיקות שכבר בתהליך' : ''}.`,
      };
    },
  },
  {
    name: 'enable_worker_tracking',
    gate: 'manager',
    description: 'הפעלת מעקב מיקום (OwnTracks) לעובד: שולח לו בוואטסאפ קישור הגדרה אישי חד-פעמי (תקף 48 שעות).',
    parameters: {
      type: 'object',
      required: ['worker_name'],
      properties: { worker_name: { type: 'string' } },
    },
    handler: async (_user, args) => {
      const name = str(args.worker_name);
      if (!name) return { ok: false, error: 'חסר שם עובד' };
      const worker = await resolveUserByName(name);
      if (!worker.ok) return worker.result;
      const phone = await getUserPhone(worker.id);
      if (!phone) return { ok: false, error: `ל${worker.name} אין מספר וואטסאפ במערכת` };
      const prov = await createProvisioning(worker.id);
      const sent = await sendTextMessage({
        to: phone,
        text:
          `📍 הפעלת מעקב מיקום\n\n` +
          `היי ${worker.name}, לחץ על הקישור מהטלפון כדי להגדיר את אפליקציית המעקב אוטומטית:\n${prov.magicUrl}\n\n` +
          `הקישור אישי וחד-פעמי, תקף ל-48 שעות.`,
      });
      return {
        ok: true,
        sent: sent !== null,
        magic_url: prov.magicUrl,
        speak: sent
          ? `קישור הפעלת המעקב נשלח ל${worker.name} בוואטסאפ.`
          : `יצרתי קישור אבל שליחת הוואטסאפ נכשלה — הקישור זמין אצלי.`,
      };
    },
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

function isToolAllowed(user: ResolvedUser, tool: VoiceToolDef): boolean {
  if (tool.available && !tool.available()) return false;
  switch (tool.gate) {
    case 'any': return true;
    case 'manager': return isManagerMenuUser(user);
    case 'elevated': return user.isElevated;
    case 'leadAssign': return canAssignLeads(user);
  }
}

/** The subset of tools this user may call, as OpenAI Realtime session tools. */
export function buildOpenAiTools(user: ResolvedUser): Array<Record<string, unknown>> {
  return TOOLS.filter((t) => isToolAllowed(user, t)).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Names only — used by the page UI to render capability chips. */
export function listToolNames(user: ResolvedUser): string[] {
  return TOOLS.filter((t) => isToolAllowed(user, t)).map((t) => t.name);
}

/**
 * Execute one tool call on behalf of `user`. Never throws; always audits.
 */
export async function executeVoiceTool(
  user: ResolvedUser,
  name: string,
  args: Record<string, unknown>,
): Promise<VoiceToolResult> {
  const started = Date.now();
  const tool = TOOLS.find((t) => t.name === name);

  let result: VoiceToolResult;
  if (!tool) {
    result = { ok: false, error: 'כלי לא מוכר' };
  } else if (!isToolAllowed(user, tool)) {
    result = { ok: false, error: 'אין לך הרשאה לפעולה הזו' };
  } else {
    try {
      result = await tool.handler(user, args ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, tool: name, userId: user.id }, 'voice tool failed');
      // Hebrew service errors (thrown by graph/corrections) pass through as-is.
      result = { ok: false, error: /[֐-׿]/.test(msg) ? msg : 'הפעולה נכשלה — כדאי לנסות שוב' };
    }
  }

  await auditVoiceToolCall({
    userId: user.id,
    toolName: name,
    args,
    ok: result.ok,
    summary: result.ok ? (result.speak ?? null) : (result.error ?? null),
    latencyMs: Date.now() - started,
  });

  return result;
}
