/**
 * Inbound voice (audio) pipeline — Meta Cloud API media download + Whisper STT.
 *
 * Meta's WhatsApp Cloud API delivers voice notes as a two-step download:
 *   1. GET /v{X}/{mediaId}      → JSON envelope with a signed `url`
 *   2. GET {url}                → the raw audio bytes (OGG/Opus by default)
 * Both calls carry the same Bearer token as the outbound sender.
 *
 * The transcript is fed back into the normal text-routing path in
 * `src/routes/webhook.ts`, so a Hebrew voice note becomes indistinguishable
 * from a typed message downstream (menu, AI intent parser, dispatchInternal).
 *
 * K7 (see TASKS.md §0): STT provider is OpenAI Whisper API. Hebrew is passed
 * as a language hint. Missing `OPENAI_API_KEY` degrades gracefully — the
 * caller sends a fallback reply, and the app does NOT crash at startup.
 */
import https from 'https';
import { moduleLogger } from '../utils/logger';
import { updateTranscribedMessage } from '../utils/auditLog';

const log = moduleLogger('voice');

const API_VERSION      = process.env.WHATSAPP_API_VERSION ?? 'v19.0';
const ACCESS_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
const REQUEST_TIMEOUT  = 20_000;
const WHISPER_URL      = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL    = 'whisper-1';
const WHISPER_LANG     = 'he';

// ── Public API ──────────────────────────────────────────────────────────────

export interface DownloadedAudio {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Two-step Meta media download. Reuses the same Bearer token the outbound
 * sender uses (`WHATSAPP_ACCESS_TOKEN`) and the same Graph API version
 * (`WHATSAPP_API_VERSION`), so credential rotation happens in one place.
 */
export async function downloadWhatsappAudio(mediaId: string): Promise<DownloadedAudio> {
  if (!ACCESS_TOKEN) {
    throw new Error('Missing WHATSAPP_ACCESS_TOKEN — cannot download media');
  }

  const envelopeUrl = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(mediaId)}`;
  const envelope = await httpGetJson(envelopeUrl, {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
  });

  const url = (envelope as { url?: unknown }).url;
  if (typeof url !== 'string' || !url) {
    throw new Error('Meta media envelope has no url field');
  }

  const { buffer, contentType } = await httpGetBinary(url, {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
  });
  return { buffer, mimeType: contentType || 'audio/ogg' };
}

/**
 * POST multipart/form-data to OpenAI Whisper. Uses `response_format=text` so
 * the body IS the transcript (no JSON envelope). Non-2xx throws with the raw
 * response body — the caller logs it (never propagates it to the user).
 */
export async function transcribeWithWhisper(audio: DownloadedAudio): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const filename = filenameForMime(audio.mimeType);
  const { body, contentType } = buildMultipartBody([
    { name: 'file', filename, contentType: audio.mimeType, value: audio.buffer },
    { name: 'model', value: WHISPER_MODEL },
    { name: 'language', value: WHISPER_LANG },
    { name: 'response_format', value: 'text' },
  ]);

  const { statusCode, body: respBody } = await httpPostRaw(WHISPER_URL, body, {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': contentType,
    'Content-Length': body.length.toString(),
  });

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Whisper API error ${statusCode}: ${respBody.toString('utf8').slice(0, 300)}`);
  }
  return respBody.toString('utf8').trim();
}

export interface VoiceMessage {
  mediaId: string;
  from: string;
  /** ID of the initial WhatsappAuditLog row for this inbound message (if any). */
  auditLogId?: string;
  /**
   * Provider seam: Green API delivers a direct, pre-authorized media URL. When
   * present, the two-step Meta media download is bypassed (see
   * downloadAudioFromUrl). Meta path: undefined.
   */
  downloadUrl?: string;
}

/**
 * Direct media download (Green API). The URL is already authorized by Green API,
 * so no Bearer token is attached. Mirrors the Meta binary-download plumbing.
 */
export async function downloadAudioFromUrl(url: string): Promise<DownloadedAudio> {
  const { buffer, contentType } = await httpGetBinary(url, {});
  return { buffer, mimeType: contentType || 'audio/ogg' };
}

