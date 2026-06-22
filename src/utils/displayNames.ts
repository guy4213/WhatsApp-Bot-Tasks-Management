// ── Display-name resolvers ──────────────────────────────────────────────────────
// User-facing confirmation messages must show human names, never raw database
// ids (UUIDs). These helpers look up the display name for an id; if no row is
// found (bad/edge value) they fall back to returning the id string unchanged so
// a confirmation message never crashes.

import { pool } from '../db/connection';

/** Resolve a User id → name (falls back to the id if not found). */
export async function userName(id: string): Promise<string> {
  const r = await pool.query<{ name: string }>(`SELECT name FROM "User" WHERE id = $1`, [id]);
  return r.rowCount === 0 ? id : r.rows[0].name;
}

/** Resolve a Customer id → name (falls back to the id if not found). */
export async function customerName(id: string): Promise<string> {
  const r = await pool.query<{ name: string }>(`SELECT name FROM "Customer" WHERE id = $1`, [id]);
  return r.rowCount === 0 ? id : r.rows[0].name;
}

/** Resolve a Lead id → fullName (falls back to the id if not found). */
export async function leadName(id: string): Promise<string> {
  const r = await pool.query<{ fullName: string }>(`SELECT "fullName" FROM "Lead" WHERE id = $1`, [id]);
  return r.rowCount === 0 ? id : r.rows[0].fullName;
}

/** Resolve a Project id → name (prefixed with #projectNumber when present; falls back to the id). */
export async function projectName(id: string): Promise<string> {
  const r = await pool.query<{ projectNumber: string | null; name: string }>(
    `SELECT "projectNumber", name FROM "Project" WHERE id = $1`,
    [id],
  );
  if (r.rowCount === 0) return id;
  const { projectNumber, name } = r.rows[0];
  return (projectNumber ? `#${projectNumber} ` : '') + name;
}
