/**
 * Diagnostic — read-only. Answers "why is `destination` missing from the JSON?"
 * by walking the same code path the customer page walks:
 *
 *   1. Find the current ACTIVE|ARRIVED TrackingSession(s).
 *   2. Print the raw TaskField site fields (columns from migration 017).
 *   3. Call resolveTaskFieldDestination() and print what it returns.
 *   4. Call getPublicView() and print the exact JSON `/tracking/:token` returns.
 *
 * The script imports the real services, so it exercises the exact code that
 * runs in production — no reimplementation. It NEVER writes to the DB. If
 * Nominatim gets called (a cache miss), the CACHE WRITE inside
 * `siteGeocodeCache` may happen — that's the intended production behavior
 * and equivalent to a real customer opening the link.
 */
import 'dotenv/config';
import { pool } from '../src/db/connection';
import { resolveTaskFieldDestination } from '../src/services/siteGeocodeCache';
import { getPublicView } from '../src/services/tracking';

interface SessionRow {
  id: string;
  taskFieldId: string;
  workerUserId: string;
  status: string;
  publicToken: string;
  startedAt: string;
  arrivedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  lastLocationAt: string | null;
}

async function main() {
  const sessions = await pool.query<SessionRow>(
    `SELECT id, "taskFieldId", "workerUserId", status, "publicToken",
            "startedAt", "arrivedAt", "endedAt", "expiresAt", "lastLocationAt"
       FROM "TrackingSession"
      WHERE status IN ('ACTIVE','ARRIVED')
      ORDER BY "startedAt" DESC`,
  );

  console.log(`\n=== TrackingSession — ACTIVE|ARRIVED rows: ${sessions.rowCount ?? 0} ===`);
  if (!sessions.rowCount) {
    console.log('No active session. Send "יצאתי" from the worker phone and try again.');
    return;
  }

  for (const s of sessions.rows) {
    console.log('\n────────────────────────────────────────────────');
    console.log('Session:', {
      id: s.id,
      taskFieldId: s.taskFieldId,
      workerUserId: s.workerUserId,
      status: s.status,
      publicToken: s.publicToken,
      startedAt: s.startedAt,
      expiresAt: s.expiresAt,
      lastLocationAt: s.lastLocationAt,
    });

    // 2. TaskField site fields — the source of the destination.
    const tf = await pool.query(
      `SELECT id, "fieldStatus", "siteAddress", "siteCity",
              "siteLat", "siteLng",
              "siteGeocodeSource", "siteGeocodeQuery", "siteGeocodedAt"
         FROM "TaskField"
        WHERE id = $1`,
      [s.taskFieldId],
    );
    console.log('\nTaskField site fields:');
    console.log(tf.rows[0] ?? '(NOT FOUND — impossible if the session exists)');

    // 3. resolveTaskFieldDestination — the exact function getPublicView calls.
    console.log('\nresolveTaskFieldDestination(taskFieldId):');
    try {
      const dest = await resolveTaskFieldDestination(s.taskFieldId);
      console.log(dest);
    } catch (err) {
      console.log('THREW:', err instanceof Error ? err.message : err);
    }

    // 4. getPublicView — the JSON the customer page actually receives.
    console.log('\ngetPublicView(publicToken):');
    try {
      const view = await getPublicView(s.publicToken);
      console.log(JSON.stringify(view, null, 2));
    } catch (err) {
      console.log('THREW:', err instanceof Error ? err.message : err);
    }
  }
}

main()
  .catch((err) => {
    console.error('\n[FAIL]', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => { /* best-effort */ });
  });
