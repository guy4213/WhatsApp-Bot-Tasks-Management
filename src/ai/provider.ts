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

// ── Agentic multi-turn tool loop (AI-native free text) ──────────────────────────

/** A tool the model may call during the loop. */
export interface LoopTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  schema: Record<string, unknown>;
}

/** One prior conversational turn (oldest→newest) fed into the loop. */
export interface LoopHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool call the model wants executed. */
export interface LoopToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LoopRequest {
  system: string;
  /** Prior turns (oldest→newest), excluding the current user message. */
  history: LoopHistoryTurn[];
  /** The current user message. */
  user: string;
  tools: LoopTool[];
  /** Max model round-trips before forcing a text answer. Default 6. */
  maxIterations?: number;
  /**
   * Executes a tool call and returns a string result the model will read.
   * Throwing is caught and surfaced to the model as an error string.
   */
  runTool: (call: LoopToolCall) => Promise<string>;
}

export interface LoopResult {
  /** The model's final natural-language answer. */
  text: string;
  /** Number of tool calls executed across the whole loop. */
  toolCallCount: number;
}

export interface LLMProvider {
  readonly name: string;
  /** Returns the validated-by-the-model tool arguments as a raw object. */
  emitStructured(req: StructuredRequest): Promise<Record<string, unknown>>;
  /**
   * Runs a multi-turn tool-calling loop: the model may call tools (via
   * `req.runTool`) across several round-trips, then returns a final text answer.
   * This is the AI-native free-text path.
   */
  runLoop(req: LoopRequest): Promise<LoopResult>;
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

    async runLoop(req) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 2 });
      const maxIterations = req.maxIterations ?? 6;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [
        { role: 'system', content: req.system },
        ...req.history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: req.user },
      ];

      const tools = req.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));

      let toolCallCount = 0;

      for (let i = 0; i < maxIterations; i++) {
        // On the final allowed iteration, drop tools so the model MUST answer in text.
        const lastTurn = i === maxIterations - 1;
        const res = await client.chat.completions.create({
          model,
          temperature: 0,
          messages,
          ...(lastTurn ? {} : { tools, tool_choice: 'auto' as const }),
        });

        const msg = res.choices[0]?.message;
        if (!msg) throw new Error('OpenAI returned no message');

        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) {
          return { text: msg.content ?? '', toolCallCount };
        }

        // Echo the assistant's tool-call turn, then append each tool result.
        messages.push(msg);
        for (const c of calls) {
          if (c.type !== 'function') continue;
          toolCallCount++;
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            input = {};
          }
          let result: string;
          try {
            result = await req.runTool({ id: c.id, name: c.function.name, input });
          } catch (err) {
            result = `ERROR: ${(err as Error).message}`;
          }
          messages.push({ role: 'tool', tool_call_id: c.id, content: result });
        }
      }

      // Exhausted iterations without a text answer — return a safe fallback.
      return { text: '', toolCallCount };
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

    async runLoop(req) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });
      const maxIterations = req.maxIterations ?? 6;

      const tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema as never,
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [
        ...req.history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: req.user },
      ];

      let toolCallCount = 0;

      for (let i = 0; i < maxIterations; i++) {
        const lastTurn = i === maxIterations - 1;
        const res = await client.messages.create({
          model,
          max_tokens: 1500,
          temperature: 0,
          system: req.system,
          messages,
          ...(lastTurn ? {} : { tools }),
        });

        const toolUses = res.content.filter((b) => b.type === 'tool_use');
        if (toolUses.length === 0) {
          const textBlock = res.content.find((b) => b.type === 'text');
          return {
            text: textBlock && textBlock.type === 'text' ? textBlock.text : '',
            toolCallCount,
          };
        }

        // Echo the assistant's turn (text + tool_use blocks), then feed tool_results.
        messages.push({ role: 'assistant', content: res.content });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolResults: any[] = [];
        for (const block of toolUses) {
          if (block.type !== 'tool_use') continue;
          toolCallCount++;
          let result: string;
          try {
            result = await req.runTool({
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          } catch (err) {
            result = `ERROR: ${(err as Error).message}`;
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      return { text: '', toolCallCount };
    },
  };
}
