/**
 * DB-guarded integration tests for the digest feature (migration 008).
 *
 * Skipped unless RUN_DB_TESTS=1 (so `vitest run` stays fast/offline locally),
 * exactly like integration.test.ts. CI sets:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
 *   DATABASE_SSL=disable
 *   RUN_DB_TESTS=1
 *
 * Covers:
 *  - migration 008 applies cleanly (the two tables + RLS).
 *  - upsertDigestPreference create + partial update, with an audit row written.
 *  - claimDigestSend: true once, then false for the same (user, type, day).
 *  - markDigestFailed flips the ledger row to FAILED.
 *  - selectDigestCandidates: default-ON for a user with no preference row, and a
 *    user who opted evening OFF is reflected as evening_enabled = false.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.RUN_DB_TESTS === '1';

// Stable fixtures — distinct from integration.test.ts (separate vitest workers,
// but keep ids unique to be safe if ever co-located).
const DEFAULT_USER = 'dg-default-1';   // no preference row → defaults apply
const OPTOUT_USER = 'dg-optout-1';     // eveningEnabled = false
const PREF_USER = 'dg-pref-1';         // exercises upsert + audit

describe.skipIf(!RUN)('integration: digests (migration 008)', () => {
  let pool: typeof import('../db/connection').pool;
  let prefs: typeof import('../services/digestPreferences');
  let sendLog: typeof import('../services/digestSendLog');
  let dispatcher: typeof import('../scheduler/jobs/digestDispatcher');

  beforeAll(async () => {
    ({ pool } = await import('../db/connection'));
    prefs = await import('../services/digestPreferences');
    sendLog = await import('../services/digestSendLog');
    dispatcher = await import('../scheduler/jobs/digestDispatcher');

    // Minimal stand-ins for the CRM tables the migrations' FKs point at.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "User" (
        id text PRIMARY KEY, name text, phone text, role text, status text
      );
      CREATE TABLE IF NOT EXISTS "Task" (
        id text PRIMARY KEY, title text
      );
    `);

    // Apply every migration in order — the actual SQL the live DB will run.
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }

    await pool.query(
      `INSERT INTO "User" (id, name, phone, role, status) VALUES
         ($1,'Default Emp','972500000011','SALES','ACTIVE'),
         ($2,'Optout Emp', '972500000012','SALES','ACTIVE'),
         ($3,'Pref Emp',   '972500000013','SALES','ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [DEFAULT_USER, OPTOUT_USER, PREF_USER],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM "WhatsappDigestSendLog" WHERE "userId" = ANY($1)', [
      [DEFAULT_USER, OPTOUT_USER, PREF_USER],
    ]);
    await pool.query('DELETE FROM "UserDigestPreference" WHERE "userId" = ANY($1)', [
      [DEFAULT_USER, OPTOUT_USER, PREF_USER],
    ]);
    await pool.query('DELETE FROM "WhatsappAuditLog" WHERE "userId" = ANY($1)', [
      [DEFAULT_USER, OPTOUT_USER, PREF_USER],
    ]);
    await pool.end();
  });

  it('upsertDigestPreference creates a row, partial-updates it, and writes an audit row', async () => {
    // Create: only morningEnabled given — everything else takes the column default.
    const created = await prefs.upsertDigestPreference(
      PREF_USER, { morningEnabled: false }, { phone: '972500000013' },
    );
    expect(created.morningEnabled).toBe(false);
    expect(created.morningTime).toBe('08:00');   // default
    expect(created.eveningEnabled).toBe(true);    // default
    expect(created.eveningTime).toBe('17:00');    // default

    // Partial update: change eveningTime only — morningEnabled stays false.
    const updated = await prefs.upsertDigestPreference(
      PREF_USER, { eveningTime: '19:30' }, { phone: '972500000013' },
    );
    expect(updated.eveningTime).toBe('19:30');
    expect(updated.morningEnabled).toBe(false);   // unchanged

    // Audit rows recorded for the preference changes.
    const audit = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM "WhatsappAuditLog"
       WHERE "userId" = $1 AND "detectedIntent" = 'digest_pref_change'`,
      [PREF_USER],
    );
    expect(parseInt(audit.rows[0].n, 10)).toBeGreaterThanOrEqual(2);
  });

  it('claimDigestSend returns true once then false for the same (user, type, day)', async () => {
    const day = '2026-06-24';
    const first = await sendLog.claimDigestSend(DEFAULT_USER, 'MORNING', day);
    const second = await sendLog.claimDigestSend(DEFAULT_USER, 'MORNING', day);
    expect(first).toBe(true);
    expect(second).toBe(false);

    // A different type the same day is independently claimable.
    const evening = await sendLog.claimDigestSend(DEFAULT_USER, 'EVENING', day);
    expect(evening).toBe(true);
  });

  it('markDigestFailed flips the claimed ledger row to FAILED', async () => {
    const day = '2026-06-25';
    await sendLog.claimDigestSend(OPTOUT_USER, 'MORNING', day);
    await sendLog.markDigestFailed(OPTOUT_USER, 'MORNING', day);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT "status" FROM "WhatsappDigestSendLog"
       WHERE "userId" = $1 AND "digestType" = 'MORNING' AND "localDate" = $2`,
      [OPTOUT_USER, day],
    );
    expect(rows[0].status).toBe('FAILED');
  });

  it('selectDigestCandidates: default-ON when no pref row, opt-out reflected as evening_enabled=false', async () => {
    // OPTOUT_USER opts evening OFF (creates a row); DEFAULT_USER stays row-less.
    await prefs.upsertDigestPreference(OPTOUT_USER, { eveningEnabled: false }, { phone: '972500000012' });

    const rows = await dispatcher.selectDigestCandidates();

    const def = rows.find((r) => r.user_id === DEFAULT_USER);
    expect(def).toBeDefined();
    expect(def!.morning_enabled).toBe(true);   // COALESCE default
    expect(def!.morning_time).toBe('08:00');
    expect(def!.evening_enabled).toBe(true);
    expect(def!.evening_time).toBe('17:00');

    const opt = rows.find((r) => r.user_id === OPTOUT_USER);
    expect(opt).toBeDefined();
    expect(opt!.evening_enabled).toBe(false);  // opted out → dispatcher skips evening
    expect(opt!.morning_enabled).toBe(true);   // morning still on by default
  });
});
