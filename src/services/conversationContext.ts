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
  | 'equipment_missing_note';

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
