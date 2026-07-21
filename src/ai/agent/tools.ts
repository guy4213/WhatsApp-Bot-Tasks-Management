/**
 * Agent tool registry (AI-native free-text path).
 *
 * Each tool wraps an EXISTING service function — it never reimplements CRM
 * logic. Every tool carries:
 *   - a JSON schema (fed to the LLM),
 *   - a permission gate (`allow`) that decides whether the CURRENT user may see
 *     / call it — enforced IN CODE, never trusted to the prompt,
 *   - a `handler` that runs the service and returns a compact string the model
 *     reads back.
 *
 * CRM-write constraints (CLAUDE.md §6.6) are enforced by OMISSION: there is no
 * tool that writes Task.status, prices, or creates customers. The write tools
 * that DO exist (field status, lead assignment, calendar) each re-check the
 * user's permission and ownership through the underlying service.
 *
 * Destructive tools (calendar delete) are marked `destructive: true`; the loop
 * runner requires an explicit confirmation before executing them.
 */
import type { ResolvedUser } from '../../types';
import type { LoopTool } from '../provider';
import { moduleLogger } from '../../utils/logger';

import { getInspectionsForWorkerOnDate } from '../../services/inspectionsQueries';
import {
  advanceFieldStatus,
  resolveOpenTaskFieldByHint,
  validateWorkerTaskField,
  writeProblem,
  writeMissingInfo,
  type AdvanceTransition,
} from '../../services/inspections';
import { listTasks, getTaskById } from '../../services/tasks';
import {
  listEventsAsUser,
  createEventAsUser,
  updateEventAsUser,
  deleteEventAsUser,
  type NormalizedEvent,
} from '../../services/graphCalendar';
import { isManagerMenuUser } from '../menu';

const log = moduleLogger('agent-tools');

/** A tool the agent can call: schema for the model + a code-gated handler. */
export interface AgentTool extends LoopTool {
  /** Whether this tool is exposed to the given user (permission gate, in code). */
  allow: (user: ResolvedUser) => boolean;
  /** When true, the loop must obtain explicit user confirmation before running. */
  destructive?: boolean;
  /** Runs the underlying service. Returns a compact string for the model. */
  handler: (user: ResolvedUser, input: Record<string, unknown>) => Promise<string>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Today's local (Asia/Jerusalem) date as YYYY-MM-DD. */
function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Add whole days to a YYYY-MM-DD (noon-UTC anchor avoids DST edges). */
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Compact one normalized calendar event to a single readable line. */
function eventLine(e: NormalizedEvent): string {
  const when = e.start?.dateTime
    ? e.start.dateTime.replace('T', ' ').slice(0, 16)
    : e.isAllDay
      ? '(יום שלם)'
      : '(ללא שעה)';
  const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : '';
  return `• ${e.subject ?? '(ללא נושא)'} — ${when}${loc} [id:${e.id}]`;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const listMyInspections: AgentTool = {
  name: 'list_my_inspections',
  description:
    'Get the CURRENT user\'s own field inspections (bookings) for a given day, straight from the database. ' +
    'Use for "מה המשימות/הבדיקות שלי היום/מחר". Returns customer, address, status and the internal taskFieldId.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dateScope: {
        type: 'string',
        enum: ['today', 'tomorrow'],
        description: 'Which local (Asia/Jerusalem) day. Defaults to today.',
      },
    },
  },
  async handler(user, input) {
    const scope = str(input, 'dateScope') === 'tomorrow' ? 'tomorrow' : 'today';
    const date = scope === 'tomorrow' ? addDaysISO(todayLocal(), 1) : todayLocal();
    const rows = await getInspectionsForWorkerOnDate(user.id, date);
    if (rows.length === 0) return `אין בדיקות משובצות ל${scope === 'tomorrow' ? 'מחר' : 'היום'} (${date}).`;
    const lines = rows.map(
      (r, i) =>
        `${i + 1}. ${r.customerName ?? '(לקוח לא ידוע)'} — ${r.siteAddress ?? ''}${
          r.siteCity ? ', ' + r.siteCity : ''
        } · ${r.typeLabelHe} · סטטוס: ${r.fieldStatus} [taskFieldId:${r.taskFieldId}]`,
    );
    return `בדיקות ל${scope === 'tomorrow' ? 'מחר' : 'היום'} (${date}):\n${lines.join('\n')}`;
  },
};

