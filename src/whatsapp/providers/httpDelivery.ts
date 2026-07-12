/**
 * Shared outbound delivery mechanics for every WhatsApp provider.
 *
 * Providers differ only in URL / auth headers / request body / success parsing.
 * The parts that must behave identically no matter the provider live here and
 * are moved (not rewritten) out of the old sender.ts:
 *   - retry with exponential back-off (4xx except 429 are non-retryable)
 *   - per-request timeout
 *   - dead-letter (DLQ) logging to "WhatsappAuditLog" on final failure
 *
 * A provider builds its request and passes an `attempt` thunk that performs one
 * HTTP call and returns the outbound message id (or null); `runWithRetry` owns
 * the loop, the back-off policy, and the DLQ write.
 */
import https from 'https';
import { pool } from '../../db/connection';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('whatsapp');

export const REQUEST_TIMEOUT = 10_000; // 10 s per attempt
export const MAX_ATTEMPTS    = 3;

/**
 * Low-level HTTPS POST. Resolves the raw response body on 2xx; rejects with an
 * Error whose message contains "error <status>:" on any >= 400 so `parseStatus`
 * can classify it for the retry policy. Times out per REQUEST_TIMEOUT.
 */
export function postJson(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`WhatsApp API error ${res.statusCode}: ${data.slice(0, 300)}`));
          } else {
            resolve(data);
          }
        });
      },
    );

    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error(`WhatsApp API request timed out after ${REQUEST_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Run `attempt` with retry + exponential back-off. On success returns whatever
 * the attempt returns (the outbound message id, or null). On final failure
 * writes a DLQ row and re-throws — the caller's contract (a throw signals the
 * send ultimately failed) is unchanged from the original sender.ts.
 *
 * 4xx (except 429) are treated as permanent and break the loop immediately;
 * 429 backs off 60 s; other retryable errors back off 1s, 2s, … capped at 30s.
 */
export async function runWithRetry(
  to: string,
  dlqText: string,
  attempt: () => Promise<string | null>,
): Promise<string | null> {
  let lastErr: Error | undefined;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err as Error;
      const httpStatus = parseStatus(lastErr.message);

      // 4xx (except 429) are not retryable
      if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) break;

      if (i < MAX_ATTEMPTS) {
        const delayMs = httpStatus === 429 ? 60_000 : Math.min(1_000 * 2 ** (i - 1), 30_000);
        await sleep(delayMs);
      }
    }
  }

  await writeSendFailure(to, dlqText, lastErr);
  throw lastErr;
}

// ── Dead-letter log ───────────────────────────────────────────────────────────

export async function writeSendFailure(to: string, text: string, err: Error | undefined): Promise<void> {
  const errorMessage = err?.message ?? 'unknown';
  log.error({ to, errorMessage }, 'Send failed after all retries');
  try {
    await pool.query(
      `INSERT INTO "WhatsappAuditLog"
         ("userId", "whatsappNumber", "executionStatus", "errorMessage", "managerNotified")
       VALUES (NULL, $1, 'FAILED', $2, false)`,
      [to, `Send failure: ${errorMessage} — ${text.slice(0, 200)}`],
    );
  } catch (logErr) {
    log.error({ err: logErr }, 'Failed to write send-failure to audit log');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parseStatus(message: string): number {
  const m = (message ?? '').match(/error (\d+):/);
  return m ? parseInt(m[1], 10) : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
