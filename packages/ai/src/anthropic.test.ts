import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.ts';
import { AbortedError, type LLMEvent } from './types.ts';

/** A fake streamed response: raw events to iterate, then the final message. */
function fakeStream(events: unknown[], final: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    finalMessage: async () => final,
  };
}

const usage = (inp: number, out: number, searches = 0) => ({
  input_tokens: inp,
  output_tokens: out,
  server_tool_use: { web_search_requests: searches },
});

describe('AnthropicProvider with web search', () => {
  it('resumes after pause_turn, reports queries, and sums usage across rounds', async () => {
    const sent: { messages: unknown[]; tools?: unknown[] }[] = [];
    const paused = [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'acme news' } },
    ];
    const rounds = [
      fakeStream(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'server_tool_use', name: 'web_search', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"query":"acme ' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'news"}' },
          },
          { type: 'content_block_stop', index: 0 },
        ],
        {
          stop_reason: 'pause_turn',
          content: paused,
          usage: usage(1000, 10, 1),
          model: 'claude-opus-5',
        },
      ),
      fakeStream(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'web_search_tool_result', content: [{}, {}, {}] },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: '{"ok":true}' },
          },
        ],
        {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: usage(2000, 50, 1),
          model: 'claude-opus-5',
        },
      ),
    ];
    const provider = new AnthropicProvider('claude-opus-5');
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: (p: { messages: unknown[]; tools?: unknown[] }) => {
          sent.push({ messages: [...p.messages], tools: p.tools });
          return rounds.shift();
        },
      },
    };

    const events: LLMEvent[] = [];
    const res = await provider.completeStructured({
      system: 's',
      prompt: 'research acme',
      schema: z.object({ ok: z.boolean() }),
      webSearch: { maxUses: 3 },
      onEvent: (e) => events.push(e),
    });

    expect(res.data).toEqual({ ok: true });
    expect(res.usage).toMatchObject({ inputTokens: 3000, outputTokens: 60, webSearches: 2 });
    expect(events).toContainEqual({ type: 'search', query: 'acme news' });
    expect(events).toContainEqual({ type: 'searchResults', count: 3 });
    // Second request re-sends the paused assistant turn, with no extra user message.
    expect(sent).toHaveLength(2);
    expect(sent[1].messages).toEqual([
      { role: 'user', content: 'research acme' },
      { role: 'assistant', content: paused },
    ]);
    expect(sent[0].tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
    ]);
  });
});

describe('unconstrained JSON (schemas too large for the API grammar)', () => {
  const final = (text: string) => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 10 },
    model: 'claude-opus-5',
  });

  it('puts the schema in the prompt, skips output_config.format, and reads JSON wrapped in prose', async () => {
    let sent: Record<string, unknown> = {};
    const provider = new AnthropicProvider('claude-opus-5');
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: (p: Record<string, unknown>) => {
          sent = p;
          return fakeStream([], final('Here you go:\n```json\n{"ok": true}\n```'));
        },
      },
    };
    const res = await provider.completeStructured({
      system: 'sys',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
      constrained: false,
      effort: 'low',
    });
    expect(res.data).toEqual({ ok: true });
    expect(String(sent.system)).toMatch(/JSON Schema/);
    expect(sent.output_config).toEqual({ effort: 'low' });
  });

  it('sends Haiku 4.5 neither adaptive thinking nor an effort setting', async () => {
    let sent: Record<string, unknown> = {};
    const provider = new AnthropicProvider('claude-opus-5');
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: (p: Record<string, unknown>) => {
          sent = p;
          return fakeStream([], final('{"ok": true}'));
        },
      },
    };
    await provider.completeStructured({
      system: 's',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
    expect(sent.model).toBe('claude-haiku-4-5');
    expect(sent.thinking).toBeUndefined();
    expect(sent.output_config).not.toHaveProperty('effort');
    expect(sent.output_config).toHaveProperty('format');
  });

  it('repairs a reply that does not match the schema with one small follow-up call', async () => {
    const provider = new AnthropicProvider('claude-opus-5');
    let repairPrompt = '';
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: () => fakeStream([], final('{"ok": "yes"}')),
        create: async (p: { messages: { content: string }[]; tools?: unknown }) => {
          repairPrompt = p.messages[0].content;
          expect(p.tools).toBeUndefined();
          return final('{"ok": true}');
        },
      },
    };
    const res = await provider.completeStructured({
      system: 's',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
      constrained: false,
    });
    expect(res.data).toEqual({ ok: true });
    expect(res.usage?.inputTokens).toBe(200);
    expect(repairPrompt).toMatch(/Validation errors/);
  });

  it('turns API errors into readable LLMErrors', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const provider = new AnthropicProvider('claude-opus-5');
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: () => {
          throw new Anthropic.BadRequestError(
            400,
            {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'The compiled grammar is too large',
              },
            },
            undefined,
            new Headers(),
          );
        },
      },
    };
    await expect(
      provider.completeStructured({
        system: 's',
        prompt: 'p',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow(/Anthropic API error 400: The compiled grammar is too large/);
  });
});

