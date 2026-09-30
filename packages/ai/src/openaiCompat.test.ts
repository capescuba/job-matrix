import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseLooseJson } from './json.ts';
import { OpenAICompatProvider, RateLimitError } from './openaiCompat.ts';

const schema = z.object({ verdict: z.enum(['yes', 'maybe', 'no']), reason: z.string() });

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** A fake chat-completions endpoint: replies in order, recording each request. */
function fakeApi(replies: Reply[]) {
  const sent: { url: string; auth: string | null; body: Record<string, any> }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    });
    const r = replies.shift() ?? { status: 500, body: { error: { message: 'no more replies' } } };
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers,
    });
  }) as typeof fetch;
  return { fetchFn, sent };
}

const answer = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  body: { model: 'llama-x', choices: [{ message: { content }, finish_reason: 'stop' }], usage },
});

const provider = (fetchFn: typeof fetch) =>
  new OpenAICompatProvider({
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/',
    model: 'llama-x',
    apiKey: 'gsk_secret',
    fetchFn,
  });

describe('parseLooseJson', () => {
  it('reads JSON inside code fences, prose or after a <think> block', () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
    expect(parseLooseJson('<think>maybe {x}</think>\n{"a":1}')).toEqual({ a: 1 });
    expect(parseLooseJson('no json here')).toBeUndefined();
  });
});

describe('OpenAICompatProvider', () => {
  it('asks for JSON with the schema in the prompt, and returns the checked reply with usage', async () => {
    const api = fakeApi([answer('{"verdict":"yes","reason":"TPM role in SF"}')]);
    const res = await provider(api.fetchFn).completeStructured({
      system: 'Screen this.',
      prompt: 'A job',
      schema,
      maxTokens: 300,
    });
    expect(res).toMatchObject({
      data: { verdict: 'yes', reason: 'TPM role in SF' },
      provider: 'Groq',
      model: 'llama-x',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      auth: 'Bearer gsk_secret',
      body: {
        model: 'llama-x',
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      },
    });
    expect(api.sent[0]!.body.messages[0].content).toContain('"verdict"');
    expect(api.sent[0]!.body.messages[1]).toEqual({ role: 'user', content: 'A job' });
  });

  it('repairs a reply that does not fit the schema, once', async () => {
    const api = fakeApi([
      answer('{"verdict":"definitely","reason":"x"}'),
      answer('{"verdict":"maybe","reason":"x"}', { prompt_tokens: 50, completion_tokens: 10 }),
    ]);
    const res = await provider(api.fetchFn).completeStructured({
      system: 's',
      prompt: 'p',
      schema,
    });
    expect(res.data.verdict).toBe('maybe');
    expect(res.usage).toEqual({ inputTokens: 150, outputTokens: 30 });
    expect(api.sent[1]!.body.messages[0].content).toMatch(/repair JSON/);

    const bad = fakeApi([answer('nope'), answer('still nope')]);
    await expect(
      provider(bad.fetchFn).completeStructured({ system: 's', prompt: 'p', schema }),
    ).rejects.toThrow(/did not match the expected schema/);
  });

  it('a rate limit is its own error, with how long to wait', async () => {
    const api = fakeApi([
      {
        status: 429,
        body: { error: { message: 'Rate limit reached for TPM' } },
        headers: { 'retry-after': '7' },
      },
      { status: 429, body: { error: { message: 'Daily limit' } } },
    ]);
    const p = provider(api.fetchFn);
    const first = await p.completeStructured({ system: 's', prompt: 'p', schema }).catch((e) => e);
    expect(first).toBeInstanceOf(RateLimitError);
    expect(first).toMatchObject({
      retryAfterSeconds: 7,
      message: 'Groq rate limit reached: Rate limit reached for TPM',
    });
    const second = await p.completeStructured({ system: 's', prompt: 'p', schema }).catch((e) => e);
    expect(second.retryAfterSeconds).toBeNull();
  });

  it('a model without JSON mode is asked again without it', async () => {
    const api = fakeApi([
      { status: 400, body: { error: { message: 'response_format is not supported' } } },
      answer('{"verdict":"no","reason":"contract"}'),
    ]);
    const res = await provider(api.fetchFn).completeStructured({
      system: 's',
      prompt: 'p',
      schema,
    });
    expect(res.data.verdict).toBe('no');
    expect(api.sent[1]!.body.response_format).toBeUndefined();
  });

  it('other failures carry the service’s own message; no key means no Authorization header', async () => {
    const api = fakeApi([{ status: 401, body: { error: { message: 'Invalid API Key' } } }]);
    await expect(
      provider(api.fetchFn).completeStructured({ system: 's', prompt: 'p', schema }),
    ).rejects.toThrow('Groq API error 401: Invalid API Key');

    const local = fakeApi([answer('{"verdict":"yes","reason":"ok"}')]);
    await new OpenAICompatProvider({
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:14b',
      fetchFn: local.fetchFn,
    }).completeStructured({ system: 's', prompt: 'p', schema });
    expect(local.sent[0]!.auth).toBeNull();
  });
});
