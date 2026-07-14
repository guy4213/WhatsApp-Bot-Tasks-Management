/**
 * VOICE-5 — HTTP surface of the Hebrew voice assistant ("גלי").
 *
 * Routes (all under the public host — token-gated, not header-gated, because
 * the browser page itself is the caller):
 *   GET  /voice            — the RTL voice-chat page (?u=<personal token>)
 *   POST /voice/session    — {token} → mints an OpenAI Realtime ephemeral
 *                            client secret whose session embeds the user's
 *                            Hebrew persona + ONLY the tools their role allows
 *   POST /voice/tool       — {token, name, args} → executes one tool call
 *                            (re-validates the gate server-side + audits)
 *
 * Conversation engine: OpenAI Realtime over WebRTC (speech↔speech, Hebrew).
 * ElevenLabs Agents was evaluated and rejected for now: its realtime TTS
 * models have no Hebrew, and Hebrew-capable eleven_v3 is both plan-gated and
 * not realtime-recommended. The tool layer is engine-agnostic on purpose —
 * swapping the engine later touches only this file + the page template.
 *
 * Security:
 *   - The personal token (see voiceAccess.ts) is the ONLY credential. It is
 *     never logged. Invalid/expired tokens → 401 with a Hebrew message.
 *   - The OPENAI_API_KEY never reaches the browser — only a short-lived
 *     ephemeral client secret (10 min) minted per session.
 *   - Kill switch: VOICE_ASSISTANT_ENABLED=false disables all three routes.
 */

import type { FastifyInstance } from 'fastify';
import { moduleLogger } from '../utils/logger';
import { resolveVoiceToken } from '../services/voiceAccess';
import {
  buildOpenAiTools,
  listToolNames,
  executeVoiceTool,
} from '../services/voiceTools';
import { localJerusalemDate } from '../ai/dateRangeParser';
import { isManagerMenuUser } from '../ai/menu';
import type { ResolvedUser } from '../types';
import { renderVoicePage } from './voiceAssistant.template';

const logger = moduleLogger('voice-assistant');

const OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-realtime-2.1';
const FALLBACK_MODEL = 'gpt-realtime';
const EPHEMERAL_TTL_SECONDS = 600;

function voiceAssistantEnabled(): boolean {
  return (process.env.VOICE_ASSISTANT_ENABLED ?? 'true').toLowerCase() !== 'false';
}

// ── Persona ───────────────────────────────────────────────────────────────────

function dayOfWeekHe(): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
  }).format(new Date());
}

function buildInstructions(user: ResolvedUser): string {
  const manager = isManagerMenuUser(user);
  return [
    `את "גלי" — עוזרת אישית קולית של מערכת ניהול המשימות ובדיקות השטח.`,
    `המשתמש/ת בשיחה: ${user.name} (תפקיד: ${user.role}${manager ? ', עם הרשאות ניהול' : ''}).`,
    `היום ${dayOfWeekHe()}, ${localJerusalemDate()} (שעון ישראל).`,
    ``,
    `כללי שיחה:`,
    `- דברי עברית בלבד, בטון חם, טבעי ותכליתי. משפטים קצרים — זו שיחה קולית.`,
    `- זו מערכת אמת: כל שאלה על נתונים (בדיקות, משימות, לידים, יומן) חייבת לעבור דרך כלי. אל תמציאי נתונים לעולם.`,
    `- כשכלי מחזיר שדה speak — אפשר להקריא אותו כמעט כלשונו.`,
    `- כשכלי מחזיר options — הקריאי אותן בקצרה (עד 4-5) ושאלי למי הכוונה, ואז קראי לכלי שוב עם המזהה שנבחר.`,
    `- לפני פעולה משמעותית שאינה הפיכה בקלות (סיום בדיקה, דחייה, שיוך ליד, שיוך משימה מחדש, שליחת הודעה) — אשרי בקצרה מה עומדת לעשות אם יש אי-ודאות כלשהי.`,
    `- תאריכים: חשבי יחסית להיום. "מחר ב-10" = מחר בשעה 10:00 בשעון ישראל, בפורמט ISO מקומי (בלי Z).`,
    `- מספרים, שעות ותאריכים — אמרי בעברית טבעית (למשל "עשר וחצי", "שלוש בדיקות").`,
    `- אם מבקשים משהו שאין לו כלי — אמרי בכנות שהפעולה עדיין לא נתמכת בקול, והפנה לוואטסאפ של הבוט או ל-CRM.`,
    `- בתחילת שיחה: ברכי קצר ("שלום ${user.name.split(' ')[0]}, מה נעשה היום?") — בלי נאומים.`,
    ``,
    `דגשים חשובים:`,
    `- "יצאתי" / "אני בדרך" → update_inspection_status עם DEPARTED (זה שולח ללקוח הודעה + מעקב חי אוטומטית — ספרי למשתמש שזה קרה).`,
    `- "הגעתי" → ARRIVED. "סיימתי" → FINISHED. "אשר/י" → CONFIRM.`,
    `- כשמזכירים שם לקוח או עיר ליד פעולה — העבירי אותו כ-hint לכלי.`,
    `- אל תקריאי מזהים טכניים (UUID) בקול לעולם — השתמשי בשמות.`,
  ].join('\n');
}

