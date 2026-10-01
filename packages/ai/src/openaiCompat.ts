import { z } from 'zod';
import { parseLooseJson } from './json.ts';
import {
  LLMError,
  type LLMProvider,
  type StructuredRequest,
  type StructuredResponse,
  type TokenUsage,
} from './types.ts';

/** The provider said "slow down" (HTTP 429): a free tier's per-minute or per-day limit. */
export class RateLimitError extends LLMError {
  constructor(
    message: string,
    /** Seconds the provider asked to wait; null when it didn't say. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
  }
}

/**
 * Seconds to wait before trying again: the Retry-After header, else the wait the message names
 * (Groq leaves the header out of tokens-per-minute limits: "Please try again in 4.2375s",
 * "in 1m12.5s"). Null when neither says.
 */
export function retryAfter(header: string | null, message: string): number | null {
  const h = Number(header);
  if (header && Number.isFinite(h) && h > 0) return h;
  const m = message.match(/try again in\s+(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  if (!m || (!m[1] && !m[2])) return null;
  const s = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return s > 0 ? Math.ceil(s) : null;
}

interface ChatReply {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/**
 * Any service that speaks the OpenAI chat-completions API: Groq, Gemini, OpenRouter, a local
 * Ollama. Used for small structured jobs on free models, so it asks for JSON, describes the
 * schema in the prompt, checks the reply and repairs it once if it doesn't fit.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    name: string;
    baseUrl: string;
    model: string;
    apiKey?: string | null;
    fetchFn?: typeof fetch;
  }) {
    this.name = opts.name;
    this.defaultModel = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey?.trim() || null;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async chat(body: Record<string, unknown>): Promise<ChatReply> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new LLMError(`Couldn't reach ${this.name} (${(e as Error).message}).`);
    }
    const text = await res.text();
    let reply: ChatReply = {};
    try {
      reply = JSON.parse(text) as ChatReply;
    } catch {
      // not JSON: reported below with the status
    }
    if (res.ok) return reply;
    const detail =
      (typeof reply.error === 'string' ? reply.error : reply.error?.message) ??
      text.slice(0, 300) ??
      '';
    if (res.status === 429) {
      throw new RateLimitError(
        `${this.name} rate limit reached: ${detail}`.trim(),
        retryAfter(res.headers.get('retry-after'), detail),
      );
    }
    // A model the account can't use: say what to do, not just the code.
    if (res.status === 404 && /model/i.test(detail))
      throw Object.assign(
        new LLMError(
          `${this.name} doesn't offer that model to your account (${detail}). Pick another model name on the Watchlist page.`,
        ),
        { status: res.status },
      );
    throw Object.assign(new LLMError(`${this.name} API error ${res.status}: ${detail}`.trim()), {
      status: res.status,
    });
  }

  /** Asks for JSON mode; a model that doesn't offer it is asked again without. */
  private async chatJson(body: Record<string, unknown>): Promise<ChatReply> {
    try {
      return await this.chat({ ...body, response_format: { type: 'json_object' } });
    } catch (e) {
      if ((e as { status?: number }).status !== 400) throw e;
      return this.chat(body);
    }
  }

  async complete(req: { system: string; prompt: string; model?: string; maxTokens?: number }) {
    const reply = await this.chat({
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens ?? 4000,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
    });
    return reply.choices?.[0]?.message?.content ?? '';
  }

  async completeStructured<S extends z.ZodType>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    const model = req.model ?? this.defaultModel;
    const jsonSchema = JSON.stringify(z.toJSONSchema(req.schema));
    const body = {
      model,
      temperature: 0,
      max_tokens: req.maxTokens ?? 4000,
      messages: [
        {
          role: 'system',
          content: `${req.system}\n\nOutput format: reply with ONLY a JSON object — no prose before or after, no code fences — matching this JSON Schema:\n${jsonSchema}`,
        },
        { role: 'user', content: req.prompt },
      ],
    };
    const started = Date.now();
    req.onEvent?.({ type: 'request', model, effort: null });
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const count = (r: ChatReply) => {
      usage.inputTokens += r.usage?.prompt_tokens ?? 0;
      usage.outputTokens += r.usage?.completion_tokens ?? 0;
    };

    const first = await this.chatJson(body);
    count(first);
    let responseText = first.choices?.[0]?.message?.content ?? '';
    const trace = {
      request: body as unknown,
      responseText,
      thinking: '',
      stopReason: first.choices?.[0]?.finish_reason ?? null,
      durationMs: Date.now() - started,
    };
    const fail = (message: string) => Object.assign(new LLMError(message), { trace });

    let checked = req.schema.safeParse(parseLooseJson(responseText));
    if (!checked.success) {
      // One small repair call, as the Anthropic provider does for unconstrained replies.
      let fixed: ChatReply;
      try {
        fixed = await this.chatJson({
          model,
          temperature: 0,
          max_tokens: req.maxTokens ?? 4000,
          messages: [
            {
              role: 'system',
              content:
                'You repair JSON. Return ONLY the corrected JSON object — no prose, no code fences. Keep all content; change only what is needed to satisfy the schema (use null or [] for anything missing).',
            },
            {
              role: 'user',
              content: `JSON Schema:\n${jsonSchema}\n\nValidation errors:\n${z.prettifyError(checked.error)}\n\nJSON to fix:\n${responseText}`,
            },
          ],
        });
      } catch (e) {
        throw Object.assign(e as Error, { trace });
      }
      count(fixed);
      responseText = fixed.choices?.[0]?.message?.content ?? '';
      trace.responseText = responseText;
      trace.durationMs = Date.now() - started;
      checked = req.schema.safeParse(parseLooseJson(responseText));
      if (!checked.success)
        throw fail('Model output did not match the expected schema (after one repair).');
    }
    req.onEvent?.({ type: 'usage', usage });
    return {
      data: checked.data as z.infer<S>,
      provider: this.name,
      model: first.model ?? model,
      usage,
      trace,
    };
  }
}
