/**
 * D2-T11 — TaskField scheduling service.
 *
 * Provides query helpers and the INSERT for scheduling a new field visit
 * (`TaskField` row) for an existing CRM `Task` from WhatsApp.
 *
 * The bot NEVER writes `Task` or `Customer` — only `TaskField`.
 * `workerNotifiedAt` is left NULL so the D5-T6 poller (assignmentCardNotifier)
 * sends the §6 card automatically.
 *
 * Column-name assumptions (see §14 open question 1 in HANDOFF.md):
 *  - Task.customerId, Task.ownerId, Task.productName, Task.title, Task.status, Task.updatedAt
 *  - Customer.id, Customer.name, Customer.address, Customer.city,
 *    Customer.contactName, Customer.contactPhone, Customer.navigationUrl
 *    (TODO: verify navigationUrl column name against actual CRM schema)
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('taskFieldScheduling');

// ── Types ────────────────────────────────────────────────────────────────────

export interface TaskCandidate {
  id: string;
  title: string;
  productName: string | null;
  customerId: string | null;
  customerName: string | null;
  inspectionLabelHe: string | null;
  inspectionFamily: string | null;
  inspectionTypeId: string | null;
  ownerId: string | null;
  // Site metadata copied from Task or Customer (per HANDOFF §6 "Column verification needed")
  siteAddress: string | null;
  siteCity: string | null;
  fieldContactName: string | null;
  fieldContactPhone: string | null;
  navigationUrl: string | null;
}

export interface CustomerCandidate {
  id: string;
  name: string;
  openTaskCount: number;
}

export interface ScheduleTaskFieldInput {
  taskId: string;
  inspectionTypeId: string;        // from InspectionType.id matched via Task.productName
  family: string;                  // snapshot from InspectionType.family
  appointmentTitle: string;        // synthesized: e.g. "בדיקה נוספת ל-<customerName>"
  scheduledStartAt: string;        // ISO 8601 (user-supplied, already validated future)
  durationMinutes: number;         // default 60
  siteAddress: string | null;
  siteCity: string | null;
  fieldContactName: string | null;
  fieldContactPhone: string | null;
  navigationUrl: string | null;
  specialInstructions: string | null;
  updatedByUserId: string;          // the actor (WORKER / MANAGER / ADMIN)
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Return open Tasks for a specific owner (WORKER path — own tasks only).
 * Matches HANDOFF §6 query exactly.
 */
export async function findOpenTasksForOwner(
  ownerId: string,
  limit = 10,
): Promise<TaskCandidate[]> {
  try {
    const res = await pool.query<{
      id: string;
      productName: string | null;
      title: string;
      customerId: string | null;
      customerName: string | null;
      inspectionLabelHe: string | null;
      inspectionFamily: string | null;
      inspectionTypeId: string | null;
      ownerId: string | null;
      siteAddress: string | null;
      siteCity: string | null;
      fieldContactName: string | null;
      fieldContactPhone: string | null;
      navigationUrl: string | null;
    }>(
      `SELECT
         t.id, t."productName", t.title,
         t."customerId",
         -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
         COALESCE(
           c.name,
           l."fullName",
           NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
           l.company,
           p.client,
           il."fromName"
         ) AS "customerName",
         it."labelHe" AS "inspectionLabelHe",
         it.family AS "inspectionFamily",
         it.id AS "inspectionTypeId",
         t."ownerId",
         c.address AS "siteAddress",
         c.city AS "siteCity",
         c."contactName" AS "fieldContactName",
         c."contactPhone" AS "fieldContactPhone",
         c."navigationUrl" AS "navigationUrl"
       FROM "Task" t
       LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
       LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
       LEFT JOIN "Project"      p  ON p.id  = t."projectId"
       LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
       LEFT JOIN "InspectionType" it ON it.code = t."productName"
       WHERE t."ownerId" = $1
         AND t.status NOT IN ('DONE', 'CANCELED')
       ORDER BY t."updatedAt" DESC
       LIMIT $2`,
      [ownerId, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      productName: r.productName,
      customerId: r.customerId,
      customerName: r.customerName,
      inspectionLabelHe: r.inspectionLabelHe,
      inspectionFamily: r.inspectionFamily,
      inspectionTypeId: r.inspectionTypeId,
      ownerId: r.ownerId,
      siteAddress: r.siteAddress,
      siteCity: r.siteCity,
      fieldContactName: r.fieldContactName,
      fieldContactPhone: r.fieldContactPhone,
      navigationUrl: r.navigationUrl,
    }));
  } catch (err) {
    log.error({ err, ownerId }, 'findOpenTasksForOwner failed');
    return [];
  }
}

