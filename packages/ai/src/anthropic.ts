import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
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
   */
  async completeStructured<S extends z.ZodType>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    const model = req.model ?? this.defaultModel;
    const format = zodOutputFormat(req.schema);
    const params = {
      model,
      max_tokens: req.maxTokens ?? 16000,
      thinking: { type: 'adaptive' as const, display: 'summarized' as const },
      system: req.system,
      messages: [{ role: 'user' as const, content: req.prompt }],
      output_config: { format, ...(req.effort && { effort: req.effort }) },
    };
    const started = Date.now();
    req.onEvent?.({ type: 'request', model, effort: req.effort ?? null });

    const stream = this.getClient().messages.stream(params);
    for await (const ev of stream) {
      if (ev.type !== 'content_block_delta') continue;
      if (ev.delta.type === 'thinking_delta')
        req.onEvent?.({ type: 'thinking', text: ev.delta.thinking });
      else if (ev.delta.type === 'text_delta')
        req.onEvent?.({ type: 'output', text: ev.delta.text });
    }
    const msg = await stream.finalMessage();

    const responseText = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage = {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
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
    let data: z.infer<S>;
    try {
      data = req.schema.parse(JSON.parse(responseText));
    } catch {
      throw fail('Model output did not match the expected schema.');
    }
    return { data, provider: this.name, model: msg.model, usage, trace };
  }
}
