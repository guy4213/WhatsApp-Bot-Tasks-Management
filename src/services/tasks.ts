import { pool } from '../db/connection';
import { canViewAllTasks } from '../auth/permissions';
import type { Task, Customer, Lead, Project, ResolvedUser, TaskFilter, TaskListItem } from '../types';

// ── Read: list tasks ──────────────────────────────────────────────────────────

export interface ListTasksResult {
  tasks: TaskListItem[];
  truncated: boolean; // true when there are more rows beyond the returned page
}

export interface ListTasksOptions {
  filter?: TaskFilter;
  scope?: 'own' | 'all';
  /** Restrict to specific employees' tasks (honored only for the caller themselves or an elevated user). */
  ownerIds?: string[];
  /** Which timestamp column the date range applies to (and is ordered by). */
  dateField?: 'dueDate' | 'createdAt';
  /** Inclusive lower bound (ISO date or datetime); compared by calendar date. */
  dateFrom?: string;
  /** Inclusive upper bound (ISO date or datetime); compared by calendar date. */
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export async function listTasks(
  user: ResolvedUser,
  opts: ListTasksOptions = {},
): Promise<ListTasksResult> {
  const { filter = 'all', scope = 'own', dateField = 'createdAt', dateFrom, dateTo } = opts;
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  const conditions: string[] = [];
  const params: unknown[] = [];

  const requestedOwners = opts.ownerIds?.filter(Boolean) ?? [];
  const allowedOwners = canViewAllTasks(user)
    ? requestedOwners
    : requestedOwners.filter((id) => id === user.id);

  if (allowedOwners.length > 0) {
    params.push(allowedOwners);
    conditions.push(`t."ownerId" = ANY($${params.length}::text[])`);
  } else {
    const ownOnly = scope !== 'all' || !canViewAllTasks(user);
    if (ownOnly) {
      params.push(user.id);
      conditions.push(`t."ownerId" = $${params.length}`);
    }
  }

  const dateCol = dateField === 'createdAt' ? 'createdAt' : 'dueDate';
  const hasRange = Boolean(dateFrom || dateTo);

  if (hasRange) {
    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`t."${dateCol}"::date >= $${params.length}::date`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`t."${dateCol}"::date <= $${params.length}::date`);
    }
    if (filter === 'open') conditions.push(`t.status IN ('OPEN', 'IN_PROGRESS')`);
  } else {
    switch (filter) {
      case 'today':
        conditions.push(`t."${dateCol}"::date = CURRENT_DATE`);
        break;
      case 'today_overdue':
        conditions.push(
          `t.status != 'DONE' AND t."dueDate" IS NOT NULL AND t."dueDate"::date <= CURRENT_DATE`,
        );
        break;
      case 'this_week':
        conditions.push(
          `t."${dateCol}" >= date_trunc('week', now()) AND t."${dateCol}" < date_trunc('week', now()) + interval '7 days'`,
        );
        break;
      case 'open':
        conditions.push(`t.status IN ('OPEN', 'IN_PROGRESS')`);
        break;
      case 'next_deadline':
        conditions.push(`t."dueDate" IS NOT NULL AND t.status != 'DONE'`);
        break;
      case 'overdue':
        conditions.push(`t.status != 'DONE' AND t."dueDate" IS NOT NULL AND t."dueDate" < now()`);
        break;
      case 'unlinked':
        conditions.push(`t."customerId" IS NULL AND t."leadId" IS NULL AND t."projectId" IS NULL`);
        break;
      default:
        break;
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const orderBy =
    dateField === 'createdAt'
      ? `ORDER BY t."createdAt" DESC`
      : `ORDER BY
           (CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END),
           (CASE WHEN t.status != 'DONE' AND t."dueDate" IS NOT NULL AND t."dueDate" < now() THEN 0 ELSE 1 END),
           (CASE WHEN t.status != 'DONE' AND t."dueDate"::date = CURRENT_DATE THEN 0 ELSE 1 END),
           (CASE upper(COALESCE(t.priority::text, '')) WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END),
           t."dueDate" ASC NULLS LAST,
           t."createdAt" DESC`;

  params.push(limit + 1, offset);
  const limitParam  = params.length - 1;
  const offsetParam = params.length;

  const sql = `
    SELECT t.id, t.title, t.description, t."dueDate", t.priority,
           t.status, t.type, t."createdAt", t."updatedAt",
           t."ownerId", t."customerId", t."leadId", t."projectId",
           u.name        AS "ownerName",
           c.name        AS "customerName",
           l."fullName"  AS "leadName",
           p.name        AS "projectName"
    FROM "Task" t
    JOIN "User" u       ON u.id = t."ownerId"
    LEFT JOIN "Customer" c ON c.id = t."customerId"
    LEFT JOIN "Lead"     l ON l.id = t."leadId"
    LEFT JOIN "Project"  p ON p.id = t."projectId"
    ${where}
    ${orderBy}
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `;

  const result = await pool.query<TaskListItem>(sql, params);
  const truncated = result.rows.length > limit;
  return { tasks: result.rows.slice(0, limit), truncated };
}

/** Find active users whose name contains the given text (for "tasks of <name>"). */
export async function findUsersByName(name: string): Promise<Array<{ id: string; name: string }>> {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "User"
     WHERE upper(status::text) = 'ACTIVE' AND name ILIKE '%' || $1 || '%'
     ORDER BY name
     LIMIT 10`,
    [name],
  );
  return result.rows;
}

/**
 * Find customers whose name contains the given text (for "link task to <name>").
 * Used to resolve a customer NAME to its id before a relink: the customerId column
 * is an FK, so a raw name would fail the update. Returns id + display label.
 */
export async function findCustomersByName(name: string): Promise<Array<{ id: string; label: string }>> {
  const result = await pool.query<{ id: string; label: string }>(
    `SELECT id, name AS label FROM "Customer"
     WHERE name ILIKE '%' || $1 || '%'
     ORDER BY name
     LIMIT 10`,
    [name],
  );
  return result.rows;
}

/** Find leads whose name contains the given text (FK resolution for relink). */
export async function findLeadsByName(name: string): Promise<Array<{ id: string; label: string }>> {
  const result = await pool.query<{ id: string; label: string }>(
    `SELECT id, "fullName" AS label FROM "Lead"
     WHERE "fullName" ILIKE '%' || $1 || '%'
     ORDER BY "fullName"
     LIMIT 10`,
    [name],
  );
  return result.rows;
}

/** Find projects whose name contains the given text (FK resolution for relink). */
export async function findProjectsByName(name: string): Promise<Array<{ id: string; label: string }>> {
  const result = await pool.query<{ id: string; projectNumber: string | null; name: string }>(
    `SELECT id, "projectNumber", name FROM "Project"
     WHERE name ILIKE '%' || $1 || '%'
     ORDER BY name
     LIMIT 10`,
    [name],
  );
  return result.rows.map((r) => ({
    id: r.id,
    label: (r.projectNumber ? `#${r.projectNumber} ` : '') + r.name,
  }));
}