/**
 * End-to-end voice orchestrator. Returns the transcript on success, or `null`
 * on any failure (network, provider error, missing key). Never throws — the
 * caller decides how to respond to the user.
 */
export async function handleVoiceMessage(msg: VoiceMessage): Promise<string | null> {
  const { mediaId, from, auditLogId } = msg;
  log.info({ mediaId, from }, 'Voice message received');

  if (!process.env.OPENAI_API_KEY) {
    log.warn({ mediaId, from }, 'OPENAI_API_KEY not set — voice transcription disabled');
    return null;
  }

  let audio: DownloadedAudio;
  try {
    // Green API supplies a direct URL; Meta requires the two-step token'd download.
    audio = msg.downloadUrl
      ? await downloadAudioFromUrl(msg.downloadUrl)
      : await downloadWhatsappAudio(mediaId);
  } catch (err) {
    log.error({ err, mediaId, from }, 'Voice download failed');
    return null;
  }

  let transcript: string;
  try {
    transcript = await transcribeWithWhisper(audio);
  } catch (err) {
    log.error({ err, mediaId, from }, 'Voice transcription failed');
    return null;
  }

  if (!transcript) {
    log.warn({ mediaId, from }, 'Empty transcript from Whisper');
    return null;
  }

  if (auditLogId) {
    await updateTranscribedMessage(auditLogId, transcript);
  }

  log.info({ mediaId, from, transcriptLength: transcript.length }, 'Voice transcription complete');
  return transcript;
}

// ── Low-level HTTP (mirrors sender.ts style — raw https, no extra deps) ─────

interface HttpHeaders {
  [name: string]: string;
}

function httpGetJson(url: string, headers: HttpHeaders): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Media envelope error ${res.statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Media envelope: invalid JSON — ${(err as Error).message}`));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error(`Media envelope request timed out after ${REQUEST_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGetBinary(
  url: string,
  headers: HttpHeaders,
): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Media download error ${res.statusCode}: ${buffer.toString('utf8').slice(0, 300)}`));
            return;
          }
          const contentType = (res.headers['content-type'] as string | undefined) ?? '';
          resolve({ buffer, contentType });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error(`Media download timed out after ${REQUEST_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPostRaw(
  url: string,
  body: Buffer,
  headers: HttpHeaders,
): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error(`Whisper request timed out after ${REQUEST_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Multipart form-data builder (RFC 7578) ──────────────────────────────────

interface MultipartField {
  name: string;
  /** String for text fields, Buffer for binary. */
  value: string | Buffer;
  /** File name (binary fields only). */
  filename?: string;
  /** MIME type (binary fields only; defaults to application/octet-stream). */
  contentType?: string;
}

export function buildMultipartBody(fields: MultipartField[]): {
  body: Buffer;
  contentType: string;
  boundary: string;
} {
  const boundary = `----whatsappBotBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const parts: Buffer[] = [];
  for (const f of fields) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) header += `; filename="${f.filename}"`;
    header += '\r\n';
    if (f.filename) {
      header += `Content-Type: ${f.contentType ?? 'application/octet-stream'}\r\n`;
    }
    header += '\r\n';
    parts.push(Buffer.from(header, 'utf8'));
    parts.push(typeof f.value === 'string' ? Buffer.from(f.value, 'utf8') : f.value);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary,
  };
}

/**
 * Pick a sensible filename extension for Whisper based on the Meta-reported
 * mime type. Whisper uses the filename hint to pick a decoder — an OGG/Opus
 * voice note delivered as `application/octet-stream` would be rejected.
 */
function filenameForMime(mimeType: string): string {
  const mt = mimeType.toLowerCase();
  if (mt.includes('ogg')) return 'audio.ogg';
  if (mt.includes('mpeg') || mt.includes('mp3')) return 'audio.mp3';
  if (mt.includes('mp4') || mt.includes('m4a') || mt.includes('aac')) return 'audio.m4a';
  if (mt.includes('wav')) return 'audio.wav';
  if (mt.includes('webm')) return 'audio.webm';
  return 'audio.ogg'; // WhatsApp voice notes are OGG/Opus by default
}
