/**
 * Probe — call Nominatim directly with 8 variations of the address and print
 * what each one returns. Read-only. No DB writes. Not used in production.
 *
 * Goal: figure out what Nominatim actually knows about
 * "אלופי צה\"ל 48, חולון" — so we can decide whether to add another variant
 * to the geocoder, fall back to another provider, or accept manual override.
 */
import 'dotenv/config';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = process.env.GEOCODER_USER_AGENT ?? 'GalitTrackingBot/1.0';

const VARIANTS = [
  'אלופי צה"ל 48, חולון',   // ASCII "
  'אלופי צה״ל 48, חולון',   // gershayim (U+05F4)
  'אלופי צהל 48, חולון',     // no quote at all
  'אלופי צה"ל 48',           // no city
  'אלופי צה"ל, חולון',       // no house number
  '48 אלופי צה"ל, חולון',    // number first (English convention)
  'Alufey Tzahal 48, Holon',
  'Alufei Tsahal 48, Holon',
];

async function probe(q: string) {
  const url =
    `${NOMINATIM_URL}?format=json&limit=3&countrycodes=il&addressdetails=0&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'he,en;q=0.7',
      },
    });
    if (!res.ok) {
      console.log(`  HTTP ${res.status}`);
      return;
    }
    const body = await res.json() as Array<Record<string, unknown>>;
    if (!body.length) {
      console.log('  (empty)');
      return;
    }
    for (const hit of body) {
      console.log(`  → ${hit.lat}, ${hit.lon}    ${hit.display_name}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  for (const q of VARIANTS) {
    console.log(`\n=== ${q} ===`);
    await probe(q);
    // Nominatim ToS: at most 1 req/s.
    await new Promise((r) => setTimeout(r, 1100));
  }
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
