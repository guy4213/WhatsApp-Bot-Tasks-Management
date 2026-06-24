import { pool } from '../db/connection';
import type { AIIntentResult } from '../types';

const TTL_MINUTES = parseInt(process.env.CONVERSATION_CONTEXT_TTL_MINUTES ?? '10', 10);

// What the bot is waiting for from the user's next message.
export type AwaitingKind =
  | 'intent_confirm' | 'missing_field' | 'task_disambig' | 'read_confirm'
  | 'create_date' | 'owner_disambig' | 'link_disambig'
  // Role-based numbered menu + digest settings flow (V1). These states carry NO
  // AI intent (hence `intent` is optional below).
  | 'menu' | 'digest_settings' | 'digest_set_time';

export interface ConversationState {
  awaiting: AwaitingKind;
  intent?: AIIntentResult;           // the partially-resolved intent (absent for menu/digest states)
  missingField?: string;             // which field we asked for (missing_field)
  candidateTaskIds?: string[];       // options offered (task_disambig)
  candidateUserIds?: string[];       // options offered (owner_disambig)
  candidateLinkIds?: string[];       // options offered (link_disambig: customer/lead/project ids)
  linkField?: string;                // which link FK we're resolving (customerId/leadId/projectId)
  digestField?: 'morning' | 'evening'; // which digest a time change applies to (digest_set_time)
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