// ── Ephemeral session mint ────────────────────────────────────────────────────

interface MintResult {
  clientSecret: string;
  expiresAt: number | null;
  model: string;
}

async function mintEphemeralSecret(user: ResolvedUser): Promise<MintResult> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const configured = (process.env.VOICE_REALTIME_MODEL ?? '').trim();
  const modelsToTry = configured
    ? [configured, FALLBACK_MODEL]
    : [DEFAULT_MODEL, FALLBACK_MODEL];
  const voice = (process.env.VOICE_REALTIME_VOICE ?? 'marin').trim();
  const transcribeModel = (process.env.VOICE_TRANSCRIBE_MODEL ?? 'whisper-1').trim();

  let lastError = '';
  for (const model of [...new Set(modelsToTry)]) {
    const res = await fetch(`${OPENAI_BASE}/realtime/client_secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: EPHEMERAL_TTL_SECONDS },
        session: {
          type: 'realtime',
          model,
          instructions: buildInstructions(user),
          tools: buildOpenAiTools(user),
          tool_choice: 'auto',
          audio: {
            input: {
              transcription: { model: transcribeModel, language: 'he' },
            },
            output: { voice },
          },
        },
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { value?: string; expires_at?: number };
      if (!data.value) throw new Error('OpenAI mint returned no client secret');
      return { clientSecret: data.value, expiresAt: data.expires_at ?? null, model };
    }

    // 4xx on the model id → try the fallback alias once; anything else → stop.
    lastError = `status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) lastError = body.error.message;
    } catch { /* body not json — keep status */ }
    logger.warn({ model, status: res.status, err: lastError }, 'ephemeral mint attempt failed');
    if (res.status >= 500) break;
  }
  throw new Error(`OpenAI session mint failed: ${lastError}`);
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function voiceAssistantRoutes(app: FastifyInstance): Promise<void> {

  // The voice page itself. The token stays in the URL fragment-like query and
  // is validated only by the API calls the page makes — the HTML is static.
  app.get('/voice', async (_req, reply) => {
    if (!voiceAssistantEnabled()) {
      return reply.code(404).type('text/html; charset=utf-8').send('<h1>Not found</h1>');
    }
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderVoicePage());
  });

  // Session mint: personal token → ephemeral OpenAI client secret.
  app.post<{ Body: { token?: string } }>('/voice/session', async (req, reply) => {
    if (!voiceAssistantEnabled()) return reply.code(404).send({ error: 'not found' });

    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const user = await resolveVoiceToken(token);
    if (!user) {
      return reply.code(401).send({ error: 'הקישור לא תקף או שפג תוקפו — יש לבקש קישור חדש' });
    }

    try {
      const mint = await mintEphemeralSecret(user);
      logger.info({ userId: user.id, model: mint.model }, 'voice session minted');
      return reply.send({
        client_secret: mint.clientSecret,
        expires_at: mint.expiresAt,
        model: mint.model,
        user: {
          name: user.name,
          role: user.role,
          is_manager: isManagerMenuUser(user),
        },
        tools: listToolNames(user),
      });
    } catch (err) {
      logger.error({ err }, 'voice session mint failed');
      return reply.code(502).send({ error: 'לא הצלחתי לפתוח שיחה קולית כרגע — נסו שוב בעוד רגע' });
    }
  });

  // Tool execution on behalf of the authenticated user.
  app.post<{ Body: { token?: string; name?: string; args?: Record<string, unknown> } }>(
    '/voice/tool',
    async (req, reply) => {
      if (!voiceAssistantEnabled()) return reply.code(404).send({ error: 'not found' });

      const token = typeof req.body?.token === 'string' ? req.body.token : '';
      const user = await resolveVoiceToken(token);
      if (!user) {
        return reply.code(401).send({ ok: false, error: 'הקישור לא תקף — יש לרענן את הדף' });
      }

      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const args =
        req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
      if (!name) return reply.code(400).send({ ok: false, error: 'missing tool name' });

      const result = await executeVoiceTool(user, name, args as Record<string, unknown>);
      return reply.send(result);
    },
  );
}
