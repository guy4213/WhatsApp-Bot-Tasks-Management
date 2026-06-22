import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveUserByPhone } from '../auth/userResolver';
import { getFieldEditPermission, canCreateForOthers, canEditTask } from '../auth/permissions';
import {
  listTasks,
  getTaskById,
  createTask,
  updateTaskField,
  updateAdminField,
  getAllowedTaskTypes,
  getAllowedPriorities,
  normalizeTaskType,
  FKError,
} from '../services/tasks';

const ADMIN_FIELDS = new Set(['ownerId', 'customerId', 'leadId', 'projectId']);

import {
  createPendingAction,
  transitionState,
  getPendingAction,
  getManagersForBroadcast,
} from '../services/pendingActions';
import { updateDueDate } from '../services/tasks';
import { writeAuditLog } from '../utils/auditLog';
import { sendTextMessage, sendButtonMessage } from '../whatsapp/sender';
import { notify } from '../whatsapp/templates';
import { pool } from '../db/connection';
import { userName, customerName, leadName, projectName } from '../utils/displayNames';
import { TASK_TYPE_LABELS } from '../types';
import type { TaskFilter } from '../types';

// Hebrew labels for field keys, shown in confirmation messages instead of the
// raw column name (e.g. "ownerId").
const FIELD_LABELS: Record<string, string> = {
  ownerId: 'אחראי/בעלים',
  customerId: 'לקוח',
  leadId: 'ליד',
  projectId: 'פרויקט',
  title: 'כותרת',
  description: 'תיאור',
  priority: 'עדיפות',
  type: 'סוג',
  dueDate: 'מועד יעד',
};

// For id-valued fields, resolve the id to a human display name.
const FIELD_NAME_RESOLVERS: Record<string, (id: string) => Promise<string>> = {
  ownerId: userName,
  customerId: customerName,
  leadId: leadName,
  projectId: projectName,
};

// ── Internal auth ─────────────────────────────────────────────────────────────
// Task routes are called internally from the webhook handler via callInternal.
// We require a shared secret header so they cannot be reached directly from the
// public internet (the server listens on 0.0.0.0 but these routes need the secret).

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? '';

function verifyInternalSecret(provided: string): boolean {
  if (!INTERNAL_SECRET) return true; // Not configured — allow in dev
  if (!provided || provided.length !== INTERNAL_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_SECRET));
}

// ── dueDate validation ────────────────────────────────────────────────────────

function isValidDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCallerPhone(request: { headers: Record<string, string | string[] | undefined> }): string {
  return (request.headers['x-wa-from'] as string) ?? '';
}

/** Record a denied/unauthorized attempt in the audit log (best-effort, never throws). */
function auditDenied(
  userId: string | null,
  phone: string,
  action: string,
  taskId: string | null,
  reason: string,
): Promise<void> {
  return writeAuditLog({
    userId, whatsappNumber: phone,
    originalMessage: null, transcribedMessage: null,
    detectedIntent: action.toLowerCase(), detectedAction: action, confidence: null,
    targetTaskId: taskId, oldValues: null, newValues: null,
    confirmationStatus: null, approvalStatus: null, approverUserId: null,
    managerNotified: false, executionStatus: 'SKIPPED',
    errorMessage: `Unauthorized: ${reason}`, pendingActionId: null,
  });
}

// ── Route registration ────────────────────────────────────────────────────────