const listTasksTool: AgentTool = {
  name: 'list_tasks',
  description:
    'List CRM office tasks (not field inspections). Managers can see all; workers see only their own. ' +
    'Use for "המשימות שלי במערכת", "משימות פתוחות". Returns title, status, due date and customer.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      filter: {
        type: 'string',
        enum: ['today', 'this_week', 'open', 'overdue', 'all'],
        description: 'Which tasks. Defaults to open.',
      },
      scope: {
        type: 'string',
        enum: ['own', 'all'],
        description: 'own = this user\'s tasks; all = org-wide (managers only). Defaults to own.',
      },
    },
  },
  async handler(user, input) {
    const allowed = ['today', 'this_week', 'open', 'overdue', 'all'] as const;
    const raw = str(input, 'filter');
    const filter = (allowed as readonly string[]).includes(raw ?? '')
      ? (raw as (typeof allowed)[number])
      : 'open';
    const requestedScope = str(input, 'scope') === 'all' ? 'all' : 'own';
    // Gate scope=all to managers; listTasks also re-filters owners internally.
    const scope = requestedScope === 'all' && isManagerMenuUser(user) ? 'all' : 'own';
    const { tasks } = await listTasks(user, { filter, scope, dateField: 'dueDate', limit: 30 });
    if (tasks.length === 0) return 'לא נמצאו משימות התואמות לבקשה.';
    const lines = tasks.map((t, i) => {
      const due = t.dueDate ? String(t.dueDate).slice(0, 10) : 'ללא תאריך';
      return `${i + 1}. ${t.title} · ${t.status} · יעד: ${due} [taskId:${t.id}]`;
    });
    return `משימות (${scope === 'all' ? 'כלל־ארגוני' : 'שלי'}, ${tasks.length}):\n${lines.join('\n')}`;
  },
};

const getTaskDetails: AgentTool = {
  name: 'get_task_details',
  description:
    'Get full details of ONE CRM task by its internal taskId (customer, lead, project, status, due date). ' +
    'Use after list_tasks when the user asks about a specific task.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', description: 'The internal task id (from list_tasks).' },
    },
  },
  async handler(user, input) {
    const taskId = str(input, 'taskId');
    if (!taskId) return 'חסר מזהה משימה.';
    const t = await getTaskById(user, taskId);
    if (!t) return 'המשימה לא נמצאה או שאין לך הרשאה לצפות בה.';
    const parts = [
      `כותרת: ${t.title}`,
      `סטטוס: ${t.status}`,
      t.dueDate ? `תאריך יעד: ${String(t.dueDate).slice(0, 10)}` : null,
      t.priority ? `עדיפות: ${t.priority}` : null,
      t.customer ? `לקוח: ${t.customer.name ?? ''} ${t.customer.phone ?? ''}`.trim() : null,
      t.lead ? `ליד: ${t.lead.fullName ?? ''}`.trim() : null,
      t.description ? `תיאור: ${t.description}` : null,
    ].filter(Boolean);
    return parts.join('\n');
  },
};

const setFieldStatus: AgentTool = {
  name: 'set_field_status',
  description:
    'Advance the CURRENT worker\'s field inspection to a new operational status: ' +
    'CONFIRM (אישרתי/מאשר), DEPARTED (יצאתי/בדרך), ARRIVED (הגעתי/באתי), FINISHED (סיימתי). ' +
    'Provide either taskFieldId (from list_my_inspections) OR a customerHint (customer name / address). ' +
    'The write only succeeds on an inspection owned by this user and still open.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['transition'],
    properties: {
      transition: {
        type: 'string',
        enum: ['CONFIRM', 'DEPARTED', 'ARRIVED', 'FINISHED'],
      },
      taskFieldId: { type: 'string', description: 'Exact inspection id (preferred).' },
      customerHint: {
        type: 'string',
        description: 'Customer name or address to resolve the inspection when no id is given.',
      },
    },
  },
  async handler(user, input) {
    const transition = str(input, 'transition') as AdvanceTransition | undefined;
    if (!transition) return 'חסר סטטוס לעדכון.';

    let taskFieldId = str(input, 'taskFieldId');
    if (!taskFieldId) {
      const hint = str(input, 'customerHint');
      if (!hint) {
        return 'לא ציינת לאיזו בדיקה. בקש מהמשתמש שם לקוח / כתובת, או הצג את הרשימה קודם.';
      }
      const resolved = await resolveOpenTaskFieldByHint(user.id, hint);
      if (!resolved) return `לא נמצאה בדיקה פתוחה התואמת ל"${hint}".`;
      if ('ambiguous' in resolved) {
        return `נמצאו ${resolved.count} בדיקות התואמות ל"${hint}". בקש מהמשתמש להיות ספציפי יותר.`;
      }
      taskFieldId = resolved.taskFieldId;
    }

    // Ownership + open-state gate (re-check even when an id was supplied).
    const v = await validateWorkerTaskField(user.id, taskFieldId);
    if (!v.ok) {
      const reason =
        v.reason === 'not_owner'
          ? 'הבדיקה אינה משויכת אליך.'
          : v.reason === 'closed'
            ? 'הבדיקה כבר סגורה.'
            : 'הבדיקה לא נמצאה.';
      return `לא ניתן לעדכן: ${reason}`;
    }

    await advanceFieldStatus({ taskFieldId, transition, updatedBy: user.id });
    const label =
      transition === 'CONFIRM' ? 'אושרה' : transition === 'DEPARTED' ? 'יצאת לדרך' : transition === 'ARRIVED' ? 'הגעת' : 'הסתיימה';
    return `סטטוס הבדיקה של ${v.customerName ?? 'הלקוח'} עודכן: ${label}.`;
  },
};