/**
 * Return open Tasks across all owners (MANAGER / ADMIN path).
 */
export async function findOpenTasksForAdmin(limit = 10): Promise<TaskCandidate[]> {
  try {
    const res = await pool.query<{
      id: string;
      productName: string | null;
      title: string;
      customerId: string | null;
      customerName: string | null;
      inspectionLabelHe: string | null;
      inspectionFamily: string | null;
      inspectionTypeId: string | null;
      ownerId: string | null;
      siteAddress: string | null;
      siteCity: string | null;
      fieldContactName: string | null;
      fieldContactPhone: string | null;
      navigationUrl: string | null;
    }>(
      `SELECT
         t.id, t."productName", t.title,
         t."customerId",
         -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
         COALESCE(
           c.name,
           l."fullName",
           NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
           l.company,
           p.client,
           il."fromName"
         ) AS "customerName",
         it."labelHe" AS "inspectionLabelHe",
         it.family AS "inspectionFamily",
         it.id AS "inspectionTypeId",
         t."ownerId",
         c.address AS "siteAddress",
         c.city AS "siteCity",
         c."contactName" AS "fieldContactName",
         c."contactPhone" AS "fieldContactPhone",
         c."navigationUrl" AS "navigationUrl"
       FROM "Task" t
       LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
       LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
       LEFT JOIN "Project"      p  ON p.id  = t."projectId"
       LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
       LEFT JOIN "InspectionType" it ON it.code = t."productName"
       WHERE t.status NOT IN ('DONE', 'CANCELED')
       ORDER BY t."updatedAt" DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      productName: r.productName,
      customerId: r.customerId,
      customerName: r.customerName,
      inspectionLabelHe: r.inspectionLabelHe,
      inspectionFamily: r.inspectionFamily,
      inspectionTypeId: r.inspectionTypeId,
      ownerId: r.ownerId,
      siteAddress: r.siteAddress,
      siteCity: r.siteCity,
      fieldContactName: r.fieldContactName,
      fieldContactPhone: r.fieldContactPhone,
      navigationUrl: r.navigationUrl,
    }));
  } catch (err) {
    log.error({ err }, 'findOpenTasksForAdmin failed');
    return [];
  }
}

/**
 * Search customers by name substring (fallback path in HANDOFF §3a).
 * Returns customer rows with open-task count, sorted by count DESC.
 */
export async function findCustomersByName(
  query: string,
  limit = 10,
): Promise<CustomerCandidate[]> {
  if (!query.trim()) return [];
  try {
    const res = await pool.query<{ id: string; name: string; open_task_count: string }>(
      `SELECT c.id, c.name,
         COUNT(t.id) FILTER (
           WHERE t.status NOT IN ('DONE','CANCELED')
         ) AS open_task_count
       FROM "Customer" c
       LEFT JOIN "Task" t ON t."customerId" = c.id
       WHERE c.name ILIKE '%' || $1 || '%'
       GROUP BY c.id, c.name
       ORDER BY open_task_count DESC, c.name ASC
       LIMIT $2`,
      [query.trim(), limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      openTaskCount: parseInt(r.open_task_count ?? '0', 10),
    }));
  } catch (err) {
    log.error({ err, query }, 'findCustomersByName failed');
    return [];
  }
}

/**
 * Return open Tasks for a specific customer (after the fallback search picks one).
 */
export async function findOpenTasksForCustomer(
  customerId: string,
  limit = 10,
): Promise<TaskCandidate[]> {
  try {
    const res = await pool.query<{
      id: string;
      productName: string | null;
      title: string;
      customerId: string | null;
      customerName: string | null;
      inspectionLabelHe: string | null;
      inspectionFamily: string | null;
      inspectionTypeId: string | null;
      ownerId: string | null;
      siteAddress: string | null;
      siteCity: string | null;
      fieldContactName: string | null;
      fieldContactPhone: string | null;
      navigationUrl: string | null;
    }>(
      `SELECT
         t.id, t."productName", t.title,
         t."customerId",
         -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
         COALESCE(
           c.name,
           l."fullName",
           NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
           l.company,
           p.client,
           il."fromName"
         ) AS "customerName",
         it."labelHe" AS "inspectionLabelHe",
         it.family AS "inspectionFamily",
         it.id AS "inspectionTypeId",
         t."ownerId",
         c.address AS "siteAddress",
         c.city AS "siteCity",
         c."contactName" AS "fieldContactName",
         c."contactPhone" AS "fieldContactPhone",
         c."navigationUrl" AS "navigationUrl"
       FROM "Task" t
       LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
       LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
       LEFT JOIN "Project"      p  ON p.id  = t."projectId"
       LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
       LEFT JOIN "InspectionType" it ON it.code = t."productName"
       WHERE t."customerId" = $1
         AND t.status NOT IN ('DONE', 'CANCELED')
       ORDER BY t."updatedAt" DESC
       LIMIT $2`,
      [customerId, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      productName: r.productName,
      customerId: r.customerId,
      customerName: r.customerName,
      inspectionLabelHe: r.inspectionLabelHe,
      inspectionFamily: r.inspectionFamily,
      inspectionTypeId: r.inspectionTypeId,
      ownerId: r.ownerId,
      siteAddress: r.siteAddress,
      siteCity: r.siteCity,
      fieldContactName: r.fieldContactName,
      fieldContactPhone: r.fieldContactPhone,
      navigationUrl: r.navigationUrl,
    }));
  } catch (err) {
    log.error({ err, customerId }, 'findOpenTasksForCustomer failed');
    return [];
  }
}

// ── Insert ───────────────────────────────────────────────────────────────────

/**
 * INSERT one `TaskField` row. Wrapped in BEGIN...COMMIT; rolls back on error.
 *
 * `workerNotifiedAt` is intentionally LEFT NULL so the D5-T6 poller
 * (assignmentCardNotifier) sends the §6 assignment card automatically.
 *
 * Returns the new `TaskField.id` on success.
 */
export async function scheduleTaskField(
  input: ScheduleTaskFieldInput,
): Promise<{ taskFieldId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query<{ id: string }>(
      `INSERT INTO "TaskField" (
         id,
         "taskId",
         "inspectionTypeId",
         family,
         "appointmentTitle",
         "scheduledStartAt",
         "scheduledEndAt",
         "durationMinutes",
         "siteAddress",
         "siteCity",
         "fieldContactName",
         "fieldContactPhone",
         "navigationUrl",
         "specialInstructions",
         "assignedAt",
         "fieldStatus",
         "updatedByUserId",
         "createdAt",
         "updatedAt"
       ) VALUES (
         gen_random_uuid(),
         $1,
         $2,
         $3,
         $4,
         $5::timestamptz,
         $5::timestamptz + ($6 || ' minutes')::interval,
         $6::integer,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         now(),
         'ASSIGNED',
         $13,
         now(),
         now()
       )
       RETURNING id`,
      [
        input.taskId,           // $1
        input.inspectionTypeId, // $2
        input.family,           // $3
        input.appointmentTitle, // $4
        input.scheduledStartAt, // $5
        input.durationMinutes,  // $6
        input.siteAddress,      // $7
        input.siteCity,         // $8
        input.fieldContactName, // $9
        input.fieldContactPhone,// $10
        input.navigationUrl,    // $11
        input.specialInstructions, // $12
        input.updatedByUserId,  // $13
      ],
    );

    await client.query('COMMIT');

    const taskFieldId = res.rows[0]?.id;
    if (!taskFieldId) throw new Error('INSERT returned no id');

    log.info({ taskFieldId, taskId: input.taskId }, 'TaskField scheduled from WhatsApp');
    return { taskFieldId };
  } catch (err) {
    await client.query('ROLLBACK');
    log.error({ err, taskId: input.taskId }, 'scheduleTaskField failed — rolled back');
    throw err;
  } finally {
    client.release();
  }
}
