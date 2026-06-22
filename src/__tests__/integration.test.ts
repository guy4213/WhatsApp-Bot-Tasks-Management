/**
 * Integration tests — exercise the REAL migrations + pending-action SQL against a
 * throwaway PostgreSQL.
 *
 * Skipped unless RUN_DB_TESTS=1 (so `vitest run` stays fast/offline locally).
 * CI sets:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
 *   DATABASE_SSL=disable
 *   RUN_DB_TESTS=1
 *
 * What it covers:
 *  - All four migrations apply cleanly (incl. the quoted "User"/"Task" FK refs).
 *  - createPendingAction inserts the expected row + future expiry.
 *  - transitionState's first-to-resolve guard (fromState) — only one winner.
 *  - expireStaleActions flips overdue rows to EXPIRED and reports the old state.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.RUN_DB_TESTS === '1';

// Stable test fixtures
const USER_ID = 'test-user-1';
const MGR_ID = 'test-mgr-1';
const TASK_ID = 'test-task-1';

describe.skipIf(!RUN)('integration: migrations + pending-action state machine', () => {
  // Imported lazily so the dummy-env pool isn't required when the suite is skipped.
  let pool: typeof import('../db/connection').pool;
  let svc: typeof import('../services/pendingActions');

  beforeAll(async () => {
    ({ pool } = await import('../db/connection'));
    svc = await import('../services/pendingActions');

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

    // Seed fixtures.
    await pool.query(
      `INSERT INTO "User" (id, name, phone, role, status) VALUES
         ($1,'Emp','972500000001','SALES','ACTIVE'),
         ($2,'Mgr','972500000002','MANAGER','ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, MGR_ID],
    );
    await pool.query(
      `INSERT INTO "Task" (id, title) VALUES ($1,'Test task') ON CONFLICT (id) DO NOTHING`,
      [TASK_ID],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM "WhatsappPendingAction"');
    await pool.end();
  });

  it('createPendingAction inserts a PENDING_EMPLOYEE_CONFIRM row with a future expiry', async () => {
    const pa = await svc.createPendingAction({
      requesterUserId: USER_ID,
      actionType: 'EDIT_FIELD',
      targetTaskId: TASK_ID,
      payload: { field: 'title', new_value: 'x' },
    });
    expect(pa.state).toBe('PENDING_EMPLOYEE_CONFIRM');
    expect(new Date(pa.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('transitionState enforces first-to-resolve via fromState (only one winner)', async () => {
    const pa = await svc.createPendingAction({
      requesterUserId: USER_ID,
      actionType: 'EDIT_DUEDATE',
      targetTaskId: TASK_ID,
      payload: { field: 'dueDate', new_value: '2026-07-01' },
      initialState: 'PENDING_MANAGER_APPROVAL',
    });

    // First manager approves — succeeds.
    const won = await svc.transitionState(pa.id, 'EXECUTED', MGR_ID, 'PENDING_MANAGER_APPROVAL');
    expect(won.state).toBe('EXECUTED');
    expect(won.resolvedAt).not.toBeNull();

    // Second resolver loses — state no longer matches fromState.
    await expect(
      svc.transitionState(pa.id, 'REJECTED', MGR_ID, 'PENDING_MANAGER_APPROVAL'),
    ).rejects.toThrow();
  });

  it('expireStaleActions flips overdue rows to EXPIRED and reports the pre-expiry state', async () => {
    // Insert directly so we control an already-past expiry.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "WhatsappPendingAction"
         ("requesterUserId", "actionType", "targetTaskId", payload, state, "expiresAt")
       VALUES ($1,'EDIT_DUEDATE',$2,$3,'PENDING_MANAGER_APPROVAL', now() - interval '1 hour')
       RETURNING id`,
      [USER_ID, TASK_ID, JSON.stringify({ taskTitle: 'Overdue task' })],
    );
    const id = rows[0].id;

    const expired = await svc.expireStaleActions();
    const mine = expired.find((e) => e.id === id);
    expect(mine).toBeDefined();
    expect(mine!.state).toBe('PENDING_MANAGER_APPROVAL'); // old state, before expiry
    expect(mine!.requesterPhone).toBe('972500000001');
    expect(mine!.taskTitle).toBe('Overdue task');

    const after = await pool.query<{ state: string; resolvedAt: string | null }>(
      `SELECT state, "resolvedAt" FROM "WhatsappPendingAction" WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].state).toBe('EXPIRED');
    expect(after.rows[0].resolvedAt).not.toBeNull();
  });
});
