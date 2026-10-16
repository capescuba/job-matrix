import type { z } from 'zod';

/** Live events while a call runs, for showing what the model is doing. */
export type LLMEvent =
  | { type: 'request'; model: string; effort: Effort | null }
  | { type: 'thinking'; text: string }
  | { type: 'output'; text: string }
  | { type: 'search'; query: string }
  | { type: 'searchResults'; count: number }
  | { type: 'usage'; usage: TokenUsage };

export interface StructuredRequest<S extends z.ZodType> {
  system: string;
  prompt: string;
  schema: S;
  model?: string;
  maxTokens?: number;
  /** How hard the model thinks: lower is faster and cheaper. Provider default when omitted. */
  effort?: Effort;
  /** Called with thinking/output deltas as they stream in. */
  onEvent?: (e: LLMEvent) => void;
  /** Let the model search the web (a server-side tool, billed per search). */
  webSearch?: { maxUses: number };
  /**
   * false = describe the schema in the prompt instead of enforcing it while decoding — for
   * schemas too large for the API's structured-output grammar. The reply is validated, and
   * repaired once with a small follow-up call if it doesn't match.
   */
  constrained?: boolean;
}

/** One piece of a prompt; `cache` puts a cache breakpoint after it (everything before is reused). */
export interface Block {
  text: string;
  cache?: boolean;
}

/**
 * A call whose prompt is built from ordered blocks, for a live loop that re-sends a growing,
 * append-only prefix and wants it read from the cache. Streams, can be aborted, and reports the
 * tokens it used even when it was.
 */
export interface BlocksRequest<S extends z.ZodType> {
  model: string;
  schema: S;
  system: Block[];
  /** One user turn, in order. */
  content: Block[];
  effort?: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: LLMEvent) => void;
}

/** The caller aborted the request. `usage` is what had already been spent. */
export class AbortedError extends Error {
  usage?: TokenUsage;
  trace?: CallTrace;
}

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Web searches the model ran (billed per search). */
  webSearches?: number;
}

/** What was actually sent and received — kept for the request inspector. */
export interface CallTrace {
  /** The request body as sent (the output schema appears as JSON Schema). */
  request: unknown;
  responseText: string;
  /** Summarized thinking, when the provider returns it. */
  thinking: string;
  stopReason: string | null;
  durationMs: number;
}

export interface StructuredResponse<T> {
  data: T;
  provider: string;
  model: string;
  usage?: TokenUsage;
  trace?: CallTrace;
}

export interface LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  complete(req: {
    system: string;
    prompt: string;
    model?: string;
    maxTokens?: number;
  }): Promise<string>;
  completeStructured<S extends z.ZodType>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>>;
  /** Block-based, cacheable, abortable calls. Not every provider offers it. */
  completeBlocks?<S extends z.ZodType>(
    req: BlocksRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>>;
}

export class LLMError extends Error {
  /** Set when the call reached the model, so failures can still be inspected. */
  trace?: CallTrace;
}