const reportProblemTool: AgentTool = {
  name: 'report_problem',
  description:
    'Report a problem on the worker\'s inspection (customer not answering, no access, missing equipment, etc.). ' +
    'Provide taskFieldId or customerHint plus a free-text note describing the problem.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['note'],
    properties: {
      note: { type: 'string', description: 'Free-text description of the problem (Hebrew).' },
      taskFieldId: { type: 'string' },
      customerHint: { type: 'string' },
    },
  },
  async handler(user, input) {
    const note = str(input, 'note');
    if (!note) return 'חסר תיאור הבעיה.';
    let taskFieldId = str(input, 'taskFieldId');
    if (!taskFieldId) {
      const hint = str(input, 'customerHint');
      if (!hint) return 'לא ציינת לאיזו בדיקה. בקש שם לקוח / כתובת או הצג רשימה.';
      const resolved = await resolveOpenTaskFieldByHint(user.id, hint);
      if (!resolved) return `לא נמצאה בדיקה פתוחה התואמת ל"${hint}".`;
      if ('ambiguous' in resolved) return `נמצאו ${resolved.count} בדיקות. בקש פרטים ספציפיים יותר.`;
      taskFieldId = resolved.taskFieldId;
    }
    const v = await validateWorkerTaskField(user.id, taskFieldId);
    if (!v.ok) return 'לא ניתן לדווח: הבדיקה אינה משויכת אליך או סגורה.';
    await writeProblem({ taskFieldId, problemType: 'OTHER', note, updatedBy: user.id });
    return `דיווח הבעיה נרשם עבור הבדיקה של ${v.customerName ?? 'הלקוח'}.`;
  },
};

const reportMissingInfoTool: AgentTool = {
  name: 'report_missing_info',
  description:
    'Report that information is missing before the final report can be written (a number, a name, a permit, a form to retrieve). ' +
    'Provide taskFieldId or customerHint plus the missing item.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['note'],
    properties: {
      note: { type: 'string', description: 'What information is missing (Hebrew).' },
      taskFieldId: { type: 'string' },
      customerHint: { type: 'string' },
    },
  },
  async handler(user, input) {
    const note = str(input, 'note');
    if (!note) return 'חסר פירוט המידע החסר.';
    let taskFieldId = str(input, 'taskFieldId');
    if (!taskFieldId) {
      const hint = str(input, 'customerHint');
      if (!hint) return 'לא ציינת לאיזו בדיקה. בקש שם לקוח / כתובת או הצג רשימה.';
      const resolved = await resolveOpenTaskFieldByHint(user.id, hint);
      if (!resolved) return `לא נמצאה בדיקה פתוחה התואמת ל"${hint}".`;
      if ('ambiguous' in resolved) return `נמצאו ${resolved.count} בדיקות. בקש פרטים ספציפיים יותר.`;
      taskFieldId = resolved.taskFieldId;
    }
    const v = await validateWorkerTaskField(user.id, taskFieldId);
    if (!v.ok) return 'לא ניתן לדווח: הבדיקה אינה משויכת אליך או סגורה.';
    await writeMissingInfo({ taskFieldId, note, updatedBy: user.id });
    return `נרשם שחסר: ${note} — עבור הבדיקה של ${v.customerName ?? 'הלקוח'}.`;
  },
};

// ── Calendar (Outlook) tools ─────────────────────────────────────────────────

