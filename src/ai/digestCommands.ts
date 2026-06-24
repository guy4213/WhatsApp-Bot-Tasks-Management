/**
 * Deterministic digest follow-up commands (quick-reply buttons + exact text).
 *
 * These route a tapped digest button OR the exact fallback phrase to a fixed
 * action WITHOUT going through the AI/NLU parser — so the digest CTAs always work,
 * even when buttons aren't available on the client or the AI is misconfigured.
 *
 * Pure module (no DB / network) so the matching + routing plan is unit-testable.
 * The router (ai/router.ts) executes the plan; the digest formatters
 * (whatsapp/digestContent.ts) attach these same payload IDs to their buttons.
 */

/** Stable internal payload IDs echoed back by Meta as interactive.button_reply.id. */
export const DIGEST_PAYLOAD_IDS = {
  EMP_TODAY: 'digest_emp_today',
  EMP_EOD: 'digest_emp_eod',
  TEAM_TODAY: 'digest_team_today',
  TEAM_EOD: 'digest_team_eod',
  FREE_TEXT: 'digest_free_text',
} as const;

export type DigestCommand = 'EMP_TODAY' | 'EMP_EOD' | 'TEAM_TODAY' | 'TEAM_EOD' | 'FREE_TEXT';

/** Exact Hebrew text fallbacks — typed by users on clients without buttons. */
const TEXT_COMMANDS: Record<string, DigestCommand> = {
  'משימות להיום': 'EMP_TODAY',
  'דוח סוף יום שלי': 'EMP_EOD',
  'משימות להיום בצוות': 'TEAM_TODAY',
  'דוח סוף יום צוות': 'TEAM_EOD',
  'כתיבה חופשית': 'FREE_TEXT',
};

// payload id → command (reverse of DIGEST_PAYLOAD_IDS)
const PAYLOAD_TO_COMMAND: Record<string, DigestCommand> = Object.fromEntries(
  Object.entries(DIGEST_PAYLOAD_IDS).map(([cmd, id]) => [id, cmd as DigestCommand]),
);

/**
 * Resolve an inbound message to a digest command, or null when it is neither a
 * known button payload nor an exact text command (so it falls through to the AI
 * parser unchanged). Matching is exact (after trimming + stripping trailing
 * punctuation) so partial/free text like "משימות להיום בבקשה" never matches.
 */
export function matchDigestCommand(raw: string): DigestCommand | null {
  const trimmed = raw.trim();
  if (PAYLOAD_TO_COMMAND[trimmed]) return PAYLOAD_TO_COMMAND[trimmed];

  const normalized = trimmed.replace(/[!?.,]+$/u, '').trim();
  return TEXT_COMMANDS[normalized] ?? null;
}

/** What a digest command resolves to — pure, so routing + the elevated guard are testable. */
export type DigestPlan =
  | { kind: 'list'; filter: 'today_overdue'; scope: 'own' | 'all' }
  | { kind: 'employee_eod' }
  | { kind: 'team_eod' }
  | { kind: 'free_text' }
  | { kind: 'denied' }; // team command requested by a non-elevated user

/**
 * Map a command + the caller's role to a concrete plan. Team commands are
 * company-wide and elevated-only — a non-elevated caller gets `denied` so an
 * employee can never reach other employees' tasks through a digest button.
 */
export function planDigestCommand(cmd: DigestCommand, user: { isElevated: boolean }): DigestPlan {
  switch (cmd) {
    case 'EMP_TODAY':
      return { kind: 'list', filter: 'today_overdue', scope: 'own' };
    case 'TEAM_TODAY':
      return user.isElevated ? { kind: 'list', filter: 'today_overdue', scope: 'all' } : { kind: 'denied' };
    case 'EMP_EOD':
      return { kind: 'employee_eod' };
    case 'TEAM_EOD':
      return user.isElevated ? { kind: 'team_eod' } : { kind: 'denied' };
    case 'FREE_TEXT':
      return { kind: 'free_text' };
  }
}
