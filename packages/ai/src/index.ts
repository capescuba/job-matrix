import { AnthropicProvider } from './anthropic.ts';
import { LLMError, type LLMProvider } from './types.ts';

export * from './types.ts';

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
      cached = new AnthropicProvider(process.env.AI_MODEL || 'claude-opus-5');
      return cached;
    default:
      throw new LLMError(`Unknown AI_PROVIDER "${name}". Supported: anthropic`);
  }
}

export { AnthropicProvider };
