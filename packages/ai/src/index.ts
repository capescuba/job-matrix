import { AnthropicProvider } from './anthropic.ts';
import { OpenAICompatProvider, RateLimitError } from './openaiCompat.ts';
import { LLMError, type LLMProvider } from './types.ts';

export * from './types.ts';
export { parseLooseJson } from './json.ts';

let cached: LLMProvider | undefined;

/**
 * Returns the configured provider (AI_PROVIDER env, default "anthropic").
 * Add OpenAI / Ollama implementations here when needed.
 */
/** Forget the cached provider, e.g. after the API key or model changes. */
export function resetProvider() {
  cached = undefined;
}

export function getProvider(): LLMProvider {
  if (cached) return cached;
  const name = (process.env.AI_PROVIDER ?? 'anthropic').toLowerCase();
  switch (name) {
    case 'anthropic':
      cached = new AnthropicProvider(process.env.AI_MODEL || 'claude-opus-5-5');
      return cached;
    default:
      throw new LLMError(`Unknown AI_PROVIDER "${name}". Supported: anthropic`);
  }
}

// ---------- the watchlist pre-screen: a small yes/no job for a free model ----------

export const PRESCREEN_PROVIDERS = [
  'off',
  'groq',
  'gemini',
  'openrouter',
  'ollama',
  'custom',
  'anthropic',
] as const;
export type PrescreenProviderId = (typeof PRESCREEN_PROVIDERS)[number];

/** Where each service lives and a model of theirs that is free and good enough (Sep 2026). */
export const PRESCREEN_PRESETS: Record<
  PrescreenProviderId,
  { label: string; baseUrl: string; model: string; needsKey: boolean; keyUrl: string | null }
> = {
  off: { label: 'Off', baseUrl: '', model: '', needsKey: false, keyUrl: null },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Groq's free tier no longer includes its Llama models (404 model_not_found); GPT-OSS is.
    model: 'openai/gpt-oss-120b',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.1-flash-lite',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3.8-27b:free',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
  },
  ollama: {
    label: 'Ollama (this PC)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:14b',
    needsKey: false,
    keyUrl: null,
  },
  custom: { label: 'Other', baseUrl: '', model: '', needsKey: false, keyUrl: null },
  anthropic: {
    label: 'Claude Haiku 4.5',
    baseUrl: '',
    model: 'claude-haiku-4-5',
    needsKey: false,
    keyUrl: null,
  },
};

/** The pre-screen settings in force (PRESCREEN_* env), with the preset filling what isn't set. */
export function prescreenConfig() {
  const raw = (process.env.PRESCREEN_PROVIDER ?? 'off').toLowerCase();
  const provider = (PRESCREEN_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as PrescreenProviderId)
    : 'off';
  const preset = PRESCREEN_PRESETS[provider];
  const baseUrl = process.env.PRESCREEN_BASE_URL?.trim() || preset.baseUrl;
  const model = process.env.PRESCREEN_MODEL?.trim() || preset.model;
  const apiKey = process.env.PRESCREEN_API_KEY?.trim() || null;
  const ready =
    provider === 'anthropic'
      ? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
      : provider !== 'off' && Boolean(baseUrl && model) && (!preset.needsKey || Boolean(apiKey));
  return { provider, label: preset.label, baseUrl, model, apiKey, ready };
}

/** The model that pre-screens watchlist jobs, or null when it is off or not yet set up. */
export function getPrescreenProvider(): { provider: LLMProvider; model: string } | null {
  const c = prescreenConfig();
  if (!c.ready) return null;
  if (c.provider === 'anthropic') return { provider: getProvider(), model: c.model };
  return {
    provider: new OpenAICompatProvider({
      name: c.label,
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: c.apiKey,
    }),
    model: c.model,
  };
}

export { AnthropicProvider, OpenAICompatProvider, RateLimitError };
