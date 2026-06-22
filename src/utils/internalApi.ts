/**
 * Helper for calling the bot's own HTTP routes (the webhook and AI router run
 * in-process but invoke the task routes over localhost so the full pipeline —
 * validation, pending-action creation, confirm prompts, audit — always runs).
 *
 * Carries the caller's phone (x-wa-from) and the internal shared secret.
 */
import http from 'http';
import { moduleLogger } from './logger';
import { sendTextMessage } from '../whatsapp/sender';

const log = moduleLogger('internalApi');
const TIMEOUT = 15_000;

export interface InternalResponse {
  status: number;
  responseBody: string;
}

export function callInternal(
  from: string,
  method: string,
  path: string,
  body: unknown,
): Promise<InternalResponse> {
  const data   = JSON.stringify(body);
  const port   = parseInt(process.env.PORT ?? '3000', 10);
  const secret = process.env.INTERNAL_API_SECRET ?? '';

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'x-wa-from': from,
          'x-internal-secret': secret,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 500, responseBody }));
      },
    );

    req.setTimeout(TIMEOUT, () => {
      req.destroy(new Error(`Internal request to ${path} timed out after ${TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * POST to an internal route; on a 4xx/5xx, send the error message to the user
 * over WhatsApp. Returns true on success (2xx), false otherwise.
 */
export async function dispatchInternal(
  from: string,
  path: string,
  body: unknown,
  method = 'POST',
): Promise<boolean> {
  try {
    const { status, responseBody } = await callInternal(from, method, path, body);
    if (status >= 400) {
      let msg = 'אירעה שגיאה, אנא נסה שוב.';
      try {
        const parsed = JSON.parse(responseBody) as { error?: string };
        if (parsed.error) msg = parsed.error;
      } catch { /* non-JSON body */ }
      await sendTextMessage({ to: from, text: `שגיאה: ${msg}` });
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err, path }, 'Internal dispatch failed');
    await sendTextMessage({ to: from, text: 'שגיאת שרת זמנית, אנא נסה שוב בעוד מספר דקות.' });
    return false;
  }
}
