/**
 * READ-ONLY — for the 4 digest templates only, dump every timestamp / quality
 * field Meta exposes so we can see when APPROVED was recorded.
 */
import dotenv from 'dotenv';

dotenv.config();

const DIGEST_NAMES = new Set([
  'employee_morning_digest',
  'employee_end_of_day_report',
  'manager_morning_digest',
  'manager_end_of_day_report',
]);

async function main(): Promise<void> {
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const wabaId = process.env.META_WABA_ID || '';
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  if (!wabaId || !accessToken) {
    console.error('Missing META_WABA_ID or WHATSAPP_ACCESS_TOKEN');
    process.exit(1);
  }

  const fields = [
    'name', 'status', 'language', 'category',
    'id', 'last_edited_time', 'previous_category',
    'quality_score', 'rejected_reason', 'created_time',
  ].join(',');
  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates?fields=${fields}&limit=250`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json: any = await res.json();
  if (!res.ok) {
    console.error(`Meta API error ${res.status}:`, JSON.stringify(json.error ?? json, null, 2));
    process.exit(1);
  }

  const nowUtc = new Date();
  const nowIL = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  console.log(`Now UTC: ${nowUtc.toISOString()}   Now Asia/Jerusalem: ${nowIL.toISOString()}\n`);

  const templates = (json.data ?? []).filter((t: any) => DIGEST_NAMES.has(t.name) && t.language === 'he');

  if (templates.length === 0) {
    console.log('No matching digest templates found.');
    return;
  }

  for (const t of templates) {
    console.log(`── ${t.name} ──`);
    console.log(JSON.stringify(t, null, 2));
    if (t.last_edited_time) {
      const editedUtc = new Date(t.last_edited_time * 1000); // Graph often returns unix seconds
      const editedIso = isNaN(editedUtc.getTime()) ? new Date(t.last_edited_time) : editedUtc;
      const editedIL = editedIso.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', hour12: false });
      console.log(`  → last_edited_time (Asia/Jerusalem): ${editedIL}`);
    }
    console.log();
  }
}

main().catch((err) => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