export async function taskRoutes(app: FastifyInstance) {

  // Reject any request that doesn't carry the internal secret
  app.addHook('preHandler', async (req, reply) => {
    const provided = (req.headers['x-internal-secret'] as string) ?? '';
    if (!verifyInternalSecret(provided)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // GET /tasks — list caller's tasks
  app.get<{ Querystring: { filter?: string; limit?: string; offset?: string } }>(
    '/tasks',
    async (req, reply) => {
      const phone = getCallerPhone(req);
      const auth = await resolveUserByPhone(phone);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });

      const filter = (req.query.filter ?? 'all') as TaskFilter;
      const limit  = Math.min(parseInt(req.query.limit  ?? '100', 10), 500);
      const offset = Math.max(parseInt(req.query.offset ?? '0',   10), 0);

      const { tasks, truncated } = await listTasks(auth.user, { filter, limit, offset });
      return reply.send({ tasks, truncated, limit, offset });
    },
  );

  // GET /tasks/:id — task detail with joined entities
  app.get<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const phone = getCallerPhone(req);
    const auth = await resolveUserByPhone(phone);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    const task = await getTaskById(auth.user, req.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found or access denied' });

    return reply.send({ task });
  });

  // POST /tasks — create a task
  const createSchema = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    dueDate: z.string().optional(),
    priority: z.string().optional(),
    type: z.string().min(1),
    ownerId: z.string().optional(),
    customerId: z.string().optional(),
    leadId: z.string().optional(),
    projectId: z.string().optional(),
  });

  app.post('/tasks', async (req, reply) => {
    const phone = getCallerPhone(req);
    const auth = await resolveUserByPhone(phone);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
    }

    const input = parsed.data;

    // Validate dueDate if provided
    if (input.dueDate && !isValidDate(input.dueDate)) {
      return reply.code(400).send({ error: 'Invalid dueDate — must be a valid ISO date string' });
    }

    // Resolve the owner: default to the caller; if an ownerId/name was supplied,
    // resolve it (the AI may pass a name like "גיא פרנסס", not a real id).
    let targetOwnerId = auth.user.id;
    if (input.ownerId) {
      const resolved = await resolveUserIdByReference(input.ownerId);
      if (!resolved) {
        return reply.code(400).send({ error: `המשתמש "${input.ownerId}" לא נמצא.` });
      }
      targetOwnerId = resolved;
    }
    if (targetOwnerId !== auth.user.id && !canCreateForOthers(auth.user)) {
      await auditDenied(auth.user.id, phone, 'CREATE_TASK', null, 'create task for another user');
      return reply.code(403).send({ error: 'Not authorized to create tasks for other users' });
    }

    // Admin-only link fields (customerId, leadId, projectId) at creation time
    const setsLinkFields = (['customerId', 'leadId', 'projectId'] as const).some(
      (f) => input[f] !== undefined,
    );
    if (setsLinkFields && !auth.user.isElevated) {
      await auditDenied(auth.user.id, phone, 'CREATE_TASK', null, 'set link fields (manager/admin only)');
      return reply.code(403).send({ error: 'Only managers or admins can set customerId, leadId, or projectId' });
    }

    // Normalize + validate type (accepts enum value OR a plain-Hebrew description)
    const normalizedType = normalizeTaskType(input.type);
    if (!normalizedType) {
      return reply.code(400).send({ error: `לא זיהיתי את סוג המשימה "${input.type}". סוגים אפשריים: פתיחת פנייה, התאמת הפתרון, שיחת מכירה, הצעת מחיר, פולואפ, תיאום, ביצוע, דוח.` });
    }
    input.type = normalizedType;

    // Validate priority against the live TaskPriority enum
    if (input.priority) {
      const allowedPriorities = await getAllowedPriorities();
      if (!allowedPriorities.includes(input.priority)) {
        return reply.code(400).send({ error: `Invalid priority. Allowed: ${allowedPriorities.join(', ')}` });
      }
    }

    const pending = await createPendingAction({
      requesterUserId: auth.user.id,
      actionType: 'CREATE_TASK',
      payload: { ...input, ownerId: targetOwnerId },
    });

    const ownerLabel = targetOwnerId === auth.user.id ? 'עצמך' : await userName(targetOwnerId);
    const summary =
      `אנא אשר יצירת משימה:\n` +
      `כותרת: ${input.title}\n` +
      `סוג: ${TASK_TYPE_LABELS[input.type] ?? input.type}\n` +
      `עבור: ${ownerLabel}\n` +
      `השב "כן" לאישור או "לא" לביטול.`;

    await sendButtonMessage({
      to: auth.user.phone,
      body: summary,
      buttons: [
        { id: `כן ${pending.id}`, title: 'כן' },
        { id: `לא ${pending.id}`, title: 'לא' },
      ],
    });
    return reply.code(202).send({ message: 'Confirmation sent', pendingActionId: pending.id });
  });

  // PATCH /tasks/:id/field — edit a single field
  const editSchema = z.object({
    field: z.string(),
    value: z.unknown(),
  });

  app.patch<{ Params: { id: string } }>('/tasks/:id/field', async (req, reply) => {
    const phone = getCallerPhone(req);
    const auth = await resolveUserByPhone(phone);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });

    const { field } = parsed.data;
    let value = parsed.data.value;
    const permission = getFieldEditPermission(auth.user, field);

    if (permission === 'READONLY' || permission === 'FORBIDDEN') {
      await auditDenied(auth.user.id, phone, 'EDIT_FIELD', req.params.id, `field "${field}" not editable (${permission})`);
      return reply.code(403).send({ error: `Field "${field}" cannot be edited` });
    }
    if (permission === 'ELEVATED_ONLY' && !auth.user.isElevated) {
      await auditDenied(auth.user.id, phone, 'EDIT_FIELD', req.params.id, `field "${field}" is manager/admin only`);
      return reply.code(403).send({ error: 'Manager or Admin role required' });
    }

    // Validate dueDate value
    if (field === 'dueDate' && !isValidDate(value)) {
      return reply.code(400).send({ error: 'Invalid dueDate — must be a valid ISO date string' });
    }

    // Validate priority against the live TaskPriority enum
    if (field === 'priority') {
      const allowedPriorities = await getAllowedPriorities();
      if (typeof value !== 'string' || !allowedPriorities.includes(value)) {
        return reply.code(400).send({ error: `Invalid priority. Allowed: ${allowedPriorities.join(', ')}` });
      }
    }

    // Normalize + validate type (accepts enum value OR a plain-Hebrew description)
    if (field === 'type') {
      const normalizedType = normalizeTaskType(value);
      if (!normalizedType) {
        return reply.code(400).send({ error: `לא זיהיתי את סוג המשימה. סוגים אפשריים: פתיחת פנייה, התאמת הפתרון, שיחת מכירה, הצעת מחיר, פולואפ, תיאום, ביצוע, דוח.` });
      }
      value = normalizedType;
    }

    const task = await getTaskById(auth.user, req.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found or access denied' });

    // Ownership gate: a regular employee may edit ONLY their own tasks. The
    // canViewAllRecords flag (consulted by getTaskById) grants read visibility
    // but not edit rights, so re-check write authorization explicitly here —
    // only the owner or a MANAGER/ADMIN may proceed.
    if (!canEditTask(auth.user, task)) {
      await auditDenied(auth.user.id, phone, 'EDIT_FIELD', req.params.id, 'edit task owned by another user');
      return reply.code(403).send({ error: 'אפשר לערוך רק את המשימות שלך.' });
    }

    if (permission === 'REQUIRES_MANAGER_APPROVAL') {
      const pending = await createPendingAction({
        requesterUserId: auth.user.id,
        actionType: 'EDIT_DUEDATE',
        targetTaskId: req.params.id,
        payload: { field, old_value: task.dueDate, new_value: value, taskTitle: task.title },
      });

      await sendButtonMessage({
        to: auth.user.phone,
        body:
          `אנא אשר בקשת שינוי מועד למשימה "${task.title}":\n` +
          `מועד נוכחי: ${task.dueDate ?? 'לא הוגדר'}\n` +
          `מועד חדש: ${value}\n` +
          // Elevated requesters self-approve (no manager step), so don't promise one.
          (auth.user.isElevated
            ? `השב "כן" לאישור או "לא" לביטול.`
            : `השב "כן" לאישור (הבקשה תועבר למנהל) או "לא" לביטול.`),
        buttons: [
          { id: `כן ${pending.id}`, title: 'כן' },
          { id: `לא ${pending.id}`, title: 'לא' },
        ],
      });

      await writeAuditLog({
        userId: auth.user.id, whatsappNumber: phone,
        originalMessage: null, transcribedMessage: null,
        detectedIntent: 'edit_task_field', detectedAction: 'EDIT_DUEDATE',
        confidence: null, targetTaskId: req.params.id,
        oldValues: { dueDate: task.dueDate }, newValues: { dueDate: value },
        confirmationStatus: 'NONE', approvalStatus: 'PENDING',
        approverUserId: null, managerNotified: false,
        executionStatus: 'SKIPPED', errorMessage: null, pendingActionId: pending.id,
      });

      return reply.code(202).send({ message: 'Confirmation sent to employee', pendingActionId: pending.id });
    }

    // Free-edit or admin field
    const pending = await createPendingAction({
      requesterUserId: auth.user.id,
      actionType: 'EDIT_FIELD',
      targetTaskId: req.params.id,
      payload: {
        field,
        old_value: (task as unknown as Record<string, unknown>)[field],
        new_value: value,
        taskTitle: task.title,
      },
    });

    // Build a human-readable value: id fields → name, type → label, else raw.
    let displayValue: unknown;
    if (field === 'type') {
      displayValue = TASK_TYPE_LABELS[String(value)] ?? value;
    } else if (FIELD_NAME_RESOLVERS[field] && typeof value === 'string') {
      displayValue = await FIELD_NAME_RESOLVERS[field](value);
    } else {
      displayValue = value;
    }
    const fieldLabel = FIELD_LABELS[field] ?? field;
    await sendButtonMessage({
      to: auth.user.phone,
      body: `אנא אשר עדכון שדה "${fieldLabel}" ל-"${displayValue}" במשימה "${task.title}".\nהשב "כן" לאישור או "לא" לביטול.`,
      buttons: [
        { id: `כן ${pending.id}`, title: 'כן' },
        { id: `לא ${pending.id}`, title: 'לא' },
      ],
    });

    return reply.code(202).send({ message: 'Confirmation sent', pendingActionId: pending.id });
  });

  // POST /tasks/confirm — employee confirms or cancels a pending action
  const confirmSchema = z.object({
    pendingActionId: z.string().uuid(),
    decision: z.enum(['CONFIRM', 'CANCEL']),
  });

  app.post('/tasks/confirm', async (req, reply) => {
    const phone = getCallerPhone(req);
    const auth = await resolveUserByPhone(phone);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });

    const { pendingActionId, decision } = parsed.data;
    const action = await getPendingAction(pendingActionId);

    if (!action) return reply.code(404).send({ error: 'Pending action not found' });
    if (action.requesterUserId !== auth.user.id) return reply.code(403).send({ error: 'Not your request' });
    if (action.state !== 'PENDING_EMPLOYEE_CONFIRM') {
      return reply.code(409).send({ error: `Cannot confirm — current state: ${action.state}` });
    }

    if (decision === 'CANCEL') {
      await transitionState(pendingActionId, 'CANCELLED', undefined, 'PENDING_EMPLOYEE_CONFIRM');
      await writeAuditLog({
        userId: auth.user.id, whatsappNumber: phone,
        originalMessage: null, transcribedMessage: null,
        detectedIntent: action.actionType.toLowerCase(), detectedAction: action.actionType,
        confidence: null, targetTaskId: action.targetTaskId,
        oldValues: null, newValues: null,
        confirmationStatus: 'DECLINED', approvalStatus: 'NOT_REQUIRED',
        approverUserId: null, managerNotified: false,
        executionStatus: 'SKIPPED', errorMessage: null, pendingActionId,
      });
      return reply.send({ message: 'Action cancelled' });
    }

    if (action.actionType === 'CREATE_TASK') {
      let task;
      try {
        const payload = action.payload as unknown as Parameters<typeof createTask>[0];
        task = await createTask(payload);
      } catch (err) {
        if (err instanceof FKError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      await transitionState(pendingActionId, 'EXECUTED', undefined, 'PENDING_EMPLOYEE_CONFIRM');
      await writeAuditLog({
        userId: auth.user.id, whatsappNumber: phone,
        originalMessage: null, transcribedMessage: null,
        detectedIntent: 'create_task', detectedAction: 'CREATE_TASK',
        confidence: null, targetTaskId: task.id,
        oldValues: null, newValues: action.payload,
        confirmationStatus: 'CONFIRMED', approvalStatus: 'NOT_REQUIRED',
        approverUserId: null, managerNotified: false,
        executionStatus: 'SUCCESS', errorMessage: null, pendingActionId,
      });
      await sendTextMessage({ to: auth.user.phone, text: `משימה "${task.title}" נוצרה בהצלחה!` });
      return reply.send({ message: 'Task created', task });
    }

    if (action.actionType === 'EDIT_FIELD') {
      const { field, new_value } = action.payload as { field: string; new_value: unknown };
      let task;
      try {
        task = ADMIN_FIELDS.has(field)
          ? await updateAdminField(action.targetTaskId!, field, new_value)
          : await updateTaskField(action.targetTaskId!, field, new_value);
      } catch (err) {
        if (err instanceof FKError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      await transitionState(pendingActionId, 'EXECUTED', undefined, 'PENDING_EMPLOYEE_CONFIRM');
      await writeAuditLog({
        userId: auth.user.id, whatsappNumber: phone,
        originalMessage: null, transcribedMessage: null,
        detectedIntent: 'edit_task_field', detectedAction: 'EDIT_FIELD',
        confidence: null, targetTaskId: action.targetTaskId,
        oldValues: { [field]: (action.payload as Record<string, unknown>).old_value },
        newValues: { [field]: new_value },
        confirmationStatus: 'CONFIRMED', approvalStatus: 'NOT_REQUIRED',
        approverUserId: null, managerNotified: false,
        executionStatus: 'SUCCESS', errorMessage: null, pendingActionId,
      });
      await sendTextMessage({ to: auth.user.phone, text: `המשימה עודכנה בהצלחה!` });
      return reply.send({ message: 'Task updated', task });
    }

    if (action.actionType === 'EDIT_DUEDATE') {
      const { new_value, taskTitle } = action.payload as { new_value: string; taskTitle: string };

      // Self-approval: the confirmer IS the requester (enforced above). A MANAGER/
      // ADMIN has no one above them to approve a dueDate change, so execute it
      // immediately instead of broadcasting an approval request to managers.
      if (auth.user.isElevated) {
        try {
          await transitionState(pendingActionId, 'EXECUTED', auth.user.id, 'PENDING_EMPLOYEE_CONFIRM');
        } catch {
          return reply.code(409).send({ error: 'Request already confirmed' });
        }
        const task = await updateDueDate(action.targetTaskId!, new_value);
        await writeAuditLog({
          userId: auth.user.id, whatsappNumber: phone,
          originalMessage: null, transcribedMessage: null,
          detectedIntent: 'edit_task_field', detectedAction: 'EDIT_DUEDATE',
          confidence: null, targetTaskId: action.targetTaskId,
          oldValues: { dueDate: (action.payload as Record<string, unknown>).old_value },
          newValues: { dueDate: new_value },
          confirmationStatus: 'CONFIRMED', approvalStatus: 'APPROVED',
          approverUserId: auth.user.id, managerNotified: false,
          executionStatus: 'SUCCESS', errorMessage: null, pendingActionId,
        });
        await sendTextMessage({ to: auth.user.phone, text: `מועד המשימה "${task.title}" עודכן ל-${new_value}.` });
        return reply.send({ message: 'Due date updated (self-approved)', task });
      }

      try {
        await transitionState(pendingActionId, 'PENDING_MANAGER_APPROVAL', undefined, 'PENDING_EMPLOYEE_CONFIRM');
      } catch {
        return reply.code(409).send({ error: 'Request already confirmed' });
      }

      const managers = await getManagersForBroadcast();

      const managerMsg =
        `${auth.user.name} מבקש לשנות את מועד המשימה "${taskTitle}" ל-${new_value}.\n` +
        `השב "אשר ${pendingActionId}" לאישור או "דחה ${pendingActionId}" לדחייה.`;

      // Managers are usually out-of-window → template (falls back to free-form when disabled)
      await Promise.allSettled(managers.map((m) =>
        notify({
          to: m.phone,
          key: 'DUEDATE_APPROVAL_REQUEST',
          bodyParams: [auth.user.name, taskTitle, new_value, pendingActionId],
          fallbackText: managerMsg,
        }),
      ));

      await sendTextMessage({
        to: auth.user.phone,
        text: `בקשתך לשינוי מועד ל-${new_value} הועברה לאישור מנהל. תקבל עדכון בהמשך.`,
      });

      await writeAuditLog({
        userId: auth.user.id, whatsappNumber: phone,
        originalMessage: null, transcribedMessage: null,
        detectedIntent: 'edit_task_field', detectedAction: 'EDIT_DUEDATE',
        confidence: null, targetTaskId: action.targetTaskId,
        oldValues: { dueDate: (action.payload as Record<string, unknown>).old_value },
        newValues: { dueDate: new_value },
        confirmationStatus: 'CONFIRMED', approvalStatus: 'PENDING',
        approverUserId: null, managerNotified: managers.length > 0,
        executionStatus: 'SKIPPED', errorMessage: null, pendingActionId,
      });

      return reply.send({ message: 'Sent for manager approval' });
    }

    return reply.code(400).send({ error: `Unhandled action type: ${action.actionType}` });
  });

  // POST /tasks/approve — manager approves or rejects a dueDate change
  const approveSchema = z.object({
    pendingActionId: z.string().uuid(),
    decision: z.enum(['APPROVE', 'REJECT']),
  });

  app.post('/tasks/approve', async (req, reply) => {
    const phone = getCallerPhone(req);
    const auth = await resolveUserByPhone(phone);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    if (!auth.user.isElevated) {
      await auditDenied(auth.user.id, phone, 'EDIT_DUEDATE', null, 'approve dueDate change (manager/admin only)');
      return reply.code(403).send({ error: 'Manager or Admin role required' });
    }

    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });

    const { pendingActionId, decision } = parsed.data;
    const action = await getPendingAction(pendingActionId);

    if (!action) return reply.code(404).send({ error: 'Pending action not found' });
    if (action.state !== 'PENDING_MANAGER_APPROVAL') {
      return reply.code(409).send({ error: `Cannot resolve — current state: ${action.state}` });
    }

    if (decision === 'REJECT') {
      try {
        await transitionState(pendingActionId, 'REJECTED', auth.user.id, 'PENDING_MANAGER_APPROVAL');
      } catch {
        return reply.code(409).send({ error: 'Another manager already resolved this request' });
      }
      const rejTitle = String((action.payload as Record<string, unknown>).taskTitle ?? '');
      const requester = await getUserById(action.requesterUserId);
      if (requester) {
        await notify({
          to: requester.phone,
          key: 'DUEDATE_REJECTED',
          bodyParams: [rejTitle, auth.user.name],
          fallbackText: `בקשתך לשינוי מועד המשימה נדחתה על ידי ${auth.user.name}.`,
        });
      }
      // Confirm back to the approving manager, and tell the other managers it's handled.
      await sendTextMessage({ to: phone, text: `דחית את בקשת שינוי המועד של המשימה "${rejTitle}". העובד עודכן.` });
      await notifyOtherManagers(auth.user.id, auth.user.name, rejTitle, 'נדחתה');
      return reply.send({ message: 'Request rejected' });
    }

    const { new_value } = action.payload as { new_value: string };
    try {
      await transitionState(pendingActionId, 'EXECUTED', auth.user.id, 'PENDING_MANAGER_APPROVAL');
    } catch {
      return reply.code(409).send({ error: 'Another manager already resolved this request' });
    }
    const task = await updateDueDate(action.targetTaskId!, new_value);

    const requester = await getUserById(action.requesterUserId);
    if (requester) {
      await notify({
        to: requester.phone,
        key: 'DUEDATE_APPROVED',
        bodyParams: [task.title, new_value, auth.user.name],
        fallbackText: `מועד המשימה "${task.title}" שונה ל-${new_value} — אושר על ידי ${auth.user.name}.`,
      });
    }
    // Confirm back to the approving manager, and tell the other managers it's handled.
    await sendTextMessage({ to: phone, text: `אושר. מועד המשימה "${task.title}" עודכן ל-${new_value}. העובד עודכן.` });
    await notifyOtherManagers(auth.user.id, auth.user.name, task.title, 'אושרה');

    await writeAuditLog({
      userId: action.requesterUserId, whatsappNumber: phone,
      originalMessage: null, transcribedMessage: null,
      detectedIntent: 'edit_task_field', detectedAction: 'EDIT_DUEDATE',
      confidence: null, targetTaskId: action.targetTaskId,
      oldValues: { dueDate: (action.payload as Record<string, unknown>).old_value },
      newValues: { dueDate: new_value },
      confirmationStatus: 'CONFIRMED', approvalStatus: 'APPROVED',
      approverUserId: auth.user.id, managerNotified: true,
      executionStatus: 'SUCCESS', errorMessage: null, pendingActionId,
    });

    return reply.send({ message: 'Approved and executed', task });
  });
}

