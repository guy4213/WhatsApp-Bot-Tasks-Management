import { pool } from '../db/connection';
import type { AIIntentResult, FieldProblemType, FieldStatusTransition } from '../types';

const TTL_MINUTES = parseInt(process.env.CONVERSATION_CONTEXT_TTL_MINUTES ?? '10', 10);

// What the bot is waiting for from the user's next message.
export type AwaitingKind =
  | 'intent_confirm' | 'missing_field' | 'task_disambig' | 'read_confirm'
  | 'create_date' | 'owner_disambig' | 'link_disambig'
  // Role-based numbered menu + digest settings flow (V1). These states carry NO
  // AI intent (hence `intent` is optional below).
  | 'menu' | 'digest_settings' | 'digest_set_time'
  // v2 inspector flows (D2-T5 + D2-T6 + D2-T7 + D2-T8). All carry no AI
  // intent — they capture a single free-text reply / menu number and dispatch
  // the write. Disambig states (`*_disambig`) resolve via
  // `resolveOpenTaskFieldByHint` in `services/inspections.ts`.
  | 'missing_info_note'
  | 'missing_info_disambig'
  | 'problem_type_choice'
  | 'problem_type_note'
  | 'problem_disambig'
  // D2-T5: on-demand DEPARTED / ARRIVED / FINISHED transitions.
  | 'status_choice'
  | 'status_disambig'
  // D2-T6: 4-option follow-up after FINISHED, and its "field notes" branch.
  | 'finished_followup'
  | 'finished_notes'
  // D2-T10: day-summary 4-option follow-up + option-3 free-text callback note.
  | 'day_summary_choice'
  | 'callback_customer_note'
  // D2-T9: worker tapped "חסר לי ציוד" on the morning equipment reminder →
  // next inbound text is the free-text description of what is missing.
  | 'equipment_missing_note'
  // D2-T3: worker tapped a §6 inspection-card reply button → next inbound text
  // completes the flow. `_reason` follows the DECLINE button (short reason);
  // `_note` follows the NEED_INFO button (free-text follow-up).
  | 'inspection_decline_reason'
  | 'inspection_need_info_note'
  // D2-T12: correct site metadata on a TaskField (address/city/contact).
  | 'correct_site_pick_task'    // manager picks which Task
  | 'correct_site_pick_field'   // manager picks which TaskField (when >1 per Task)
  | 'correct_site_await_value'  // waiting for the corrected value
  | 'correct_site_confirm'      // waiting for worker confirmation before writing
  // D2-T13: reassign a Task to another worker (MANAGER/ADMIN only).
  | 'reassign_pick_task'        // manager types a task reference
  | 'reassign_pick_worker'      // manager picks new worker from a numbered list
  | 'reassign_confirm'          // confirmation before writing (in-progress edge case)
  // D2-T14: correct inspection type on a TaskField.
  | 'correct_type_pick_task'    // pick which Task (by reference)
  | 'correct_type_await_search' // awaiting a search term to narrow the type list
  | 'correct_type_pick_from_list' // worker picks from a numbered list of matching types
  | 'correct_type_confirm'      // worker confirmation before write
  // D3-T6: Sasha lead-assignment via WhatsApp.
  | 'assign_lead_pick_lead'     // Sasha picks which unassigned lead (numbered list)
  | 'assign_lead_pick_worker'   // Sasha picks the target worker (numbered list with AI suggestion)
  | 'assign_lead_confirm'       // Sasha confirms the assignment before writing
  // D2-T11: schedule a new TaskField for an existing Task from WhatsApp.
  // State machine per HANDOFF §5. Context payload carries taskId + resolved
  // Task metadata across states so nothing has to be re-queried at commit time.
  | 'schedule_intake_pick_task'    // waiting for user to pick a Task number (1..N)
  | 'schedule_search_customer'     // fallback: waiting for customer name search query
  | 'schedule_pick_from_search'    // waiting for customer pick after search results
  | 'schedule_await_time'          // waiting for date/time (Hebrew → ISO 8601)
  | 'schedule_await_duration'      // waiting for duration in minutes or "אישור" (default 60)
  | 'schedule_confirm'             // waiting for 1 (confirm) / 2 (cancel)
  // Manager menu: unified 6-item manager menu states.
  | 'mgr_menu_root'                // waiting for 1-6 pick from top-level manager menu
  | 'mgr_exceptions_sub'           // waiting for 1-6 pick from exceptions sub-menu
  | 'mgr_leads_sub'                // waiting for 1-4 pick from leads sub-menu
  | 'mgr_workers_sub'              // waiting for 1-3 pick from workers sub-menu
  | 'mgr_search_sub'               // waiting for 1-4 pick from search sub-menu
  | 'mgr_today_pick_task'          // waiting for user to pick from today's inspections list
  | 'mgr_today_action'             // waiting for inline action (correct site / type / reassign / back)
  | 'mgr_exceptions_pick_row'      // waiting for user to pick from exceptions list
  | 'mgr_exceptions_action'        // waiting for inline action after picking an exception row
  | 'mgr_leads_pick_row'           // waiting for user to pick from unassigned/escalated leads list
  | 'mgr_workers_pick_worker'      // waiting for user to pick a worker from the list
  | 'mgr_search_await_query'       // waiting for free-text search query
  | 'mgr_search_pick_task'         // waiting for user to pick from search results
  | 'mgr_search_action';           // waiting for inline action after picking a search result

