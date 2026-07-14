/**
 * Microsoft OAuth 2.0 Authorization-Code flow + token service (migration 020).
 *
 * Three public functions:
 *   startOAuth      — build the Microsoft authorization URL + a signed state token.
 *   completeOAuth   — exchange auth code for tokens, store encrypted refresh token.
 *   getAccessToken  — decrypt stored refresh token → mint a fresh access token.
 *
 * Security rules that MUST NOT be violated:
 *   - Access tokens are NEVER persisted to the database.
 *   - Refresh tokens are NEVER stored in plaintext — always AES-256-GCM encrypted.
 *   - Tokens (access, refresh, id_token, code) are NEVER logged, even at .debug().
 *   - Only userId / msObjectId / upn / HTTP status codes / MS error codes are logged.
 */

import crypto from 'node:crypto';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('microsoft-auth');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PublicMicrosoftAccount {
  userId: string;
  msTenantId: string;
  msObjectId: string;
  upn: string;
  scopes: string;
  linkedAt: Date;
  updatedAt: Date;
}

// Shape of a row returned from the MicrosoftAccount table
interface MicrosoftAccountRow {
  id: string;
  userId: string;
  msTenantId: string;
  msObjectId: string;
  upn: string;
  encryptedRefreshToken: string;
  tokenIv: string;
  tokenAuthTag: string;
  scopes: string;
  linkedAt: Date;
  updatedAt: Date;
}

// Minimal shape of the Microsoft token endpoint response
interface MsTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

// Minimal shape of the /me Graph response
interface MsGraphMeResponse {
  id?: string;
  userPrincipalName?: string;
  mail?: string;
}

