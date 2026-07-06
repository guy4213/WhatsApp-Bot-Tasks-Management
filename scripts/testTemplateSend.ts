/**
 * Send ONE manager_morning_digest template to a single hard-coded recipient
 * (Guy Franses) to test whether Meta's send-time cache has picked up the
 * newly approved template. READ-ONLY beyond the single send.
 */
import dotenv from 'dotenv';
dotenv.config();

const RECIPIENT = '972534271418'; // Guy Franses (053-4271418)
const TEMPLATE = 'manager_morning_digest';
const LANG = 'he';

async function main() {
  const graphVersion = process.env.WHATSAPP_API_VERSION || 'v19.0';
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
  if (!phoneId || !token) {
    console.error('Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN');
    process.exit(1);
  }

  const url = `https://graph.facebook.com/${graphVersion}/${phoneId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: RECIPIENT,
    type: 'template',
    template: {
      name: TEMPLATE,
      language: { code: LANG },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'גיא' },
            { type: 'text', text: '2' },
            { type: 'text', text: '5' },
            { type: 'text', text: '0' },
            { type: 'text', text: '0' },
            { type: 'text', text: '7' },
            { type: 'text', text: '3' },
            { type: 'text', text: '1' },
          ],
        },
      ],
    },
  };

  console.log(`POST ${url}`);
  console.log(`Sending "${TEMPLATE}" (${LANG}) to ${RECIPIENT}\n`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