export interface ConversationState {
  awaiting: AwaitingKind;
  intent?: AIIntentResult;           // the partially-resolved intent (absent for menu/digest states)
  missingField?: string;             // which field we asked for (missing_field)
  candidateTaskIds?: string[];       // options offered (task_disambig)
  candidateUserIds?: string[];       // options offered (owner_disambig)
  candidateLinkIds?: string[];       // options offered (link_disambig: customer/lead/project ids)
  linkField?: string;                // which link FK we're resolving (customerId/leadId/projectId)
  digestField?: 'morning' | 'evening'; // which digest a time change applies to (digest_set_time)
  // v2 inspector flows (D2-T5 + D2-T6 + D2-T7 + D2-T8).
  taskFieldId?: string;              // the single open TaskField being updated
  problemType?: FieldProblemType;    // chosen problem type awaiting a free-text elaboration
  pendingTransition?: FieldStatusTransition; // D2-T5: the transition the worker asked for via free
                                             // text, held while we disambiguate which TaskField.
  // D2-T9: the local date of the equipment reminder tap — retained so the
  // downstream office alert can name the morning the miss was reported for.
  equipmentLocalDate?: string;
  // D3-T6: assign_lead multi-step state.
  assignLeadCandidateIds?: string[];   // unassigned lead UUIDs presented to Sasha
  assignLeadCandidateNames?: string[]; // fromName of each lead (for confirmation text)
  assignLeadSelectedLeadId?: string;   // chosen lead UUID
  assignLeadSelectedLeadName?: string; // chosen lead fromName (for confirmation text)
  assignLeadWorkerIds?: string[];      // inspector candidate UUIDs presented to Sasha
  assignLeadWorkerNames?: string[];    // worker names (for confirmation text)
  assignLeadSelectedWorkerId?: string; // chosen worker UUID
  assignLeadSelectedWorkerName?: string; // chosen worker name (for confirmation text)
  // D2-T11: schedule_task_field multi-step state.
  // Populated progressively as the user walks through the state machine.
  scheduleTaskCandidates?: Array<{   // Task list shown to the user (task-pick state)
    id: string;
    title: string;
    customerName: string | null;
    inspectionLabelHe: string | null;
    siteCity: string | null;
    inspectionTypeId: string | null;
    family: string | null;
    ownerId: string | null;
    siteAddress: string | null;
    fieldContactName: string | null;
    fieldContactPhone: string | null;
    navigationUrl: string | null;
    productName: string | null;
  }>;
  scheduleCustomerCandidates?: Array<{ // Customer search results (search fallback state)
    id: string;
    name: string;
    openTaskCount: number;
  }>;
  scheduleSelectedTask?: {            // Resolved Task data carried forward to confirm
    id: string;
    title: string;
    customerName: string | null;
    inspectionLabelHe: string | null;
    inspectionTypeId: string | null;
    family: string | null;
    ownerId: string | null;
    siteAddress: string | null;
    siteCity: string | null;
    fieldContactName: string | null;
    fieldContactPhone: string | null;
    navigationUrl: string | null;
  };
  scheduleStartAt?: string;           // ISO 8601 date+time (user-supplied)
  scheduleDurationMinutes?: number;   // default 60
  scheduleSpecialInstructions?: string | null;
  // Manager menu: payload fields for multi-step flows.
  mgrTaskFieldIds?: string[];         // numbered list of TaskField IDs shown to the manager
  mgrTaskIds?: string[];              // corresponding Task IDs (parallel array)
  mgrSelectedTaskFieldId?: string;    // the TaskField the manager picked from the list
  mgrSelectedTaskId?: string;         // the corresponding Task ID
  mgrWorkerIds?: string[];            // numbered list of worker IDs for picker
  mgrWorkerNames?: string[];          // worker names (parallel array)
  mgrLeadIds?: string[];              // numbered list of lead IDs for picker
  mgrLeadNames?: string[];            // lead display names (parallel array)
  mgrSearchKind?: 'customer' | 'worker' | 'product'; // which search type is active
}

export async function getContext(phone: string): Promise<ConversationState | null> {
  const result = await pool.query<{ state: ConversationState }>(
    `SELECT state FROM "WhatsappConversationContext"
     WHERE phone = $1 AND "expiresAt" > now()`,
    [phone],
  );
  return result.rowCount === 0 ? null : result.rows[0].state;
}

export async function setContext(phone: string, state: ConversationState): Promise<void> {
  await pool.query(
    `INSERT INTO "WhatsappConversationContext" (phone, state, "expiresAt", "updatedAt")
     VALUES ($1, $2, now() + make_interval(mins => $3), now())
     ON CONFLICT (phone) DO UPDATE
       SET state = EXCLUDED.state, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()`,
    [phone, JSON.stringify(state), TTL_MINUTES],
  );
}

export async function clearContext(phone: string): Promise<void> {
  await pool.query(`DELETE FROM "WhatsappConversationContext" WHERE phone = $1`, [phone]);
}
