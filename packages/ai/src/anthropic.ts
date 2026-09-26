import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import {
  LLMError,
  type LLMProvider,
  type StructuredRequest,
  type StructuredResponse,
} from './types.ts';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic | undefined;

  constructor(readonly defaultModel: string) {}

  private getClient(): Anthropic {
    // Created lazily so the app still boots without credentials.
    if (!this.client && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new LLMError(
        'No Anthropic credentials: set ANTHROPIC_API_KEY in .env and restart the server.',
      );
    }
    this.client ??= new Anthropic();
    return this.client;
  }

  async complete(req: { system: string; prompt: string; model?: string; maxTokens?: number }) {
    const response = await this.getClient().messages.create({
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens ?? 16000,
      thinking: { type: 'adaptive' },
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    });
    if (response.stop_reason === 'refusal') throw new LLMError('The model declined this request.');
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  /**
   * Streams so callers can show thinking and output as they arrive. Thinking comes back as
   * readable summaries (display: 'summarized'); the raw chain of thought is never returned.
   * With webSearch, the server runs searches itself; a 'pause_turn' means its loop hit its
   * iteration limit, so the turn is re-sent as-is and it resumes.
   */
  async completeStructured<S extends z.ZodType>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    const model = req.model ?? this.defaultModel;
    const constrained = req.constrained !== false;
    // Older, smaller models (Haiku 4.5) take neither adaptive thinking nor an effort setting.
    const basic = /haiku-4/.test(model);
    const effort = basic ? undefined : req.effort;
    const format = zodOutputFormat(req.schema);
    const jsonSchema = JSON.stringify(z.toJSONSchema(req.schema));
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.prompt }];
    const params = {
      model,
      max_tokens: req.maxTokens ?? 16000,
      ...(!basic && { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }),
      system: constrained
        ? req.system
        : `${req.system}\n\nOutput format: when you are done, reply with ONLY a JSON object — no prose before or after, no code fences — matching this JSON Schema:\n${jsonSchema}`,
      messages,
      ...(req.webSearch && {
        tools: [
          {
            type: 'web_search_20260209' as const,
            name: 'web_search' as const,
            max_uses: req.webSearch.maxUses,
          },
        ],
      }),
      ...(constrained
        ? { output_config: { format, ...(effort && { effort }) } }
        : effort && { output_config: { effort } }),
    };
    const started = Date.now();
    req.onEvent?.({ type: 'request', model, effort: effort ?? null });

    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    };
    let msg!: Anthropic.Message;
    try {
      for (let round = 0; ; round++) {
        const stream = this.getClient().messages.stream({ ...params, messages });
        // server_tool_use inputs stream as JSON fragments; collect them per block to report queries.
        const toolInput = new Map<number, { name: string; json: string }>();
        for await (const ev of stream) {
          if (ev.type === 'content_block_start') {
            const b = ev.content_block;
            if (b.type === 'server_tool_use') {
              const q = (b.input as { query?: string } | undefined)?.query;
              if (b.name === 'web_search' && q) req.onEvent?.({ type: 'search', query: q });
              // Otherwise the input streams as JSON fragments; collect them to report the query.
              else toolInput.set(ev.index, { name: b.name, json: '' });
            } else if (b.type === 'web_search_tool_result')
              req.onEvent?.({
                type: 'searchResults',
                count: Array.isArray(b.content) ? b.content.length : 0,
              });
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'thinking_delta')
              req.onEvent?.({ type: 'thinking', text: ev.delta.thinking });
            else if (ev.delta.type === 'text_delta')
              req.onEvent?.({ type: 'output', text: ev.delta.text });
            else if (ev.delta.type === 'input_json_delta') {
              const t = toolInput.get(ev.index);
              if (t) t.json += ev.delta.partial_json;
            }
          } else if (ev.type === 'content_block_stop') {
            const t = toolInput.get(ev.index);
            if (t?.name === 'web_search') {
              try {
                const q = (JSON.parse(t.json || '{}') as { query?: string }).query;
                if (q) req.onEvent?.({ type: 'search', query: q });
              } catch {
                // partial/odd input — the query just isn't shown
              }
            }
          }
        }
        msg = await stream.finalMessage();
        usage.inputTokens += msg.usage.input_tokens;
        usage.outputTokens += msg.usage.output_tokens;
        usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += msg.usage.cache_creation_input_tokens ?? 0;
        usage.webSearches += msg.usage.server_tool_use?.web_search_requests ?? 0;
        if (msg.stop_reason !== 'pause_turn' || round >= 5) break;
        // Resume: send the paused assistant turn back unchanged (no extra user message).
        messages.push({ role: 'assistant', content: msg.content });
      }
    } catch (e) {
      throw apiError(e);
    }

    const responseText = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    req.onEvent?.({ type: 'usage', usage });
    const trace = {
      // JSON.stringify drops the format's parse helper, leaving the JSON Schema that was sent.
      request: JSON.parse(JSON.stringify(params)),
      responseText,
      thinking: msg.content
        .filter((b) => b.type === 'thinking')
        .map((b) => b.thinking)
        .join('\n\n'),
      stopReason: msg.stop_reason,
      durationMs: Date.now() - started,
    };
    const fail = (message: string) => Object.assign(new LLMError(message), { trace });

    if (msg.stop_reason === 'refusal') throw fail('The model declined this request.');
    if (msg.stop_reason === 'max_tokens') throw fail('Response was cut off (max_tokens).');
    if (constrained) {
      try {
        return {
          data: req.schema.parse(JSON.parse(responseText)),
          provider: this.name,
          model: msg.model,
          usage,
          trace,
        };
      } catch {
        throw fail('Model output did not match the expected schema.');
      }
    }

    // Unconstrained: validate, and if it doesn't fit, one small repair call (no tools).
    let checked = req.schema.safeParse(parseLooseJson(responseText));
    if (!checked.success) {
      let fixed: Anthropic.Message;
      try {
        fixed = await this.getClient().messages.create({
          model,
          max_tokens: req.maxTokens ?? 16000,
          system:
            'You repair JSON. Return ONLY the corrected JSON object — no prose, no code fences. Keep all content; change only what is needed to satisfy the schema (use null or [] for anything missing).',
          messages: [
            {
              role: 'user',
              content: `JSON Schema:\n${jsonSchema}\n\nValidation errors:\n${z.prettifyError(checked.error)}\n\nJSON to fix:\n${responseText}`,
            },
          ],
          output_config: { effort: 'low' },
        });
      } catch (e) {
        throw apiError(e);
      }
      usage.inputTokens += fixed.usage.input_tokens;
      usage.outputTokens += fixed.usage.output_tokens;
      const text = fixed.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      trace.responseText = text;
      checked = req.schema.safeParse(parseLooseJson(text));
      if (!checked.success)
        throw fail('Model output did not match the expected schema (after one repair).');
    }
    return {
      data: checked.data as z.infer<S>,
      provider: this.name,
      model: msg.model,
      usage,
      trace,
    };
  }
}

/** JSON from a reply that may wrap it in prose or code fences. */
export function parseLooseJson(text: string): unknown {
  const t = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Anthropic API errors → LLMError with the API's own message (shown in the UI as-is). */
function apiError(e: unknown): Error {
  if (e instanceof Anthropic.APIError) {
    const detail =
      (e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message;
    return new LLMError(`Anthropic API error ${e.status ?? ''}: ${detail}`.trim());
  }
  return e as Error;
}
