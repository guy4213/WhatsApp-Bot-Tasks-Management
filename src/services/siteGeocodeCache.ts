/**
 * TaskField destination resolver.
 *
 * MVP+1 for the customer tracking page — see
 * `docs/CUSTOMER_TRACKING_PAGE_DESTINATION.md`.
 *
 * Responsibility: given a TaskField id, return the destination lat/lng and
 * the human-readable address label the customer page will render as
 * "בדרך אל <address>". Everything about caching + provider selection lives
 * behind this function — the callers (currently just `getPublicView`) don't
 * see Nominatim at all.
 *
 * Cache semantics (columns from migration 017):
 *   - **Hit + coords cached**: `siteLat`/`siteLng` non-null AND
 *     `siteGeocodeQuery` matches the current normalized address query →
 *     return them immediately, geocoder NOT called.
 *
 *   - **Sticky no-hit**: `siteGeocodeSource = 'nominatim:no_hit'` AND
 *     `siteGeocodeQuery` matches → return null, geocoder NOT called. We
 *     already know this address is unresolvable and don't want to keep
 *     retrying it forever.
 *
 *   - **Address changed / never geocoded**: any cached `siteGeocodeQuery`
 *     differs from the current normalized address, OR nothing was ever
 *     cached → call the geocoder. Persist per result kind:
 *       * `{kind:'hit'}`       → upsert coords + `source='nominatim'`.
 *       * `{kind:'empty'}`     → upsert `siteLat=null, siteLng=null,
 *                                  source='nominatim:no_hit'`. Sticky.
 *       * `{kind:'transient'}` → **do NOT write** (do not turn a network
 *                                  blip into a sticky no-hit). Return null;
 *                                  next call will retry.
 *
 * Address normalization: `<siteAddress>, <siteCity>` → trim → collapse
 * inner whitespace → lower-case. Whitespace / capitalization tweaks do NOT
 * bust the cache. Substantive edits DO.
 *
 * Never throws. On unexpected DB errors, returns null and logs; the tracking
 * page falls back to worker-only.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { geocodeAddress } from './geocoder';

const log = moduleLogger('site-geocode');

export interface Destination {
  lat: number;
  lng: number;
  address: string;
}

interface TaskFieldSiteRow {
  siteAddress: string | null;
  siteCity: string | null;
  siteLat: number | null;
  siteLng: number | null;
  siteGeocodeSource: string | null;
  siteGeocodeQuery: string | null;
}

/** `"<addr>, <city>"` normalized for cache comparison. Null if either part
 *  is missing/empty. */
function normalizedQuery(addr: string | null, city: string | null): string | null {
  const a = (addr ?? '').trim();
  const c = (city ?? '').trim();
  if (!a || !c) return null;
  return `${a}, ${c}`.replace(/\s+/g, ' ').toLowerCase();
}

/** Display label shown on the page. Kept in its original casing/spacing,
 *  because the cache query is only used for comparison. */
function displayLabel(addr: string, city: string): string {
  return `${addr.trim()}, ${city.trim()}`.replace(/\s+/g, ' ');
}

export async function resolveTaskFieldDestination(
  taskFieldId: string,
): Promise<Destination | null> {
  let row: TaskFieldSiteRow | undefined;
  try {
    const res = await pool.query<TaskFieldSiteRow>(
      `SELECT "siteAddress", "siteCity", "siteLat", "siteLng",
              "siteGeocodeSource", "siteGeocodeQuery"
         FROM "TaskField"
        WHERE id = $1`,
      [taskFieldId],
    );
    row = res.rows[0];
  } catch (err) {
    log.error({ err, taskFieldId }, 'siteGeocodeCache read failed');
    return null;
  }
  if (!row) return null;

  const query = normalizedQuery(row.siteAddress, row.siteCity);
  if (!query) return null; // no address to geocode → silent worker-only fallback

  // ── Cache hit paths (no geocoder call) ─────────────────────────────────
  if (row.siteGeocodeQuery === query) {
    if (row.siteLat != null && row.siteLng != null) {
      return {
        lat: row.siteLat,
        lng: row.siteLng,
        address: displayLabel(row.siteAddress ?? '', row.siteCity ?? ''),
      };
    }
    if (row.siteGeocodeSource === 'nominatim:no_hit') {
      // Sticky no-hit for this exact address — do not retry.
      return null;
    }
    // Row shape says we've seen this query before but coords are null AND
    // no sticky marker — treat as if uncached and re-geocode.
  }

  // ── Cache miss → geocode ────────────────────────────────────────────────
  const result = await geocodeAddress(query);

  if (result.kind === 'transient') {
    // MUST NOT persist. Return null; the next getPublicView call retries.
    return null;
  }

  try {
    if (result.kind === 'hit') {
      await pool.query(
        `UPDATE "TaskField"
            SET "siteLat"           = $2,
                "siteLng"           = $3,
                "siteGeocodedAt"    = now(),
                "siteGeocodeSource" = 'nominatim',
                "siteGeocodeQuery"  = $4
          WHERE id = $1`,
        [taskFieldId, result.lat, result.lng, query],
      );
      return {
        lat: result.lat,
        lng: result.lng,
        address: displayLabel(row.siteAddress ?? '', row.siteCity ?? ''),
      };
    }
    // result.kind === 'empty'
    await pool.query(
      `UPDATE "TaskField"
          SET "siteLat"           = NULL,
              "siteLng"           = NULL,
              "siteGeocodedAt"    = now(),
              "siteGeocodeSource" = 'nominatim:no_hit',
              "siteGeocodeQuery"  = $2
        WHERE id = $1`,
      [taskFieldId, query],
    );
    return null;
  } catch (err) {
    log.error({ err, taskFieldId }, 'siteGeocodeCache write failed');
    return result.kind === 'hit'
      ? { lat: result.lat, lng: result.lng, address: displayLabel(row.siteAddress ?? '', row.siteCity ?? '') }
      : null;
  }
}
