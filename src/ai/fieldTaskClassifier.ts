/**
 * AI helper: decide which "uncertain" Outlook calendar events are genuine
 * field inspections/surveys for גלית — the environmental-quality company — as
 * opposed to personal meetings, medical appointments, internal calls, etc.
 *
 * Consumed by `services/voiceTools.ts → filterFieldTaskEvents()`, the SECOND
 * (AI) layer of the `get_my_field_tasks` hybrid filter. A fast synchronous
 * heuristic decides the clear cases (domain keyword → field task; all-day /
 * online meeting → not); ONLY the genuinely ambiguous events reach here.
 *
 * Contract (mirrors leadSuggester.ts's conservative shape):
 * - ONE provider call for the WHOLE batch — never one call per event.
 * - Empty input → empty Map, NO provider call.
 * - Never throws. Any failure — no provider configured, provider throws, or a
 *   malformed / partial answer — degrades to a conservative `false` for every
 *   input event. Rationale: a missed field task still shows up in the full
 *   calendar (get_calendar_events); a personal meeting must NEVER surface under
 *   "my field tasks". We deliberately prefer false-negative over false-positive.
 * - Hallucination guard: results whose event_id was not in the input are
 *   dropped; every input event is guaranteed exactly one Map entry (a
 *   conservative `false` fallback when the model gave no valid verdict for it).
 */
import { getProvider } from './provider';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('field-task-classifier');

const CLASSIFIER_TOOL_NAME = 'classify_field_tasks';
const CLASSIFIER_TOOL_DESCRIPTION =
  'Emit a is_field_task verdict + short Hebrew reason for EACH calendar event id given.';

/** Fallback reason used whenever a verdict is missing/invalid (never throws). */
const NO_VERDICT_REASON = 'לא התקבלה הכרעה תקינה';

export interface UncertainEventInput {
  event_id: string;
  subject: string;
  location: string;
}

export interface FieldTaskVerdict {
  is_field_task: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `אתה מסייע לסוכן קולי בשם "גלי" לזהות אירועי יומן שהם בדיקות שטח של חברת גלית – החברה לאיכות הסביבה.

חברת גלית מבצעת בדיקות בתחומי קרינה, ריח, אסבסט, ראדון, רעש, איכות אוויר, עובש וקרקע.

בדיקת שטח היא ביקור פיזי אצל לקוח או באתר עבודה לצורך בדיקה, סקר, מדידה או דיגום.

פגישה פנימית, ייעוץ טלפוני, פגישה אישית, טיפול רפואי, אירוע משפחתי או ביקור פרטי אינם בדיקת שטח.

הסתמך רק על הכותרת והמיקום שנמסרו לך. אל תנחש. אם לא ברור שמדובר בעבודת שטח של חברת גלית, החזר false.`;

const CLASSIFIER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          event_id: { type: 'string' },
          is_field_task: { type: 'boolean' },
          reason: { type: 'string', description: 'סיבה קצרה בעברית' },
        },
        required: ['event_id', 'is_field_task', 'reason'],
      },
    },
  },
  required: ['classifications'],
};

function buildUserMessage(events: UncertainEventInput[]): string {
  const eventsJson = JSON.stringify(
    events.map((e) => ({ event_id: e.event_id, subject: e.subject, location: e.location })),
    null,
    2,
  );
  return `עבור כל אירוע יומן ברשימה, קבע האם מדובר בבדיקת שטח של חברת גלית או באירוע אחר.

החזר classifications. לכל אירוע החזר:
- event_id
- is_field_task מסוג true או false
- reason קצר בעברית

האירועים:
${eventsJson}`;
}

/**
 * Classify a batch of ambiguous calendar events. See the file header for the
 * full contract. Returns a Map keyed by `event_id`; every input id is present.
 */
export async function classifyUncertainEventsByAI(
  events: UncertainEventInput[],
): Promise<Map<string, FieldTaskVerdict>> {
  const result = new Map<string, FieldTaskVerdict>();

  // Empty input → empty Map, and crucially NO provider call.
  if (events.length === 0) return result;

  const started = Date.now();

  /** Conservative fallback: every input event → false, with the given reason. */
  const fallbackAll = (reason: string, provider: string | null): Map<string, FieldTaskVerdict> => {
    for (const e of events) result.set(e.event_id, { is_field_task: false, reason });
    log.info(
      { inputCount: events.length, resultCount: 0, provider, ms: Date.now() - started, fallback: true },
      'field-task classifier fell back to conservative false for all events',
    );
    return result;
  };

  const provider = getProvider();
  if (!provider) {
    return fallbackAll(NO_VERDICT_REASON, null);
  }

  let raw: Record<string, unknown>;
  try {
    raw = await provider.emitStructured({
      system: SYSTEM_PROMPT,
      user: buildUserMessage(events),
      toolName: CLASSIFIER_TOOL_NAME,
      toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
      schema: CLASSIFIER_SCHEMA,
    });
  } catch (err) {
    log.error({ err, provider: provider.name }, 'field-task classifier provider call failed');
    return fallbackAll(NO_VERDICT_REASON, provider.name);
  }

  // Accept only well-formed verdicts whose event_id was actually in the input
  // (hallucination guard). First valid verdict per id wins.
  const inputIds = new Set(events.map((e) => e.event_id));
  const rawList = (raw as { classifications?: unknown }).classifications;
  const classifications = Array.isArray(rawList) ? rawList : [];

  let acceptedCount = 0;
  for (const item of classifications) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const id = typeof c.event_id === 'string' ? c.event_id : null;
    if (!id || !inputIds.has(id)) continue; // drop hallucinated / unknown ids
    if (result.has(id)) continue;           // first verdict per id wins
    const isField = c.is_field_task === true;
    const reason =
      typeof c.reason === 'string' && c.reason.trim().length > 0
        ? c.reason.trim()
        : NO_VERDICT_REASON;
    result.set(id, { is_field_task: isField, reason });
    acceptedCount += 1;
  }

  // Guarantee a full mapping: any input event the model skipped or garbled gets
  // a conservative false so the caller never has to special-case "no entry".
  for (const e of events) {
    if (!result.has(e.event_id)) {
      result.set(e.event_id, { is_field_task: false, reason: NO_VERDICT_REASON });
    }
  }

  log.info(
    {
      inputCount: events.length,
      resultCount: acceptedCount,
      provider: provider.name,
      ms: Date.now() - started,
      fallback: acceptedCount < events.length,
    },
    'field-task classifier batch complete',
  );

  return result;
}
