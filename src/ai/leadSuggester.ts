/**
 * AI helper: suggest the best-matching inspector for an incoming lead (D3-T5).
 *
 * Used by the Domain 3 leads stream (Sasha 09:30 digest D3-T2 and 1-hour
 * escalation D3-T4). Both consumers are B2-blocked (they need the `lead
 * incoming` table columns first), but this function itself is not — it takes
 * a plain lead payload and a candidate list, so it can be unit-tested and
 * wired up in advance.
 *
 * Contract:
 * - Strictly a SUGGESTION. Never auto-assigns; the CRM owns assignment.
 * - Returns { userId: null, reason: 'לא נמצאה התאמה' } on any of:
 *     • no provider configured
 *     • empty candidate list
 *     • provider throws
 *     • provider returns a userId that is not in the candidate list (hallucination)
 * - Never throws. Errors are logged and downgraded to a null match.
 */
import { getProvider, type LLMProvider } from './provider';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('lead-suggester');

const NO_MATCH_REASON = 'לא נמצאה התאמה';

export interface LeadInput {
  service?: string | null;
  messageText?: string | null;
  customerName?: string | null;
}

export interface InspectorCandidate {
  id: string;
  name: string;
  role: string;
}

export interface SuggestionResult {
  userId: string | null;
  reason: string;
}

const SUGGEST_TOOL_NAME = 'suggest_worker';
const SUGGEST_TOOL_DESCRIPTION =
  'Emit a single suggested inspector for the given lead, or null when there is no clear match.';

const SUGGEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: {
      type: ['string', 'null'],
      description: 'The chosen candidate id, or null when there is no clear match.',
    },
    reason: {
      type: 'string',
      description: 'A short Hebrew reason for the choice (or for the null match).',
    },
  },
  required: ['userId', 'reason'],
};

const SYSTEM_PROMPT =
  'אתה מסייע לחלק לידים לטכנאים בהתאם לתחום התמחות. אל תמציא מזהה — החזר null אם אין התאמה ברורה.';

function buildUserMessage(lead: LeadInput, candidates: InspectorCandidate[]): string {
  const leadLines = [
    lead.service ? `שירות: ${lead.service}` : null,
    lead.customerName ? `לקוח: ${lead.customerName}` : null,
    lead.messageText ? `הודעה: ${lead.messageText}` : null,
  ].filter(Boolean);

  const candidateLines = candidates.map((c) => `- id=${c.id} | שם=${c.name} | תפקיד=${c.role}`);

  return [
    'ליד:',
    ...(leadLines.length > 0 ? leadLines : ['(אין פרטים)']),
    '',
    'מועמדים:',
    ...candidateLines,
    '',
    'בחר את המועמד שתפקידו מתאים ביותר לתחום הליד. אם אין התאמה ברורה, החזר userId=null עם reason="' +
      NO_MATCH_REASON +
      '".',
  ].join('\n');
}

/**
 * Ask the configured LLM which candidate best matches a lead's domain.
 *
 * The `provider` param mirrors `parseIntent`'s pattern in `intentParser.ts` —
 * defaults to `getProvider()` so real callers pass just the two args, while
 * tests can inject a mock directly without going through the module-level seam.
 */
export async function suggestWorkerForLead(
  lead: LeadInput,
  candidates: InspectorCandidate[],
  provider: LLMProvider | null = getProvider(),
): Promise<SuggestionResult> {
  if (candidates.length === 0) {
    return { userId: null, reason: NO_MATCH_REASON };
  }
  if (!provider) {
    return { userId: null, reason: NO_MATCH_REASON };
  }

  let raw: Record<string, unknown>;
  try {
    raw = await provider.emitStructured({
      system: SYSTEM_PROMPT,
      user: buildUserMessage(lead, candidates),
      toolName: SUGGEST_TOOL_NAME,
      toolDescription: SUGGEST_TOOL_DESCRIPTION,
      schema: SUGGEST_SCHEMA,
    });
  } catch (err) {
    log.error({ err, provider: provider.name }, 'lead suggester provider call failed');
    return { userId: null, reason: NO_MATCH_REASON };
  }

  const rawUserId = raw.userId;
  const rawReason = raw.reason;

  const reason = typeof rawReason === 'string' && rawReason.trim().length > 0
    ? rawReason
    : NO_MATCH_REASON;

  if (rawUserId === null || rawUserId === undefined) {
    return { userId: null, reason };
  }
  if (typeof rawUserId !== 'string') {
    log.warn({ rawUserId, provider: provider.name }, 'lead suggester returned non-string userId');
    return { userId: null, reason: NO_MATCH_REASON };
  }

  const match = candidates.find((c) => c.id === rawUserId);
  if (!match) {
    log.warn(
      { rawUserId, provider: provider.name, candidateIds: candidates.map((c) => c.id) },
      'lead suggester returned unknown userId (hallucination) — downgraded to no-match',
    );
    return { userId: null, reason: NO_MATCH_REASON };
  }

  return { userId: match.id, reason };
}
