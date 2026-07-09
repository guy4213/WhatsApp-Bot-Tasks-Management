/**
 * Submit the `due_reminder_v2` WhatsApp template to Meta — the enhanced
 * out-of-window due-date reminder (TASK_ENHANCED_DUE_REMINDER.md).
 *
 * 9 body vars + a URL button ("פתח משימה ב-CRM", dynamic suffix filling {{1}}
 * in the URL) + a QUICK_REPLY button ("פרטים נוספים"). The body is imported
 * from `src/services/taskDetailFormatter.ts` (DUE_REMINDER_V2_TEMPLATE_BODY) so
 * it can never drift from what the code substitutes at send time.
 *
 * Meta button ordering rule: URL/PHONE buttons must come before QUICK_REPLY,
 * so URL is at index 0 and QUICK_REPLY at index 1.
 *
 * Usage:
 *   npx tsx scripts/create-due-reminder-v2-template.ts --dry-run   # preview only
 *   npx tsx scripts/create-due-reminder-v2-template.ts             # LIVE submit
 *
 * After it shows PENDING → APPROVED at Meta, override in Render:
 *   WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2
 */
import dotenv from 'dotenv';
import {
  DUE_REMINDER_V2_TEMPLATE_BODY,
  DUE_REMINDER_V2_PARAM_COUNT,
} from '../src/services/taskDetailFormatter';

dotenv.config();

const CATEGORY = 'UTILITY';
const NAME = 'due_reminder_v2';
const QUICK_REPLY_BUTTON_TEXT = 'פרטים נוספים';
const URL_BUTTON_TEXT = 'פתח משימה ב-CRM';
// The URL button's variable must sit at the END of the URL (Meta rule).
const URL_BUTTON_URL = 'https://crm.galit.co.il/dashboard?taskid={{1}}';
// One example taskId Meta uses for approval preview — the send-time value is
// the actual Task.id (see dueDateReminder.ts).
const URL_BUTTON_EXAMPLE = '5320b5c0-35f7-4d57-ab81-3162a5e631a7';

// One example value per {{1}}..{{9}}, in order.
const EXAMPLE: string[] = [
  'בדיקת מעלית שנתית',      // {{1}} taskTitle
  'משה כהן',                // {{2}} customerName
  '03-1234567',             // {{3}} customerPhone
  'דנה לוי',                // {{4}} contactName
  '050-7654321',            // {{5}} contactPhone
  '06/07 בשעה 14:00',       // {{6}} dueDate
  'יוסי אחראי',             // {{7}} assignedTo
  'לבדוק את מערכת הבלמים',  // {{8}} description
  'הלקוח ביקש להתקשר לפני', // {{9}} notes
];

function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => parseInt(m[1], 10));
}

function validate(): string[] {
  const errs: string[] = [];
  const body = DUE_REMINDER_V2_TEMPLATE_BODY;
  const trimmed = body.trim();
  if (/^\{\{/.test(trimmed)) errs.push('body starts with a variable');
  const withoutTrailingPunct = trimmed.replace(/[\s.,!?:;"'()\-־]+$/u, '');
  if (/\}\}$/.test(withoutTrailingPunct)) errs.push('body ends with a variable');
  if (/\}\}\s*\{\{/.test(body)) errs.push('adjacent variables');
  const nums = placeholders(body);
  const max = nums.length ? Math.max(...nums) : 0;
  const set = new Set(nums);
  for (let i = 1; i <= max; i++) if (!set.has(i)) errs.push(`missing {{${i}}}`);
  if (max !== DUE_REMINDER_V2_PARAM_COUNT) {
    errs.push(`placeholder count (${max}) != expected ${DUE_REMINDER_V2_PARAM_COUNT}`);
  }
  if (EXAMPLE.length !== max) errs.push(`example count (${EXAMPLE.length}) != placeholders (${max})`);
  if (QUICK_REPLY_BUTTON_TEXT.length > 25) errs.push('quick_reply button text > 25 chars');
  if (URL_BUTTON_TEXT.length > 25) errs.push('URL button text > 25 chars');
  // Meta requires the URL variable to be positioned at the END of the URL.
  if (!/\{\{1\}\}$/.test(URL_BUTTON_URL)) errs.push('URL button URL must end with {{1}}');
  return errs;
}

function buildPayload(lang: string) {
  return {
    name: NAME,
    category: CATEGORY,
    language: lang,
    components: [
      { type: 'BODY', text: DUE_REMINDER_V2_TEMPLATE_BODY, example: { body_text: [EXAMPLE] } },
      {
        type: 'BUTTONS',
        buttons: [
          // URL/PHONE buttons must precede QUICK_REPLY buttons (Meta rule).
          { type: 'URL', text: URL_BUTTON_TEXT, url: URL_BUTTON_URL, example: [URL_BUTTON_EXAMPLE] },
          { type: 'QUICK_REPLY', text: QUICK_REPLY_BUTTON_TEXT },
        ],
      },
    ],
  };
}

async function submit(url: string, token: string, payload: unknown) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: json.id, status: json.status };
    const e = json?.error ?? {};
    const parts = [
      e.message ?? `HTTP ${res.status}`,
      e.code != null ? `code=${e.code}` : '',
      e.error_subcode != null ? `subcode=${e.error_subcode}` : '',
      e.error_user_msg ? `user_msg=${e.error_user_msg}` : '',
    ].filter(Boolean).join(' | ');
    return { ok: false, error: parts };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const wabaId = process.env.META_WABA_ID || '';
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const lang = process.env.WHATSAPP_TEMPLATE_LANG || 'he';

  console.log(`${NAME} — ${dryRun ? 'DRY RUN' : 'LIVE'} | graph ${graphVersion} | lang ${lang}\n`);

  const errs = validate();
  if (errs.length) {
    console.error(`✗ ${NAME}: ${errs.join('; ')}`);
    console.error('\nInvalid — nothing sent.');
    process.exit(1);
  }

  if (dryRun) {
    console.log(`── ${NAME} (body) ──`);
    console.log(DUE_REMINDER_V2_TEMPLATE_BODY);
    console.log(`\n── buttons ──`);
    console.log(`[URL]         ${URL_BUTTON_TEXT} → ${URL_BUTTON_URL}`);
    console.log(`[QUICK_REPLY] ${QUICK_REPLY_BUTTON_TEXT}`);
    console.log('\n── payload ──');
    console.log(JSON.stringify(buildPayload(lang), null, 2));
    console.log('\nDRY RUN — nothing sent.');
    return;
  }

  if (!wabaId || !token) {
    console.error('Missing META_WABA_ID / WHATSAPP_ACCESS_TOKEN');
    process.exit(1);
  }
  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`;
  const r = await submit(url, token, buildPayload(lang));
  if (r.ok) {
    console.log(`✓ ${NAME}: submitted (id=${r.id}, status=${r.status ?? 'PENDING'}).`);
    console.log('When APPROVED, set WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2 in Render.');
  } else {
    console.error(`✗ ${NAME}: ${r.error}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('Fatal:', e?.message ?? e); process.exit(1); });
