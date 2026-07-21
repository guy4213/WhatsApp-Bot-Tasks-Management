/**
 * AI-native agent loop (free-text conversational path).
 *
 * ONE system prompt + a set of tools; the model decides which tools to call, in
 * what order, across several round-trips, then answers in natural Hebrew. This
 * is the "same approach as the voice bot": no rigid single-intent classifier.
 *
 * The loop wraps `provider.runLoop()`. Two special behaviors live here (not in
 * the provider) because they touch WhatsApp state:
 *   1. Destructive tools (calendar delete) are intercepted: instead of running,
 *      the loop stores the pending call and asks the user to confirm. The next
 *      inbound "כן"/"לא" resolves it (see `handleAgentConfirm`).
 *   2. History + the final answer are persisted to the rolling chat window.
 *
 * Enabled by default; set AI_AGENT_LOOP=0 to fall back to the legacy intent
 * router (emergency switch — no behavior change when unset).
 */
import type { ResolvedUser } from '../../types';
import { getProvider, type LoopTool, type LoopToolCall } from '../provider';
import { getHistory, appendTurn } from '../../services/chatHistory';
import { getContext, setContext, clearContext } from '../../services/conversationContext';
import { sendTextMessage } from '../../whatsapp/sender';
import { moduleLogger } from '../../utils/logger';
import { toolsForUser, findToolForUser, type AgentTool } from './tools';
import { isManagerMenuUser } from '../menu';

const log = moduleLogger('agent-loop');

/** True when the AI-native agent loop is active (default on; AI_AGENT_LOOP=0 disables). */
export function agentLoopEnabled(): boolean {
  return (process.env.AI_AGENT_LOOP ?? '1') !== '0';
}

/** Sentinel returned by a destructive tool's interceptor so the loop knows to pause. */
const CONFIRM_SENTINEL = '__AGENT_CONFIRM_REQUIRED__';

function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Build the single system prompt. Role-aware, tells the model what it can do. */
function buildSystemPrompt(user: ResolvedUser): string {
  const isMgr = isManagerMenuUser(user);
  return [
    'את/ה "גלי" — עוז/רת AI בעברית של חברת בדיקות שטח, בתוך וואטסאפ.',
    'את/ה מנהל/ת שיחה טבעית וחופשית לחלוטין. אין תפריט מספרים בשיחה איתך — המשתמש כותב חופשי ואת/ה מבצע/ת.',
    '',
    `היום (אזור זמן Asia/Jerusalem) הוא ${todayLocal()}. פענח/י תאריכים יחסיים ("מחר", "יום ראשון", "בעוד שבוע") לתאריך מוחלט.`,
    '',
    'המשתמש הנוכחי:',
    `- שם: ${user.name}`,
    `- תפקיד: ${user.role}${isMgr ? ' (משתמש/ת ברמת מנהל/ת)' : ' (בודק/ת שטח)'}`,
    '',
    'עקרונות עבודה:',
    '- כשמבקשים "המשימות/הבדיקות שלי" — השתמש/י בכלים כדי למשוך את הנתונים מהמערכת (DB). לעולם אל תמציא/י נתונים.',
    '- אפשר לשרשר מספר כלים בתור אחד כדי לענות על בקשה מורכבת (למשל: קודם להציג רשימה, ואז לעדכן סטטוס לפריט ממנה).',
    '- לפני עדכון סטטוס בדיקה, ודא/י איזו בדיקה — לפי מזהה מהרשימה או לפי שם לקוח/כתובת. אם לא ברור, שאל/י.',
    '- לכלי יומן (Outlook) צריך שהמשתמש חיבר/ה את חשבון Microsoft שלו/ה. אם מתקבלת שגיאת הרשאה — הסבר/י שצריך להתחבר מחדש.',
    '- ליצירת/עדכון אירוע יומן, השתמש/י בשעון מקומי (Asia/Jerusalem) בפורמט ISO כמו 2026-07-22T10:00:00.',
    '- מחיקת אירוע יומן מחייבת אישור מהמשתמש — הכלי יבקש זאת אוטומטית; אל תניח/י שאושר.',
    '- ענה/י תמיד בעברית, קצר וברור. אחרי שביצעת פעולה, אשר/י בקצרה מה נעשה.',
    '- אם בקשה חורגת מהיכולות שלך, אמר/י זאת בכנות והצע/י לכתוב "תפריט" לרשימת הפעולות.',
  ].join('\n');
}

/** One-line Hebrew summary of a pending destructive call, shown in the confirm prompt. */
function summarizeDestructive(tool: AgentTool, input: Record<string, unknown>): string {
  if (tool.name === 'calendar_delete_event') {
    return 'מחיקת אירוע מהיומן';
  }
  return `הפעולה "${tool.name}"`;
}

/**
 * Map the user's tools to the LLM's LoopTool shape (name/description/schema only).
 */
function loopToolsFor(user: ResolvedUser): LoopTool[] {
  return toolsForUser(user).map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.schema,
  }));
}

/**
 * Run the agent loop for a fresh free-text message.
 * Sends the reply over WhatsApp and records the turn in chat history.
 */