// Parsed state payload
interface StatePayload {
  userId: string;
  nonce: string;
  ts: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OAUTH_SCOPES = 'offline_access Calendars.ReadWrite User.Read';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Private helpers: env-var readers ─────────────────────────────────────────

function getGraphClientId(): string {
  const v = process.env.GRAPH_CLIENT_ID;
  if (!v) throw new Error('GRAPH_CLIENT_ID env var is not set');
  return v;
}

function getGraphClientSecret(): string {
  const v = process.env.GRAPH_CLIENT_SECRET;
  if (!v) throw new Error('GRAPH_CLIENT_SECRET env var is not set');
  return v;
}

function getGraphTenantId(): string {
  const v = process.env.GRAPH_TENANT_ID;
  if (!v) throw new Error('GRAPH_TENANT_ID env var is not set');
  return v;
}

function getGraphRedirectUri(): string {
  const v = process.env.GRAPH_REDIRECT_URI;
  if (!v) throw new Error('GRAPH_REDIRECT_URI env var is not set');
  return v;
}

function getInternalApiSecret(): string {
  const v = process.env.INTERNAL_API_SECRET;
  if (!v) throw new Error('INTERNAL_API_SECRET env var is not set');
  return v;
}

// ── Private helpers: AES-256-GCM encryption ───────────────────────────────────

/**
 * Lazy-validated AES key.
 * Throws at FIRST USE if the env var is missing or wrong length.
 */
function getEncryptionKey(): Buffer {
  const hex = process.env.MS_TOKEN_ENCRYPTION_KEY ?? '';
  if (!hex || hex.length !== 64) {
    throw new Error('MS_TOKEN_ENCRYPTION_KEY must be 32 bytes hex (64 chars)');
  }
  const key = Buffer.from(hex, 'hex');
  // Double-check decoded length (e.g. if the string contained non-hex chars).
  if (key.length !== 32) {
    throw new Error('MS_TOKEN_ENCRYPTION_KEY must be 32 bytes hex (64 chars)');
  }
  return key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns base64-encoded ciphertext, IV (12 bytes), and auth tag (16 bytes).
 * All three values must be stored together to later decrypt.
 */
function encryptRefreshToken(plaintext: string): {
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  const key = getEncryptionKey();
  const ivBuf = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, ivBuf);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // always 16 bytes for GCM
  return {
    ciphertext: encrypted.toString('base64'),
    iv: ivBuf.toString('base64'),
    authTag: tag.toString('base64'),
  };
}

/**
 * Decrypt a refresh token that was produced by encryptRefreshToken.
 * Throws on authentication failure (tampered ciphertext / wrong key / wrong tag).
 */
function decryptRefreshToken(ciphertext: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const ivBuf = Buffer.from(iv, 'base64');
  const tagBuf = Buffer.from(authTag, 'base64');
  const cipherBuf = Buffer.from(ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  return decrypted.toString('utf8');
}

// ── Private helper: HMAC-SHA256 for state signing ─────────────────────────────

function hmacSha256Base64url(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Verify a MAC in constant time to prevent timing attacks.
 * Both `a` and `b` should be the same encoding (base64url strings → Buffers).
 */
function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  // timingSafeEqual requires same-length buffers; pad to longest.
  if (aBuf.length !== bBuf.length) {
    // Still run the comparison (with mismatch guarantee) to avoid early return
    // leaking length info in timing.
    const max = Math.max(aBuf.length, bBuf.length);
    const aPad = Buffer.alloc(max);
    const bPad = Buffer.alloc(max);
    aBuf.copy(aPad);
    bBuf.copy(bPad);
    // Always false when lengths differ — but run the comparison anyway.
    crypto.timingSafeEqual(aPad, bPad); // side-effect: constant time
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ── Private helper: Microsoft token endpoint ──────────────────────────────────

function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

// ── Public exports ────────────────────────────────────────────────────────────

/**
 * Build the Microsoft authorization URL and a signed, time-stamped state token.
 *
 * State format:
 *   statePayload = base64url(JSON({ userId, nonce, ts }))
 *   stateSig     = base64url(HMAC-SHA256(INTERNAL_API_SECRET, statePayload))
 *   state        = `${statePayload}.${stateSig}`
 *
 * The state is verified (HMAC + 10-min TTL) in completeOAuth.
 */
export function startOAuth(
  userId: string,
  options: { loginHint?: string } = {},
): { url: string; state: string } {
  const tenantId = getGraphTenantId();
  const clientId = getGraphClientId();
  const redirectUri = getGraphRedirectUri();
  const secret = getInternalApiSecret();

  // 1. Build signed state.
  const nonce = crypto.randomBytes(24).toString('base64url');
  const stateJson: StatePayload = { userId, nonce, ts: Date.now() };
  const statePayload = Buffer.from(JSON.stringify(stateJson), 'utf8').toString('base64url');
  const stateSig = hmacSha256Base64url(secret, statePayload);
  const state = `${statePayload}.${stateSig}`;

  // 2. Build authorization URL.
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: OAUTH_SCOPES,
    state,
  });

  // Do not force prompt=consent here. Once tenant/user consent exists, forcing
  // another consent operation can be rejected by tenants that disable user
  // consent. login_hint only selects the intended account; it grants nothing.
  if (options.loginHint) {
    params.set('login_hint', options.loginHint);
  }

  const url =
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    params.toString();

  log.info({ userId }, 'Microsoft OAuth flow started');

  return { url, state };
}

/**
 * Exchange an authorization code for tokens, store the encrypted refresh token,
 * and return the public account shape (no tokens).
 *
 * Validates the OAuth state (HMAC + TTL) before doing anything.
 */
export async function completeOAuth(
  code: string,
  state: string,
): Promise<PublicMicrosoftAccount> {
  // ── 1. Validate state ────────────────────────────────────────────────────────
  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    throw new Error('OAuth state invalid or expired');
  }
  const statePayload = state.slice(0, dotIndex);
  const receivedSig = state.slice(dotIndex + 1);

  const secret = getInternalApiSecret();
  const expectedSig = hmacSha256Base64url(secret, statePayload);

  if (!timingSafeCompare(receivedSig, expectedSig)) {
    throw new Error('OAuth state invalid or expired');
  }

  let parsed: StatePayload;
  try {
    parsed = JSON.parse(Buffer.from(statePayload, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new Error('OAuth state invalid or expired');
  }

  if (!parsed.userId || !parsed.ts) {
    throw new Error('OAuth state invalid or expired');
  }

  if (Date.now() - parsed.ts > STATE_TTL_MS) {
    throw new Error('OAuth state invalid or expired');
  }

  const { userId } = parsed;
  const tenantId = getGraphTenantId();

  // ── 2. Exchange code for tokens ───────────────────────────────────────────────
  const tokenUrl = tokenEndpoint(tenantId);

  const tokenBody = new URLSearchParams({
    client_id: getGraphClientId(),
    client_secret: getGraphClientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: getGraphRedirectUri(),
    scope: OAUTH_SCOPES,
  });

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });

  const tokenData = (await tokenRes.json()) as MsTokenResponse;

  if (!tokenRes.ok) {
    // Log only the error code, NOT the body (may contain sensitive detail).
    const errCode = tokenData.error ?? 'unknown_error';
    log.error({ userId, httpStatus: tokenRes.status, msErrorCode: errCode }, 'Token exchange failed');
    throw new Error(`Microsoft token exchange failed: ${errCode}`);
  }

  if (!tokenData.access_token) {
    throw new Error('Microsoft did not return an access_token');
  }

  if (!tokenData.refresh_token) {
    throw new Error(
      'Microsoft did not return a refresh token — did the app forget offline_access scope?',
    );
  }

  const accessToken: string = tokenData.access_token;
  const refreshToken: string = tokenData.refresh_token;
  const grantedScopes: string = tokenData.scope ?? OAUTH_SCOPES;

  // ── 3. Fetch /me to get identity ─────────────────────────────────────────────
  const meRes = await fetch(
    'https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,mail',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!meRes.ok) {
    log.error({ userId, httpStatus: meRes.status }, '/me fetch failed after token exchange');
    throw new Error(`Microsoft Graph /me request failed (HTTP ${meRes.status})`);
  }

  const meData = (await meRes.json()) as MsGraphMeResponse;

  const msObjectId = meData.id;
  if (!msObjectId) {
    throw new Error('Microsoft Graph /me did not return an id (msObjectId)');
  }

  const upn = meData.userPrincipalName ?? meData.mail ?? '';
  if (!upn) {
    log.warn({ userId, msObjectId }, '/me returned no userPrincipalName or mail');
  }

  // ── 4. Encrypt refresh token ──────────────────────────────────────────────────
  const { ciphertext, iv, authTag } = encryptRefreshToken(refreshToken);

  // ── 5. Upsert MicrosoftAccount ───────────────────────────────────────────────
  const upsertResult = await pool.query<{
    userId: string;
    msTenantId: string;
    msObjectId: string;
    upn: string;
    scopes: string;
    linkedAt: Date;
    updatedAt: Date;
  }>(
    `INSERT INTO "MicrosoftAccount"
       ("userId", "msTenantId", "msObjectId", upn,
        "encryptedRefreshToken", "tokenIv", "tokenAuthTag",
        scopes, "linkedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT ("userId") DO UPDATE SET
       "msTenantId"             = EXCLUDED."msTenantId",
       "msObjectId"             = EXCLUDED."msObjectId",
       upn                      = EXCLUDED.upn,
       "encryptedRefreshToken"  = EXCLUDED."encryptedRefreshToken",
       "tokenIv"                = EXCLUDED."tokenIv",
       "tokenAuthTag"           = EXCLUDED."tokenAuthTag",
       scopes                   = EXCLUDED.scopes,
       "updatedAt"              = now()
     RETURNING
       "userId", "msTenantId", "msObjectId", upn,
       scopes, "linkedAt", "updatedAt"`,
    [userId, tenantId, msObjectId, upn, ciphertext, iv, authTag, grantedScopes],
  );

  const row = upsertResult.rows[0];

  log.info(
    { userId, msObjectId, upn },
    'Microsoft account linked / updated',
  );

  return {
    userId: row.userId,
    msTenantId: row.msTenantId,
    msObjectId: row.msObjectId,
    upn: row.upn,
    scopes: row.scopes,
    linkedAt: row.linkedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Retrieve a stored Microsoft account for `userId`, decrypt its refresh token,
 * mint a fresh access token from the Microsoft token endpoint, and return it.
 *
 * If Microsoft indicates the grant was revoked (invalid_grant), throws a
 * user-friendly Hebrew error.
 *
 * If Microsoft issues a rotated refresh token in the response, the new token is
 * re-encrypted and the DB row is updated immediately.
 *
 * The access token is returned as-is and NEVER written to the database or logged.
 */
export async function getAccessToken(userId: string): Promise<string> {
  // ── 1. Load account row ────────────────────────────────────────────────────────
  const selectResult = await pool.query<MicrosoftAccountRow>(
    `SELECT id, "userId", "msTenantId", "msObjectId", upn,
            "encryptedRefreshToken", "tokenIv", "tokenAuthTag",
            scopes, "linkedAt", "updatedAt"
       FROM "MicrosoftAccount"
      WHERE "userId" = $1`,
    [userId],
  );

  const row = selectResult.rows[0];
  if (!row) {
    throw new Error('החשבון לא מחובר ל-Outlook');
  }

  // ── 2. Decrypt refresh token ───────────────────────────────────────────────────
  const refreshToken = decryptRefreshToken(
    row.encryptedRefreshToken,
    row.tokenIv,
    row.tokenAuthTag,
  );

  // ── 3. Mint fresh access token ─────────────────────────────────────────────────
  const tokenUrl = tokenEndpoint(row.msTenantId);

  const tokenBody = new URLSearchParams({
    client_id: getGraphClientId(),
    client_secret: getGraphClientSecret(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: OAUTH_SCOPES,
  });

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });

  // Read and parse the body exactly once.
  const tokenData = (await tokenRes.json()) as MsTokenResponse;

  if (!tokenRes.ok) {
    const errCode = tokenData.error ?? 'unknown_error';

    // Log only the error code identifier — NOT the full body.
    log.error(
      { userId, msObjectId: row.msObjectId, httpStatus: tokenRes.status, msErrorCode: errCode },
      'Token refresh failed',
    );

    if (errCode === 'invalid_grant') {
      throw new Error('החיבור ל-Outlook פג — יש לחבר את החשבון מחדש');
    }

    // Other 4xx / 5xx — surface the error code only, not the body.
    throw new Error(`Microsoft token refresh failed: ${errCode}`);
  }

  if (!tokenData.access_token) {
    throw new Error('Microsoft did not return an access_token on refresh');
  }

  const freshAccessToken: string = tokenData.access_token;

  // ── 4. Persist rotated refresh token if Microsoft issued a new one ─────────────
  if (tokenData.refresh_token) {
    const newRefreshToken: string = tokenData.refresh_token;
    const { ciphertext, iv, authTag } = encryptRefreshToken(newRefreshToken);

    await pool.query(
      `UPDATE "MicrosoftAccount"
          SET "encryptedRefreshToken" = $1,
              "tokenIv"               = $2,
              "tokenAuthTag"          = $3,
              "updatedAt"             = now()
        WHERE "userId" = $4`,
      [ciphertext, iv, authTag, userId],
    );

    log.debug({ userId, msObjectId: row.msObjectId }, 'Rotated refresh token persisted');
  }

  log.info({ userId, msObjectId: row.msObjectId }, 'Access token minted');

  // Return access token — NEVER log it.
  return freshAccessToken;
}