describe('AnthropicProvider.completeBlocks', () => {
  const schema = z.object({ ok: z.boolean() });
  const start = (inp: number, cacheRead: number, cacheWrite: number) => ({
    type: 'message_start',
    message: {
      usage: {
        input_tokens: inp,
        output_tokens: 1,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  });

  function providerWith(stream: (p: Record<string, unknown>, o?: { signal?: AbortSignal }) => unknown) {
    const provider = new AnthropicProvider('claude-sonnet-5-5');
    (provider as unknown as { client: unknown }).client = { messages: { stream } };
    return provider;
  }

  it('puts cache_control on the flagged blocks only, forwards the signal, and streams output', async () => {
    let sent: Record<string, unknown> | undefined;
    let sentSignal: AbortSignal | undefined;
    const provider = providerWith((p, o) => {
      sent = p;
      sentSignal = o?.signal;
      return fakeStream(
        [
          start(300, 9000, 0),
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"ok":' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'true}' } },
          { type: 'message_delta', usage: { output_tokens: 12 } },
        ],
        {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: {
            input_tokens: 300,
            output_tokens: 12,
            cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 0,
          },
          model: 'claude-sonnet-5-5',
        },
      );
    });
    const out: string[] = [];
    const controller = new AbortController();
    const res = await provider.completeBlocks({
      model: 'claude-sonnet-5-5',
      schema,
      system: [{ text: 'rules' }, { text: 'context', cache: true }],
      content: [{ text: 'turn one', cache: true }, { text: 'tail' }],
      effort: 'low',
      signal: controller.signal,
      onEvent: (e) => e.type === 'output' && out.push(e.text),
    });

    expect(res.data).toEqual({ ok: true });
    expect(res.usage).toMatchObject({ inputTokens: 300, cacheReadTokens: 9000, outputTokens: 12 });
    expect(out.join('')).toBe('{"ok":true}');
    expect(sentSignal).toBe(controller.signal);
    const system = sent!.system as { cache_control?: unknown }[];
    const content = (sent!.messages as { content: { cache_control?: unknown }[] }[])[0].content;
    expect(system.map((b) => Boolean(b.cache_control))).toEqual([false, true]);
    expect(content.map((b) => Boolean(b.cache_control))).toEqual([true, false]);
    expect(sent).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
  });

  it('turns an abort into AbortedError that still carries the tokens already spent', async () => {
    const provider = providerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield start(500, 8000, 200);
        throw new Anthropic.APIUserAbortError();
      },
      finalMessage: async () => {
        throw new Anthropic.APIUserAbortError();
      },
    }));
    const err = await provider
      .completeBlocks({
        model: 'claude-sonnet-5-5',
        schema,
        system: [{ text: 'rules' }],
        content: [{ text: 'x' }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortedError);
    expect((err as AbortedError).usage).toMatchObject({
      inputTokens: 500,
      cacheReadTokens: 8000,
      cacheWriteTokens: 200,
    });
  });
});