// ── Read: digest summaries (morning plan / end-of-day status) ─────────────────
// V1 has NO reliable completedAt/status-history column, so the evening report is
// strictly CURRENT end-of-day status (not a "completed during today" claim). All
// classification is by the task's CURRENT status + dueDate, with CURRENT_DATE in
// the pool's pinned Asia/Jerusalem session tz. See BOT_V1_DESIGN_UPDATE_PLAN §1/§5.

// X-T3 (2026-07-01): `EmployeeMorningCounts` + `getEmployeeMorningCounts` were
// removed — they fed the old CRM-tasks employee morning digest which was
// replaced by the inspector morning digest (D2-T4) for every non-ADMIN user.

/** Employee end-of-day ("current status") counts + unfinished titles for the in-window list. */
export interface EmployeeEndOfDay {
  dueToday: number;       // ALL tasks due today (completed + notCompleted === dueToday)
  completed: number;      // due today AND status = 'DONE'
  notCompleted: number;   // due today AND status <> 'DONE'
  overdue: number;        // dueDate before today AND status <> 'DONE'
  openCarry: number;      // OPEN / IN_PROGRESS backlog rolling to tomorrow
  unfinishedTitles: string[];
}

/** One employee's row inside the company-wide morning picture. */
export interface CompanyMorningEmployee {
  ownerId: string;
  ownerName: string;
  dueToday: number;
  overdue: number;
  open: number;
}