export async function runAgentLoop(user: ResolvedUser, text: string): Promise<void> {
  const provider = getProvider();
  if (!provider) {
    await sendTextMessage({ to: user.phone, text: 'שירות ה-AI אינו מוגדר עדיין. נסה שוב מאוחר יותר.' });
    return;
  }

  const history = await getHistory(user.phone);

  // Holds a destructive call the model tried to run; when set, we DON'T execute
  // it — we stash it and ask the user to confirm after the loop returns.
  let pendingDestructive: { tool: AgentTool; call: LoopToolCall; summary: string } | null = null;

  const runTool = async (call: LoopToolCall): Promise<string> => {
    const tool = findToolForUser(user, call.name);
    if (!tool) {
      return `הכלי "${call.name}" אינו זמין למשתמש זה.`;
    }
    if (tool.destructive) {
      // Intercept: stash and tell the model the action awaits confirmation.
      pendingDestructive = { tool, call, summary: summarizeDestructive(tool, call.input) };
      return `${CONFIRM_SENTINEL} — הפעולה דורשת אישור מהמשתמש ולכן טרם בוצעה. הודע/י למשתמש שתתבצע לאחר אישור.`;
    }
    try {
      return await tool.handler(user, call.input);
    } catch (err) {
      log.error({ err, tool: call.name }, 'agent tool handler threw');
      return `שגיאה בהפעלת הכלי: ${(err as Error).message}`;
    }
  };

  let result;
  try {
    result = await provider.runLoop({
      system: buildSystemPrompt(user),
      history,
      user: text,
      tools: loopToolsFor(user),
      runTool,
    });
  } catch (err) {
    log.error({ err, userId: user.id }, 'agent loop failed');
    await sendTextMessage({ to: user.phone, text: 'שגיאה בעיבוד הבקשה. נסה שוב או נסח מחדש.' });
    return;
  }

  // Record the user's turn (after the loop, so it isn't fed into its own call).
  await appendTurn(user.phone, 'user', text);

  // A destructive call is pending → set the confirm state and ask, regardless of
  // whatever text the model produced.
  if (pendingDestructive) {
    const p: { tool: AgentTool; call: LoopToolCall; summary: string } = pendingDestructive;
    await setContext(user.phone, {
      awaiting: 'agent_confirm',
      pendingAgentTool: { name: p.call.name, input: p.call.input, summary: p.summary },
    });
    const ask = `${p.summary} — לאשר? כתוב/י "כן" לאישור או "לא" לביטול.`;
    await appendTurn(user.phone, 'assistant', ask);
    await sendTextMessage({ to: user.phone, text: ask });
    return;
  }

  const reply = (result.text ?? '').trim() || 'סליחה, לא הצלחתי להשלים את הבקשה. נסה/י לנסח מחדש או כתוב/י "תפריט".';
  await appendTurn(user.phone, 'assistant', reply);
  await sendTextMessage({ to: user.phone, text: reply });
}

/**
 * Resolve a pending destructive tool after the user replies to the confirm
 * prompt. Called by the router when context.awaiting === 'agent_confirm'.
 * Returns true when it handled the message.
 */
export async function handleAgentConfirm(user: ResolvedUser, text: string): Promise<boolean> {
  const ctx = await getContext(user.phone);
  if (!ctx || ctx.awaiting !== 'agent_confirm' || !ctx.pendingAgentTool) return false;

  const pending = ctx.pendingAgentTool;
  // Normalize: lowercase + strip trailing punctuation. NOTE: JS `\b` is not
  // Unicode-aware and does NOT create a boundary after Hebrew letters, so we
  // match a whole-word/prefix pattern with an explicit optional separator
  // instead of relying on `\b` (which silently fails for Hebrew).
  const t = text.trim().toLowerCase().replace(/[!?.,\s]+$/u, '');
  const yes = /^(כן|אישור|בטח|אוקיי?|yes|y|לאשר|מאשר|מאשרת)(?=$|\s)/u.test(t);
  const no = /^(לא|ביטול|בטל|לבטל|no|n)(?=$|\s)/u.test(t);

  if (!yes && !no) {
    await sendTextMessage({
      to: user.phone,
      text: `${pending.summary} — לא הבנתי. כתוב/י "כן" לאישור או "לא" לביטול.`,
    });
    return true;
  }

  await clearContext(user.phone);

  if (no) {
    const msg = 'הפעולה בוטלה.';
    await appendTurn(user.phone, 'assistant', msg);
    await sendTextMessage({ to: user.phone, text: msg });
    return true;
  }

  // Confirmed → execute the pending tool now, through the same permission gate.
  const tool = findToolForUser(user, pending.name);
  if (!tool) {
    await sendTextMessage({ to: user.phone, text: 'הפעולה אינה זמינה יותר.' });
    return true;
  }
  let out: string;
  try {
    out = await tool.handler(user, pending.input);
  } catch (err) {
    log.error({ err, tool: pending.name }, 'confirmed destructive tool threw');
    out = `שגיאה בביצוע הפעולה: ${(err as Error).message}`;
  }
  await appendTurn(user.phone, 'assistant', out);
  await sendTextMessage({ to: user.phone, text: out });
  return true;
}
