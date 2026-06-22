// ── Enums ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE';

export type TaskType =
  | 'step1'       // פתיחת פנייה
  | 'step2'       // התאמת הפתרון
  | 'step3'       // שיחת מכירה
  | 'stepQuote'   // הצעת מחיר — display-only (currentStage 99), bot cannot set this
  | 'step4'       // פולואפ
  | 'step5'       // תיאום
  | 'step6'       // ביצוע
  | 'step7';      // דוח

/**
 * Types the bot is allowed to assign. The user describes the step in plain
 * Hebrew and the AI / normalizeTaskType() maps it to one of these enum values.
 * Order follows the CRM's business flow (stepQuote = הצעת מחיר sits in slot 4).
 */
export const BOT_ASSIGNABLE_TASK_TYPES: TaskType[] = [
  'step1', 'step2', 'step3', 'stepQuote', 'step4', 'step5', 'step6', 'step7',
];

/**
 * Canonical Hebrew label for each assignable task type, in business order.
 * Used to build the AI prompt and to render types back to the user.
 */
export const TASK_TYPE_LABELS: Record<string, string> = {
  step1: 'פתיחת פנייה',
  step2: 'התאמת הפתרון',
  step3: 'שיחת מכירה',
  stepQuote: 'הצעת מחיר',
  step4: 'פולואפ',
  step5: 'תיאום',
  step6: 'ביצוע',
  step7: 'דוח',
};

export type TaskPriority = 'URGENT' | string; // extend once full enum is confirmed

export type UserRole =
  | 'BILLING'
  | 'TECHNICIAN'
  | 'SALES'
  | 'EXPERT'
  | 'MANAGER'
  | 'ADMIN';

export type WhatsAppActionState =
  | 'PENDING_EMPLOYEE_CONFIRM'
  | 'PENDING_MANAGER_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'CANCELLED';

export type ActionType =
  | 'CREATE_TASK'
  | 'EDIT_FIELD'
  | 'EDIT_DUEDATE'
  | 'REASSIGN'
  | 'EDIT_LINK';

// ── Existing CRM tables ───────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  phone: string;
  role: UserRole;
  status: string;
  canViewAllRecords: boolean;
  canManageUsers: boolean;
  canManagePermissions: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  dueDate: Date | null;
  priority: TaskPriority | null;
  status: TaskStatus;
  type: TaskType;
  createdAt: Date;
  updatedAt: Date;
  ownerId: string;
  customerId: string | null;
  leadId: string | null;
  projectId: string | null;
}

export interface Customer {
  id: string;
  name: string;
  type: string | null;
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  status: string | null;
  services: string | null;
  notes: string | null;
}

export interface Lead {
  id: string;
  fullName: string;
  phone: string | null;
  service: string | null;
  status: string | null;
  city: string | null;
}

export interface Project {
  id: string;
  projectNumber: string | null;
  name: string;
  status: string | null;
  city: string | null;
  address: string | null;
  dueDate: Date | null;
}

// ── New bot tables ────────────────────────────────────────────────────────────

// Mirrors the "WhatsappPendingAction" table columns (camelCase, matching the CRM
// convention) so SELECT * / RETURNING * rows map directly with no translation layer.
export interface PendingAction {
  id: string;
  requesterUserId: string;
  actionType: ActionType;
  targetTaskId: string | null;
  payload: Record<string, unknown>;
  state: WhatsAppActionState;
  approverUserId: string | null;
  expiresAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLogEntry {
  id?: string;
  userId: string | null;
  whatsappNumber: string;
  originalMessage: string | null;
  transcribedMessage: string | null;
  detectedIntent: string | null;
  detectedAction: string | null;
  confidence: number | null;
  targetTaskId: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  confirmationStatus: 'CONFIRMED' | 'DECLINED' | 'NONE' | null;
  approvalStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  approverUserId: string | null;
  managerNotified: boolean;
  executionStatus: 'SUCCESS' | 'FAILED' | 'SKIPPED' | null;
  errorMessage: string | null;
  pendingActionId: string | null;
}

// ── Resolved user context (passed to every handler) ──────────────────────────

export interface ResolvedUser {
  id: string;
  name: string;
  phone: string;
  role: UserRole;
  isElevated: boolean; // MANAGER or ADMIN
  canViewAllRecords: boolean;
  canManageUsers: boolean;
  canManagePermissions: boolean;
}

// ── AI output contract (§11) ──────────────────────────────────────────────────

export type AIIntent =
  | 'list_tasks'      // show the caller's tasks (optionally filtered)
  | 'get_task'        // show one task's details
  | 'create_task'     // create a new task
  | 'edit_field'      // edit title/description/priority/type
  | 'edit_duedate'    // change dueDate (→ manager approval)
  | 'reassign_task'   // change ownerId (ADMIN only)
  | 'relink_task'     // change customerId/leadId/projectId (ADMIN only)
  | 'confirm_pending_action'   // user approves their latest pending action ("כן"/"אשר")
  | 'decline_pending_action'   // user cancels their latest pending action ("לא"/"בטל")
  | 'team_workload'   // manager/admin asks who is loaded / overloaded
  | 'help'            // user asked what the bot can do
  | 'unknown';        // could not determine intent

export interface AIIntentResult {
  intent: AIIntent;
  confidence: number;                  // 0..1
  task_reference: string | null;       // free-text describing which task (for edit/get)
  field: string | null;                // field name for edit_* intents
  new_value: unknown;                  // new value for edit_* intents
  params: Record<string, unknown>;     // intent-specific extras (title, type, dueDate, priority, filter, ownerId, …)
  missing_fields: string[];            // required params the model couldn't fill
  clarification: string | null;        // a Hebrew question to ask when something is missing/ambiguous
  requires_confirmation: boolean;
  requires_manager_approval: boolean;
}

// ── Conversation history ───────────────────────────────────────────────────────

/** One stored turn of the short rolling chat window (for resolving references). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ── Task list filter ──────────────────────────────────────────────────────────

export type TaskFilter =
  | 'today'
  | 'this_week'
  | 'open'
  | 'next_deadline'
  | 'overdue'    // not-done tasks past their dueDate
  | 'unlinked'   // tasks with no customer / lead / project
  | 'all';

/** A task row enriched with the human-readable names of its related records. */
export interface TaskListItem extends Task {
  ownerName: string;
  customerName: string | null;
  leadName: string | null;
  projectName: string | null;
}

/** One row of the team-workload view (open-task load per employee). */
export interface WorkloadRow {
  ownerId: string;
  ownerName: string;
  openCount: number;
  overdueCount: number;
  dueTodayCount: number;
}
