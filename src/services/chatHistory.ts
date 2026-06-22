/**
 * Short rolling chat window per phone, used to resolve references like
 * "the third one" / "details on that task". The window is small on purpose —
 * this is a transactional bot, not a chat companion.
 *
 * Turns are written by our own code (the user's raw text + a COMPACT summary of
 * what the bot returned), never by a separate AI call. All operations are
 * best-effort: a failure here (e.g. table not migrated yet) must never break the
 * main flow.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import type { ChatTurn } from '../types';

const log = moduleLogger('chatHistory');

const TTL_MINUTES = parseInt(process.env.CHAT_HISTORY_TTL_MINUTES ?? '20', 10);
const MAX_MESSAGES = parseInt(process.env.CHAT_HISTORY_MAX ?? '6', 10);
const MAX_CONTENT = 1000; // hard cap per stored turn to bound prompt size

/** The recent turns for this phone (oldest→newest), or [] when none / expired / error. */
export async function getHistory(phone: string): Promise<ChatTurn[]> {
  try {
    const r = await pool.query<{ messages: ChatTurn[] }>(
      `SELECT messages FROM "WhatsappChatHistory" WHERE phone = $1 AND "expiresAt" > now()`,
      [phone],
    );
    return r.rowCount === 0 ? [] : (r.rows[0].messages ?? []);
  } catch (err) {
    log.error({ err, phone }, 'getHistory failed (continuing without history)');
    return [];
  }
}

/** Append a turn, trim to the window size, and refresh the TTL. Best-effort. */
export async function appendTurn(phone: string, role: ChatTurn['role'], content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;
  const turn: ChatTurn = { role, content: trimmed.slice(0, MAX_CONTENT) };
  try {
    const current = await getHistory(phone);
    const next = [...current, turn].slice(-MAX_MESSAGES);
    await pool.query(
      `INSERT INTO "WhatsappChatHistory" (phone, messages, "expiresAt", "updatedAt")
       VALUES ($1, $2::jsonb, now() + make_interval(mins => $3), now())
       ON CONFLICT (phone) DO UPDATE
         SET messages = EXCLUDED.messages, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()`,
      [phone, JSON.stringify(next), TTL_MINUTES],
    );
  } catch (err) {
    log.error({ err, phone }, 'appendTurn failed (continuing)');
  }
}

/** Forget the rolling window for this phone. */
export async function clearHistory(phone: string): Promise<void> {
  try {
    await pool.query(`DELETE FROM "WhatsappChatHistory" WHERE phone = $1`, [phone]);
  } catch (err) {
    log.error({ err, phone }, 'clearHistory failed');
  }
}
