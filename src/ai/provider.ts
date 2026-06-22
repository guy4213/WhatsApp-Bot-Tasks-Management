/**
 * Provider-agnostic LLM interface.
 *
 * Both adapters force a single structured tool/function call and return its
 * arguments as a plain object. Selected via env:
 *   AI_PROVIDER = openai | anthropic   (unset → disabled / dev)
 *   AI_MODEL    = model name           (defaults per provider)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('ai-provider');

export interface StructuredRequest {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
}

export interface LLMProvider {
  readonly name: string;
  /** Returns the validated-by-the-model tool arguments as a raw object. */
  emitStructured(req: StructuredRequest): Promise<Record<string, unknown>>;
}

let cached: LLMProvider | null | undefined;

/** Returns the configured provider, or null when AI is not configured. */
export function getProvider(): LLMProvider | null {
  if (cached !== undefined) return cached;

  const provider = (process.env.AI_PROVIDER ?? '').toLowerCase();
  if (provider === 'openai') {
    cached = makeOpenAIProvider();
  } else if (provider === 'anthropic') {
    cached = makeAnthropicProvider();
  } else {
    if (provider) log.warn({ provider }, 'Unknown AI_PROVIDER — AI disabled');
    cached = null;
  }
  return cached;
}

/** Test seam: override the provider (or reset with undefined). */
export function setProvider(p: LLMProvider | null | undefined): void {
  cached = p;
}

// ── OpenAI adapter ────────────────────────────────────────────────────────────

function makeOpenAIProvider(): LLMProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI_PROVIDER=openai but OPENAI_API_KEY is not set');
  const model = process.env.AI_MODEL ?? 'gpt-4o-mini';

  return {
    name: `openai:${model}`,
    async emitStructured(req) {
      // Lazy import keeps the SDK out of the startup path when AI is disabled
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey, timeout: 20_000, maxRetries: 2 });

      const res = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        tools: [{
          type: 'function',
          function: { name: req.toolName, description: req.toolDescription, parameters: req.schema },
        }],
        tool_choice: { type: 'function', function: { name: req.toolName } },
      });

      const call = res.choices[0]?.message?.tool_calls?.[0];
      if (!call || call.type !== 'function') {
        throw new Error('OpenAI did not return a tool call');
      }
      return JSON.parse(call.function.arguments) as Record<string, unknown>;
    },
  };
}

// ── Anthropic adapter ─────────────────────────────────────────────────────────

function makeAnthropicProvider(): LLMProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
  const model = process.env.AI_MODEL ?? 'claude-haiku-4-5';

  return {
    name: `anthropic:${model}`,
    async emitStructured(req) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 2 });

      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        temperature: 0,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        tools: [{ name: req.toolName, description: req.toolDescription, input_schema: req.schema as never }],
        tool_choice: { type: 'tool', name: req.toolName },
      });

      const block = res.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error('Anthropic did not return a tool_use block');
      }
      return block.input as Record<string, unknown>;
    },
  };
}
