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
  | 'get_task'              // show one task's details
  | 'set_field_status'      // worker advances an inspection: departed/arrived/finished/waiting/problem
  | 'report_problem'        // worker reports a problem on an inspection (optionally with problemType)
  | 'report_missing_info'   // worker reports info missing for the final report
  | 'list_my_inspections'   // worker (or manager) asks for their own inspections in a date scope
  | 'help'                  // user asked what the bot can do
  | 'unknown'               // could not determine intent
  // D2-T11: schedule a new TaskField
  | 'schedule_task_field'       // schedule a new TaskField for an existing Task (office/manager)
  // D2-T12/T13/T14: correction intents
  | 'correct_task_field_site'   // correct site metadata on a TaskField (address/city/contact)
  | 'reassign_task'             // reassign a Task to another worker (MANAGER/ADMIN only)
  | 'correct_inspection_type'   // correct the inspection type on a TaskField (with confirmation)
  // D3-T6: Sasha lead-assignment via WhatsApp.
  | 'assign_lead'               // assign an unassigned IncomingLead to a worker
  // Manager-facing intents (role-aware).
  | 'open_manager_menu'          // show the manager menu
  | 'management_snapshot'        // item 1: org-wide snapshot
  | 'list_today_field_inspections' // item 2: today's field inspections (org-wide)
  | 'list_open_exceptions'       // item 3: exceptions / deviations list
  | 'list_pending_leads'         // item 4: leads awaiting assignment
  | 'workers_day_overview'       // item 5: all-workers or specific-worker day overview
  | 'search_task'                // item 6: search by customer / worker / product
  // D5-T10 Phase 2: new worker free-text intents
  | 'day_summary_query'          // worker asks for their day summary via free text
  | 'missing_equipment_free'     // worker reports missing equipment before going out (general, not task-scoped)
  // PROV-T5 (TASKS §4.20): manager enables OwnTracks auto-provisioning for a worker.
  | 'enable_worker_location_tracking'
  // CAL-WA: Outlook calendar over WhatsApp text (parity with the voice tools).
  | 'calendar_list'      // read upcoming calendar events
  | 'calendar_create'    // create a new calendar event
  | 'calendar_update'    // update an existing event (subject/time/location)
  | 'calendar_delete';   // delete an event (confirm before deleting)

// v2 inspector-side sub-enums (SPEC_FIELD_V2 §4, §7, §9). These are the SUBSET
// of `fieldStatus` transitions a worker can trigger via free text — the office-
// triggered ones (ASSIGNED / CONFIRMED / DECLINED / NEEDS_MORE_INFO / CANCELED)
// are NOT valid `set_field_status.transition` values.
export type FieldStatusTransition =
  | 'CONFIRM'             // D5-T18: worker confirms assignment via free text
  | 'DEPARTED'
  | 'ARRIVED'
  | 'FINISHED'
  | 'WAITING_FOR_INFO'
  | 'HAS_PROBLEM';

export type FieldProblemType =
  | 'CUSTOMER_NOT_ANSWERING'
  | 'NO_ACCESS'
  | 'CUSTOMER_NOT_PRESENT'
  | 'MISSING_EQUIPMENT'
  | 'CANNOT_PERFORM'
  | 'PROFESSIONAL_ISSUE'
  | 'OTHER';

export interface AIIntentResult {
  intent: AIIntent;
  confidence: number;                  // 0..1
  task_reference: string | null;       // free-text describing which task (for edit/get) OR inspection ref for v2 field intents
  field: string | null;                // field name for edit_* intents
  new_value: unknown;                  // new value for edit_* intents
  params: Record<string, unknown>;     // intent-specific extras (title, type, dueDate, priority, filter, ownerId, note, …)
  missing_fields: string[];            // required params the model couldn't fill
  clarification: string | null;        // a Hebrew question to ask when something is missing/ambiguous
  requires_confirmation: boolean;
  requires_manager_approval: boolean;
  // v2 field-inspector intent extras — populated only for set_field_status /
  // report_problem. Optional & top-level (mirrors the shape of `field` /
  // `new_value`), so the LLM tool-call layer enforces the enum via JSON schema
  // and Zod rejects out-of-set values. `note` (free text) rides in params.note.
  transition?: FieldStatusTransition | null;
  problem_type?: FieldProblemType | null;
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
  | 'today_overdue' // due today OR overdue carry-over, excluding DONE (digest "today" view)
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