export interface CompanyMorning {
  dueToday: number;
  overdue: number;
  open: number;
  employeesWithOverdue: number;
  employees: CompanyMorningEmployee[];
}

/** One employee's row inside the company-wide end-of-day picture. */
export interface CompanyEndOfDayEmployee {
  ownerId: string;
  ownerName: string;
  dueToday: number;
  completed: number;
  notCompleted: number;
  overdue: number;
  openCarry: number;
}

export interface CompanyEndOfDay {
  dueToday: number;
  completed: number;
  notCompleted: number;
  overdue: number;
  openCarry: number;
  employeesWithUnfinishedOrOverdue: number;
  employees: CompanyEndOfDayEmployee[];
}

/** End-of-day (current status) counts + unfinished titles for ONE employee — own tasks only. */
export async function getEmployeeEndOfDay(ownerId: string): Promise<EmployeeEndOfDay> {
  const counts = await pool.query<{
    due_today: number; completed: number; not_completed: number; overdue: number; open_carry: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE)::int                      AS due_today,
       COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE AND t.status = 'DONE')::int  AS completed,
       COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE AND t.status <> 'DONE')::int AS not_completed,
       COUNT(*) FILTER (WHERE t."dueDate"::date < CURRENT_DATE AND t.status <> 'DONE')::int AS overdue,
       COUNT(*) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS'))::int                      AS open_carry
     FROM "Task" t
     WHERE t."ownerId" = $1`,
    [ownerId],
  );

  const titles = await pool.query<{ title: string }>(
    `SELECT t.title
     FROM "Task" t
     WHERE t."ownerId" = $1
       AND t."dueDate"::date = CURRENT_DATE
       AND t.status <> 'DONE'
     ORDER BY t."dueDate" ASC NULLS LAST
     LIMIT 10`,
    [ownerId],
  );

  const c = counts.rows[0];
  return {
    dueToday: c.due_today,
    completed: c.completed,
    notCompleted: c.not_completed,
    overdue: c.overdue,
    openCarry: c.open_carry,
    unfinishedTitles: titles.rows.map((t) => t.title),
  };
}

/** Company-wide morning picture (manager/admin) — totals + per-employee + #overdue. */
export async function getCompanyMorning(): Promise<CompanyMorning> {
  const result = await pool.query<{
    owner_id: string; owner_name: string; due_today: number; overdue: number; open: number;
  }>(
    `SELECT
       u.id   AS owner_id,
       u.name AS owner_name,
       COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE AND t.status <> 'DONE')::int AS due_today,
       COUNT(*) FILTER (WHERE t."dueDate"::date < CURRENT_DATE AND t.status <> 'DONE')::int AS overdue,
       COUNT(*) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS'))::int                      AS open
     FROM "User" u
     JOIN "Task" t ON t."ownerId" = u.id
     WHERE upper(u.status::text) = 'ACTIVE'
     GROUP BY u.id, u.name
     HAVING COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE AND t.status <> 'DONE') > 0
         OR COUNT(*) FILTER (WHERE t."dueDate"::date < CURRENT_DATE AND t.status <> 'DONE') > 0
         OR COUNT(*) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS')) > 0
     ORDER BY overdue DESC, due_today DESC, open DESC`,
  );

  const employees: CompanyMorningEmployee[] = result.rows.map((r) => ({
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    dueToday: r.due_today,
    overdue: r.overdue,
    open: r.open,
  }));

  return {
    dueToday: employees.reduce((s, e) => s + e.dueToday, 0),
    overdue: employees.reduce((s, e) => s + e.overdue, 0),
    open: employees.reduce((s, e) => s + e.open, 0),
    employeesWithOverdue: employees.filter((e) => e.overdue > 0).length,
    employees,
  };
}

/** Company-wide end-of-day picture (manager/admin) — totals + per-employee + #behind. */
export async function getCompanyEndOfDay(): Promise<CompanyEndOfDay> {
  const result = await pool.query<{
    owner_id: string; owner_name: string;
    due_today: number; completed: number; not_completed: number; overdue: number; open_carry: number;
  }>(
    `SELECT
       u.id   AS owner_id,
       u.name AS owner_name,
       COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE)::int                      AS due_today,
       COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE AND t.status = 'DONE')::int  AS completed,
       COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE AND t.status <> 'DONE')::int AS not_completed,
       COUNT(*) FILTER (WHERE t."dueDate"::date < CURRENT_DATE AND t.status <> 'DONE')::int AS overdue,
       COUNT(*) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS'))::int                      AS open_carry
     FROM "User" u
     JOIN "Task" t ON t."ownerId" = u.id
     WHERE upper(u.status::text) = 'ACTIVE'
     GROUP BY u.id, u.name
     HAVING COUNT(*) FILTER (WHERE t."dueDate"::date = CURRENT_DATE) > 0
         OR COUNT(*) FILTER (WHERE t."dueDate"::date < CURRENT_DATE AND t.status <> 'DONE') > 0
         OR COUNT(*) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS')) > 0
     ORDER BY overdue DESC, not_completed DESC, due_today DESC`,
  );

  const employees: CompanyEndOfDayEmployee[] = result.rows.map((r) => ({
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    dueToday: r.due_today,
    completed: r.completed,
    notCompleted: r.not_completed,
    overdue: r.overdue,
    openCarry: r.open_carry,
  }));

  return {
    dueToday: employees.reduce((s, e) => s + e.dueToday, 0),
    completed: employees.reduce((s, e) => s + e.completed, 0),
    notCompleted: employees.reduce((s, e) => s + e.notCompleted, 0),
    overdue: employees.reduce((s, e) => s + e.overdue, 0),
    openCarry: employees.reduce((s, e) => s + e.openCarry, 0),
    employeesWithUnfinishedOrOverdue: employees.filter((e) => e.notCompleted > 0 || e.overdue > 0).length,
    employees,
  };
}

// ── Read: single task with joined entities ────────────────────────────────────

export interface TaskDetail extends Task {
  customer: Pick<Customer, 'id' | 'name' | 'phone' | 'city' | 'status'> | null;
  lead: Pick<Lead, 'id' | 'fullName' | 'phone' | 'city' | 'status'> | null;
  project: Pick<Project, 'id' | 'projectNumber' | 'name' | 'status' | 'city' | 'dueDate'> | null;
}

export async function getTaskById(
  user: ResolvedUser,
  taskId: string,
): Promise<TaskDetail | null> {
  const scopeCondition = canViewAllTasks(user) ? '' : `AND t."ownerId" = $2`;

  const result = await pool.query<TaskDetail>(
    `SELECT
       t.id, t.title, t.description, t."dueDate", t.priority,
       t.status, t.type, t."createdAt", t."updatedAt",
       t."ownerId", t."customerId", t."leadId", t."projectId",

       -- customer subset (NULL when no customer linked)
       CASE WHEN c.id IS NOT NULL THEN json_build_object(
         'id',     c.id,
         'name',   c.name,
         'phone',  c.phone,
         'city',   c.city,
         'status', c.status
       ) END AS customer,

       -- lead subset (NULL when no lead linked)
       CASE WHEN l.id IS NOT NULL THEN json_build_object(
         'id',       l.id,
         'fullName', l."fullName",
         'phone',    l.phone,
         'city',     l.city,
         'status',   l.status
       ) END AS lead,

       -- project subset (NULL when no project linked)
       CASE WHEN p.id IS NOT NULL THEN json_build_object(
         'id',            p.id,
         'projectNumber', p."projectNumber",
         'name',          p.name,
         'status',        p.status,
         'city',          p.city,
         'dueDate',       p."dueDate"
       ) END AS project

     FROM "Task" t
     LEFT JOIN "Customer" c ON c.id = t."customerId"
     LEFT JOIN "Lead"     l ON l.id = t."leadId"
     LEFT JOIN "Project"  p ON p.id = t."projectId"
     WHERE t.id = $1 ${scopeCondition}`,
    canViewAllTasks(user) ? [taskId] : [taskId, user.id],
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

// ── Write: create task ────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  description?: string;
  dueDate?: string;
  priority?: string;
  type: string;
  ownerId: string;
  customerId?: string;
  leadId?: string;
  projectId?: string;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  try {
    const result = await pool.query<Task>(
      // The CRM "Task" table has no DB defaults for id/updatedAt (the app supplies
      // them), so we generate a UUID id and set updatedAt here. createdAt defaults.
      `INSERT INTO "Task" (id, title, description, "dueDate", priority, type, status, "ownerId", "customerId", "leadId", "projectId", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9, now())
       RETURNING *`,
      [
        input.title,
        input.description ?? null,
        input.dueDate ?? null,
        // Task.priority is NOT NULL DEFAULT 'MEDIUM' — never insert NULL
        input.priority ?? 'MEDIUM',
        input.type,
        input.ownerId,
        input.customerId ?? null,
        input.leadId ?? null,
        input.projectId ?? null,
      ],
    );
    return result.rows[0];
  } catch (err: unknown) {
    // FK violation — surface a readable message instead of a raw DB error
    if ((err as { code?: string }).code === '23503') {
      const detail = (err as { detail?: string }).detail ?? '';
      throw new FKError(`Referenced record not found: ${detail}`);
    }
    throw err;
  }
}

// Typed FK error so callers can distinguish it from unexpected errors
export class FKError extends Error {
  readonly isFKError = true;
}

// ── Write: edit a single free-edit field ──────────────────────────────────────

const ALLOWED_FREE_EDIT_COLUMNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  type: 'type',
};

export async function updateTaskField(
  taskId: string,
  field: string,
  newValue: unknown,
): Promise<Task> {
  const column = ALLOWED_FREE_EDIT_COLUMNS[field];
  if (!column) throw new Error(`Field "${field}" is not a free-edit field`);

  const result = await pool.query<Task>(
    `UPDATE "Task" SET "${column}" = $1, "updatedAt" = now() WHERE id = $2 RETURNING *`,
    [newValue, taskId],
  );

  if (result.rowCount === 0) throw new Error(`Task ${taskId} not found`);
  return result.rows[0];
}

// ── Write: update dueDate (called only after manager approval) ────────────────

export async function updateDueDate(taskId: string, newDueDate: string): Promise<Task> {
  const result = await pool.query<Task>(
    `UPDATE "Task" SET "dueDate" = $1, "updatedAt" = now() WHERE id = $2 RETURNING *`,
    [newDueDate, taskId],
  );
  if (result.rowCount === 0) throw new Error(`Task ${taskId} not found`);
  return result.rows[0];
}

// ── Write: admin-only field updates ──────────────────────────────────────────

const ADMIN_COLUMNS: Record<string, string> = {
  ownerId: 'ownerId',
  customerId: 'customerId',
  leadId: 'leadId',
  projectId: 'projectId',
};

export async function updateAdminField(
  taskId: string,
  field: string,
  newValue: unknown,
): Promise<Task> {
  const column = ADMIN_COLUMNS[field];
  if (!column) throw new Error(`Field "${field}" is not an admin-only field`);

  try {
    const result = await pool.query<Task>(
      `UPDATE "Task" SET "${column}" = $1, "updatedAt" = now() WHERE id = $2 RETURNING *`,
      [newValue, taskId],
    );
    if (result.rowCount === 0) throw new Error(`Task ${taskId} not found`);
    return result.rows[0];
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23503') {
      const detail = (err as { detail?: string }).detail ?? '';
      throw new FKError(`Referenced record not found: ${detail}`);
    }
    throw err;
  }
}

// ── Enum helpers ──────────────────────────────────────────────────────────────

import { BOT_ASSIGNABLE_TASK_TYPES } from '../types';

/**
 * Returns task types the bot is allowed to assign (enum values step1..step7 + stepQuote).
 */
export async function getAllowedTaskTypes(): Promise<string[]> {
  return [...BOT_ASSIGNABLE_TASK_TYPES];
}

/**
 * Map a user-supplied task type — a raw enum value OR a plain-Hebrew description —
 * to its canonical enum value. The AI is asked to emit the enum directly, but
 * users also type Hebrew freely, so we normalize here as a safety net.
 * Returns null when nothing matches (caller asks for clarification).
 */
const TASK_TYPE_SYNONYMS: Record<string, string> = {
  // step1 — פתיחת פנייה
  'פתיחת פנייה': 'step1', 'פתיחת פניה': 'step1', 'פתיחה': 'step1', 'פנייה': 'step1', 'פניה': 'step1',
  // step2 — התאמת הפתרון
  'התאמת הפתרון': 'step2', 'התאמת פתרון': 'step2', 'התאמה': 'step2', 'פתרון': 'step2',
  // step3 — שיחת מכירה
  'שיחת מכירה': 'step3', 'מכירה': 'step3', 'שיחת מכירות': 'step3',
  // stepQuote — הצעת מחיר
  'הצעת מחיר': 'stepQuote', 'הצעה': 'stepQuote', 'מחיר': 'stepQuote', 'הצעת־מחיר': 'stepQuote',
  // step4 — פולואפ
  'פולואפ': 'step4', 'פולו אפ': 'step4', 'מעקב': 'step4', 'follow up': 'step4', 'followup': 'step4',
  // step5 — תיאום
  'תיאום': 'step5', 'תאום': 'step5', 'תיאום הגעה': 'step5',
  // step6 — ביצוע
  'ביצוע': 'step6', 'התקנה': 'step6', 'עבודה': 'step6',
  // step7 — דוח
  'דוח': 'step7', 'דו"ח': 'step7', 'דוח סיום': 'step7', 'סיכום': 'step7', 'כתיבת דוח': 'step7',
};

export function normalizeTaskType(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already a valid enum value (case-insensitive on the stepN part)
  const direct = BOT_ASSIGNABLE_TASK_TYPES.find(
    (t) => t.toLowerCase() === trimmed.toLowerCase(),
  );
  if (direct) return direct;

  // Exact Hebrew/synonym match
  const key = trimmed.toLowerCase();
  for (const [label, value] of Object.entries(TASK_TYPE_SYNONYMS)) {
    if (label.toLowerCase() === key) return value;
  }
  // Substring fallback: the message contains a known label
  for (const [label, value] of Object.entries(TASK_TYPE_SYNONYMS)) {
    if (trimmed.includes(label)) return value;
  }
  return null;
}

/**
 * Returns valid Task.priority values, read live from the "TaskPriority" enum
 * (cached after first fetch). Used to validate user-supplied priorities.
 */
let priorityCache: string[] | null = null;

export async function getAllowedPriorities(): Promise<string[]> {
  if (priorityCache) return priorityCache;
  const result = await pool.query<{ value: string }>(
    `SELECT unnest(enum_range(NULL::"TaskPriority"))::text AS value`,
  );
  priorityCache = result.rows.map((r) => r.value);
  return priorityCache;
}
