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

import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { moduleLogger } from '../utils/logger';
import { resolveVoiceToken, createVoiceToken } from '../services/voiceAccess';
import { pool } from '../db/connection';
import { getPublicBaseUrl } from '../services/owntracksProvisioning';
import {
  buildOpenAiTools,
  listToolNames,
  executeVoiceTool,
} from '../services/voiceTools';
import { localJerusalemDate } from '../ai/dateRangeParser';
import { isManagerMenuUser } from '../ai/menu';
import type { ResolvedUser } from '../types';
import { renderVoicePage } from './voiceAssistant.template';
import { ROBOT_DATA_URI, hasRobotImage } from './voiceAssets';

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

function buildInstructions(user: ResolvedUser, toolNames: string[]): string {
  const manager = isManagerMenuUser(user);
  const has = (n: string) => toolNames.includes(n);

  // Name the capabilities that are OFF this session (CRM bridge / calendar not
  // configured) so גלי states it plainly instead of firing a "near" tool.
  const unavailable: string[] = [];
  if (!has('list_my_crm_tasks')) unavailable.push('משימות משרד (CRM) — יצירה/עדכון/רשימה');
  if (!has('get_calendar_events')) unavailable.push('יומן Outlook — צפייה וקביעת פגישות');

  return [
    `את "גלי" — עוזרת אישית קולית של מערכת ניהול המשימות ובדיקות השטח.`,
    `המשתמש/ת בשיחה: ${user.name} (תפקיד: ${user.role}${manager ? ', עם הרשאות ניהול' : ''}).`,
    `היום ${dayOfWeekHe()}, ${localJerusalemDate()} (שעון ישראל).`,
    unavailable.length
      ? `שים לב — היכולות הבאות אינן זמינות בשיחה כרגע (לא הוגדרו בשרת): ${unavailable.join('; ')}. אם יבקשו אותן, אמרי בכנות שהן עדיין לא זמינות בקול והצעי לפנות ל-CRM. אל תשתמשי בכלי אחר במקומן.`
      : ``,
    ``,
    `כללי שיחה:`,
    `- דברי עברית בלבד, בטון חם, טבעי ותכליתי. משפטים קצרים — זו שיחה קולית.`,
    `- זו מערכת אמת: כל שאלה על נתונים (בדיקות, משימות, לידים, יומן) חייבת לעבור דרך כלי. אל תמציאי נתונים לעולם.`,
    `- כשכלי מחזיר שדה speak — אפשר להקריא אותו כמעט כלשונו.`,
    `- כשכלי מחזיר options — הקריאי אותן בקצרה (עד 4-5) ושאלי למי הכוונה, ואז קראי לכלי שוב עם המזהה שנבחר.`,
    `- לפני פעולה משמעותית שאינה הפיכה בקלות (סיום בדיקה, דחייה, שיוך ליד, שיוך משימה מחדש, שליחת הודעה) — אשרי בקצרה מה עומדת לעשות אם יש אי-ודאות כלשהי.`,
    `- מחיקת אירוע מהיומן (delete_calendar_event) היא בלתי-הפיכה: תמיד אשרי מפורשות עם המשתמש איזה אירוע נמחק ("למחוק את הפגישה עם היטאצ'י ב-16.7?") לפני שאת מריצה את הכלי.`,
    `- תאריכים: חשבי יחסית להיום. "מחר ב-10" = מחר בשעה 10:00 בשעון ישראל, בפורמט ISO מקומי (בלי Z).`,
    `- מספרים, שעות ותאריכים — אמרי בעברית טבעית (למשל "עשר וחצי", "שלוש בדיקות").`,
    `- בתחילת שיחה: ברכי קצר ("שלום ${user.name.split(' ')[0]}, מה נעשה היום?") — בלי נאומים.`,
    ``,
    `"המשימות שלי" — התצוגה המשולבת של היום:`,
    ``,
    `כשהמשתמש שואל שאלה כללית על מה יש לו — "מה המשימות שלי", "מה יש לי היום", "מה יש לי מחר", "מה יש לי לעשות", "מה על הפרק", "מה יש לי בשטח" — קראי ל-get_my_tasks.`,
    `get_my_tasks מחזיר בבת אחת את כל אירועי היומן (Outlook — בלי סינון, גם בדיקות שטח וגם פגישות רגילות) יחד עם משימות המשרד (CRM) שתאריך היעד שלהן בטווח, ובסוף את המשימות שבאיחור. ברירת המחדל היא היום; ליום או טווח אחר העבירי when (למשל "מחר", "השבוע"). הקריאי קודם את משימות הטווח, ואת המשימות שבאיחור הקריאי בסוף.`,
    ``,
    `כלים ייעודיים כשמבקשים משהו ממוקד:`,
    `- "כל היומן" / "כל הפגישות" / "מה קבוע לי השבוע" / קביעת פגישה = get_calendar_events (צפייה רחבה), create_calendar_event / update_calendar_event / delete_calendar_event.`,
    `- "כל משימות המשרד הפתוחות שלי" (בלי קשר לתאריך) = list_my_crm_tasks. לפרטי משימה = get_crm_task_details. ליצירת משימה = create_crm_task. למנהלים: "המשימות של כל העובדים" / "מה יש לדני" = list_all_crm_tasks.`,
    `- "לידים" / "פניות" / "לקוחות חדשים" = list_pending_leads, get_lead_details, assign_lead (למורשים בלבד).`,
    ``,
    `לשאלה כללית "מה יש לי" — תמיד get_my_tasks, לא get_calendar_events ולא get_my_inspections.`,
    ``,
    `רשימה מול פרטים — דפוס חוצה-עולמות:`,
    `- כלי list_* מחזיר סיכום קצר לכל פריט (נושא, שם, סטטוס, לפעמים תקציר 200 תווים). זה מיועד להקראה כללית.`,
    `- כשמשתמש מבקש פרטים על פריט ספציפי מתוך רשימה ("מה כתוב בליד של כהן?", "ספרי לי עוד על המשימה השנייה", "מה הכתובת המלאה של הבדיקה של לוי?") — קראי לכלי ה-details המתאים: get_lead_details / get_crm_task_details / get_inspection_details.`,
    `- אל תנסי לענות "מהזיכרון" על סמך הרשימה. אם המידע לא בתשובת ה-list — קראי ל-details, זו הדרך היחידה לקבל את המלא.`,
    `- העבירי את המזהה של הפריט שכבר קיבלת ברשימה (lead_id/task_id/task_field_id) — או, אם המשתמש דיבר בשמות, שם/עיר/נושא כ-hint.`,
    ``,
    `כשאין כלי מתאים:`,
    `- אם המשתמש מבקש נתונים שאין להם כלי זמין ברשימת הכלים שלך (למשל אין כלי יומן או אין כלי משימות) — אל תריצי כלי אחר "קרוב" במקום. אמרי בכנות שהפעולה הזו אינה זמינה כרגע בשיחה הקולית, והצעי לפנות ל-CRM. אסור להחליף פעולה אחת באחרת.`,
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

  // Compute tools + persona ONCE — the persona names which capabilities are off
  // so the model won't substitute a "near" tool when one is missing.
  const tools = buildOpenAiTools(user);
  const instructions = buildInstructions(user, listToolNames(user));

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
          instructions,
          tools,
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

  // PWA manifest — makes "Add to Home Screen" install גלי as a standalone app
  // with the branded icon + green splash. Served from the same host so the
  // page's relative /voice/manifest.webmanifest resolves without CORS.
  app.get('/voice/manifest.webmanifest', async (_req, reply) => {
    if (!voiceAssistantEnabled()) return reply.code(404).send({ error: 'not found' });

    // Icon: the branded robot when embedded, else a generated green SVG so the
    // installed app still shows *something* on-brand rather than a blank tile.
    const icon = hasRobotImage()
      ? { src: ROBOT_DATA_URI as string, type: 'image/png' }
      : {
          src:
            'data:image/svg+xml,' +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
                '<rect width="512" height="512" rx="112" fill="#6aa84f"/>' +
                '<text x="50%" y="55%" font-size="300" text-anchor="middle" dominant-baseline="middle">🤖</text>' +
              '</svg>',
            ),
          type: 'image/svg+xml',
        };

    const manifest = {
      name: 'גלי — העוזרת הקולית של גלית',
      short_name: 'גלי',
      description: 'עוזרת קולית בעברית לניהול משימות, בדיקות שטח, יומן ולקוחות.',
      lang: 'he',
      dir: 'rtl',
      start_url: '/voice' + (typeof (_req.query as { u?: string })?.u === 'string'
        ? '?u=' + encodeURIComponent((_req.query as { u: string }).u)
        : ''),
      scope: '/voice',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f4faf3',
      theme_color: '#6aa84f',
      icons: [
        { ...icon, sizes: '192x192', purpose: 'any' },
        { ...icon, sizes: '512x512', purpose: 'any' },
        { ...icon, sizes: '512x512', purpose: 'maskable' },
      ],
    };

    return reply
      .header('Cache-Control', 'no-store')
      .type('application/manifest+json; charset=utf-8')
      .send(JSON.stringify(manifest));
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

  // ── Machine-to-machine: mint/return a personal link for a CRM user ─────────
  // The CRM's "עוזרת קולית" button calls this server-to-server with a shared
  // secret (VOICE_LINK_SECRET) + the logged-in user's CRM id. Returns a ready
  // /voice?u=<token> URL so the browser opens already identified. Never exposed
  // to the browser — the secret stays server-side in the CRM API.
  app.post<{ Body: { userId?: string; label?: string } }>('/voice/link', async (req, reply) => {
    if (!voiceAssistantEnabled()) return reply.code(404).send({ error: 'not found' });

    const expected = (process.env.VOICE_LINK_SECRET ?? '').trim();
    if (!expected) {
      logger.error('VOICE_LINK_SECRET not configured — /voice/link disabled');
      return reply.code(503).send({ error: 'link minting not configured' });
    }
    const provided = (req.headers['x-voice-link-secret'] as string) ?? '';
    // Timing-safe compare; length guard first (timingSafeEqual throws on mismatch).
    const ok =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    if (!userId) return reply.code(400).send({ error: 'userId required' });

    // The user must exist and be ACTIVE in the shared DB.
    const { rows } = await pool.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM "User" WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'user not found' });
    if (rows[0].status !== 'ACTIVE' && rows[0].status !== 'active') {
      return reply.code(403).send({ error: 'user inactive' });
    }

    // Mint a fresh token each click. The raw value can't be recovered from the
    // stored hash, so we can't "return the existing one"; instead old CRM
    // tokens simply coexist (all valid until they expire). To cap churn we
    // revoke this user's prior CRM-labelled tokens first, so at most one CRM
    // link is live per user at a time.
    await pool.query(
      `UPDATE "VoiceAccessToken"
          SET "revokedAt" = now()
        WHERE "userId" = $1 AND "revokedAt" IS NULL AND label = 'CRM'`,
      [userId],
    );
    const minted = await createVoiceToken(userId, { label: 'CRM' });
    const token = minted.token;

    let base: string;
    try {
      base = getPublicBaseUrl();
    } catch {
      return reply.code(503).send({ error: 'PUBLIC_BASE_URL not configured' });
    }
    return reply.send({ url: `${base}/voice?u=${token}`, name: rows[0].name });
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