// ── Internal helper ───────────────────────────────────────────────────────────

async function getUserById(userId: string): Promise<{ phone: string } | null> {
  const r = await pool.query<{ phone: string }>(`SELECT phone FROM "User" WHERE id = $1`, [userId]);
  return r.rowCount === 0 ? null : r.rows[0];
}

/**
 * After one manager/admin resolves a dueDate approval request, tell the OTHER
 * managers/admins it was already handled (by whom + outcome), so they don't act
 * on a now-stale request. The acting manager is excluded.
 */
async function notifyOtherManagers(
  actedByUserId: string,
  actedByName: string,
  taskTitle: string,
  outcome: 'אושרה' | 'נדחתה',
): Promise<void> {
  const others = (await getManagersForBroadcast()).filter((m) => m.id !== actedByUserId);
  if (others.length === 0) return;
  const text =
    `בקשת שינוי המועד של המשימה "${taskTitle}" כבר ${outcome} על ידי ${actedByName}. אין צורך בפעולה נוספת.`;
  await Promise.allSettled(others.map((m) => sendTextMessage({ to: m.phone, text })));
}

/**
 * Resolve an owner reference (a real User.id, or a full name the AI extracted like
 * "גיא פרנסס") to a user id. Returns null if no user matches.
 */
async function resolveUserIdByReference(ref: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM "User" WHERE id = $1 OR lower(name) = lower($1) LIMIT 1`,
    [ref],
  );
  return r.rowCount === 0 ? null : r.rows[0].id;
}
