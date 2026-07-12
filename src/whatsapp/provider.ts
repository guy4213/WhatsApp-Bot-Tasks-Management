/**
 * WhatsApp transport provider abstraction.
 *
 * `sender.ts` is the single public entry every business module calls; it
 * delegates to the ACTIVE provider selected here by `WHATSAPP_PROVIDER`
 * (meta | greenapi). Swapping providers is an env-var change — no business
 * module (ai/, routes/, auth/, utils/, scheduler/, scripts/) imports a provider
 * directly.
 *
 * PR#1 introduces this seam with Meta as the only/default provider, so behavior
 * is unchanged. PR#2 adds the Green API provider and flips the default.
 *
 * The message shapes below are the single source of truth; sender.ts re-exports
 * them so existing importers keep working unchanged.
 */
import { metaProvider } from './providers/meta';

// ── Message shapes ─────────────────────────────────────────────────────────────

export interface TextMessage {
  to: string;   // E.164 without +, e.g. "972501234567"
  text: string;
}

export interface ButtonMessage {
  to: string;
  body: string;
  /** Up to 3 reply buttons (Meta). `id` is echoed back on tap; `title` ≤ 20 chars. */
  buttons: Array<{ id: string; title: string }>;
}

export interface ListMessage {
  to: string;
  body: string;           // main body text shown above the button
  buttonLabel: string;    // ≤ 20 chars — the label on the "open list" button
  sections: Array<{
    title?: string;       // section header (≤ 24 chars)
    rows: Array<{
      id: string;         // unique payload — the router matches on this
      title: string;      // ≤ 24 chars — line 1 of each row
      description?: string; // ≤ 72 chars — line 2 (optional)
    }>;
  }>;
}

/**
 * Dynamic per-send parameter for a template button component. `quick_reply`
 * buttons carry a `payload` (echoed back on tap); `url` buttons carry the URL
 * suffix (`text`) filling the button's variable.
 */
export interface TemplateButtonParam {
  subType: 'quick_reply' | 'url';
  index: number;   // 0-based button position in the template's buttons component
  payload: string; // quick_reply → the payload id; url → the URL suffix
}

export interface TemplateMessage {
  to: string;
  /** Template name as registered/approved in Meta WhatsApp Manager. */
  name: string;
  /** BCP-47 language code of the template, e.g. "he" or "en_US". */
  languageCode: string;
  /** Ordered body variables filling {{1}}, {{2}}, … (no newlines/tabs — sanitized). */
  bodyParams?: string[];
  /** Optional dynamic button parameters. */
  buttonParams?: TemplateButtonParam[];
}

// ── Provider interface ─────────────────────────────────────────────────────────

export interface WhatsAppProvider {
  /** Stable provider id, e.g. "meta" / "greenapi". */
  readonly name: string;
  /**
   * True when the provider can deliver Meta-approved templates (business-initiated
   * / out-of-window). Consumed by templates.notify() — a provider that returns
   * false forces the free-form fallback text for every proactive notification.
   */
  readonly supportsTemplates: boolean;
  /**
   * True when the provider globally rate-paces outbound (e.g. Green API's send
   * queue), so callers should coalesce consecutive sends to the same user where
   * possible to avoid stacking per-message delays.
   */
  readonly paced: boolean;
  sendText(msg: TextMessage): Promise<string | null>;
  sendButton(msg: ButtonMessage): Promise<string | null>;
  sendList(msg: ListMessage): Promise<string | null>;
  sendTemplate(msg: TemplateMessage): Promise<string | null>;
}

/**
 * Resolve the active provider from `WHATSAPP_PROVIDER`.
 *
 * PR#1: Meta is the only provider, and the default — an unset or unknown value
 * resolves to Meta so nothing changes operationally. PR#2 wires 'greenapi' and
 * flips the default.
 */
export function getProvider(): WhatsAppProvider {
  const name = (process.env.WHATSAPP_PROVIDER ?? 'meta').trim().toLowerCase();
  switch (name) {
    case 'meta':
      return metaProvider;
    default:
      return metaProvider;
  }
}
