import fs from 'fs';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import dotenv from 'dotenv';
import { moduleLogger } from '../utils/logger';

dotenv.config();

const log = moduleLogger('db');

// ── Validate required env vars ────────────────────────────────────────────────

const missing = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(
  (k) => !process.env[k],
);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

// ── SSL config ────────────────────────────────────────────────────────────────
// Supabase's DIRECT connection (db.<ref>.supabase.co:5432) presents a cert that
// is NOT in the system trust store, so `rejectUnauthorized: true` fails with
// SELF_SIGNED_CERT_IN_CHAIN. Resolution order:
//   1. DATABASE_SSL=disable        → no TLS at all (plain local / CI Postgres).
//   2. DATABASE_CA_CERT=<pem path> → full verification against the Supabase CA
//                                    (RECOMMENDED for production — download it from
//                                    Supabase → Project Settings → Database → SSL).
//   3. otherwise                   → TLS encrypted but cert chain NOT verified.
//                                    In production we log a warning recommending #2.
const isProduction = process.env.NODE_ENV === 'production';
const caCertPath = process.env.DATABASE_CA_CERT;

let sslConfig: false | { rejectUnauthorized: boolean; ca?: string };
if (process.env.DATABASE_SSL === 'disable') {
  sslConfig = false;
} else if (caCertPath) {
  sslConfig = { rejectUnauthorized: true, ca: fs.readFileSync(caCertPath, 'utf8') };
} else {
  if (isProduction) {
    log.warn(
      'DATABASE_CA_CERT not set — DB TLS is encrypted but the server certificate is NOT verified. ' +
        'Set DATABASE_CA_CERT to the Supabase CA cert path for full verification.',
    );
  }
  sslConfig = { rejectUnauthorized: false };
}

// ── pg Pool — used for all raw SQL queries ────────────────────────────────────
// The session timezone is pinned to Asia/Jerusalem as a connection STARTUP
// parameter (`options: -c timezone=...`) rather than a post-connect `SET TIME
// ZONE` query. Doing it via the 'connect' event raced the caller's first query
// on the same fresh client (two overlapping queries → pg deprecation warning);
// the startup parameter applies it at connect time with no extra query.
// This keeps now(), CURRENT_DATE, date_trunc(), and naive-timestamp comparisons
// aligned with the scheduler (which also runs in Asia/Jerusalem).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  options: '-c timezone=Asia/Jerusalem',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  log.error({ err }, 'Unexpected pool error');
});

// ── Supabase admin client — service-role key bypasses RLS ────────────────────
// `createClient` eagerly constructs a RealtimeClient, which needs a global
// WebSocket. Node < 22 has none, so it throws on import (breaks tests/CI on
// Node 20). We never use realtime here, but the client still builds it, so we
// hand it the `ws` implementation explicitly to keep construction Node-agnostic.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: {
      // `ws` structurally satisfies the WebSocketLikeConstructor the client
      // needs, but its DOM-typed signatures don't line up nominally, so cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport: ws as any,
    },
  },
);