const calendarList: AgentTool = {
  name: 'calendar_list_events',
  description:
    'List the user\'s own Outlook calendar events in a time window. ' +
    'Use for "מה יש לי ביומן", "אילו פגישות יש לי מחר". Requires the user linked their Microsoft account.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fromDate: { type: 'string', description: 'Local start date YYYY-MM-DD. Defaults to today.' },
      toDate: { type: 'string', description: 'Local end date YYYY-MM-DD (inclusive). Defaults to fromDate.' },
      search: { type: 'string', description: 'Optional free-text subject filter.' },
    },
  },
  async handler(user, input) {
    const from = str(input, 'fromDate') ?? todayLocal();
    const to = str(input, 'toDate') ?? from;
    // Half-open UTC window that safely covers the local days.
    const startIso = `${from}T00:00:00Z`;
    const endIso = `${addDaysISO(to, 1)}T00:00:00Z`;
    const events = await listEventsAsUser(user.id, {
      startIso,
      endIso,
      search: str(input, 'search'),
      top: 50,
    });
    if (events.length === 0) return `אין אירועים ביומן בין ${from} ל-${to}.`;
    return `אירועים ביומן (${events.length}):\n${events.map(eventLine).join('\n')}`;
  },
};

const calendarCreate: AgentTool = {
  name: 'calendar_create_event',
  description:
    'Create a new event on the user\'s own Outlook calendar. Times are local Asia/Jerusalem wall-clock ' +
    '(ISO like "2026-07-22T10:00:00"). Resolve relative dates yourself against today.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['subject', 'startDateTime', 'endDateTime'],
    properties: {
      subject: { type: 'string' },
      startDateTime: { type: 'string', description: 'Local ISO start, e.g. 2026-07-22T10:00:00' },
      endDateTime: { type: 'string', description: 'Local ISO end.' },
      location: { type: 'string' },
      body: { type: 'string', description: 'Optional notes.' },
    },
  },
  async handler(user, input) {
    const subject = str(input, 'subject');
    const start = str(input, 'startDateTime');
    const end = str(input, 'endDateTime');
    if (!subject || !start || !end) return 'חסרים פרטים ליצירת האירוע (נושא / שעת התחלה / שעת סיום).';
    // The canonical createEventAsUser (shared with the voice/text calendar
    // flows) takes startIso/endIso (local wall-clock, no Z).
    const created = await createEventAsUser(user.id, {
      subject,
      startIso: start,
      endIso: end,
      location: str(input, 'location') ?? null,
      body: str(input, 'body') ?? null,
    });
    return `האירוע נוצר ביומן:\n${eventLine(created)}`;
  },
};

const calendarUpdate: AgentTool = {
  name: 'calendar_update_event',
  description:
    'Update an existing Outlook event by its id (from calendar_list_events). Only provided fields change.',
  allow: () => true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['eventId'],
    properties: {
      eventId: { type: 'string' },
      subject: { type: 'string' },
      startDateTime: { type: 'string', description: 'Local ISO start.' },
      endDateTime: { type: 'string', description: 'Local ISO end.' },
      location: { type: 'string' },
      body: { type: 'string' },
    },
  },
  async handler(user, input) {
    const eventId = str(input, 'eventId');
    if (!eventId) return 'חסר מזהה אירוע לעדכון.';
    const updated = await updateEventAsUser(user.id, eventId, {
      subject: str(input, 'subject'),
      startDateTime: str(input, 'startDateTime'),
      endDateTime: str(input, 'endDateTime'),
      location: str(input, 'location'),
      body: str(input, 'body'),
    });
    return `האירוע עודכן:\n${eventLine(updated)}`;
  },
};

const calendarDelete: AgentTool = {
  name: 'calendar_delete_event',
  description:
    'Delete an Outlook event by its id (from calendar_list_events). DESTRUCTIVE — the user is asked to confirm before this runs.',
  allow: () => true,
  destructive: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['eventId'],
    properties: {
      eventId: { type: 'string' },
    },
  },
  async handler(user, input) {
    const eventId = str(input, 'eventId');
    if (!eventId) return 'חסר מזהה אירוע למחיקה.';
    await deleteEventAsUser(user.id, eventId);
    return 'האירוע נמחק מהיומן.';
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

const ALL_TOOLS: AgentTool[] = [
  listMyInspections,
  listTasksTool,
  getTaskDetails,
  setFieldStatus,
  reportProblemTool,
  reportMissingInfoTool,
  calendarList,
  calendarCreate,
  calendarUpdate,
  calendarDelete,
];

/** The tools this user is permitted to use, after the code-level permission gate. */
export function toolsForUser(user: ResolvedUser): AgentTool[] {
  return ALL_TOOLS.filter((t) => t.allow(user));
}

/** Look up a permitted tool by name for the given user (null if not allowed / unknown). */
export function findToolForUser(user: ResolvedUser, name: string): AgentTool | null {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) {
    log.warn({ name }, 'agent requested an unknown tool');
    return null;
  }
  if (!t.allow(user)) {
    log.warn({ name, userId: user.id }, 'agent requested a tool the user is not permitted to use');
    return null;
  }
  return t;
}

/** Export for tests. */
export const __allToolsForTest = ALL_TOOLS;
