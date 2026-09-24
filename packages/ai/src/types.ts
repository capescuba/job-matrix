import type { z } from 'zod';

/** Live events while a call runs, for showing what the model is doing. */
export type LLMEvent =
  | { type: 'request'; model: string; effort: Effort | null }
  | { type: 'thinking'; text: string }
  | { type: 'output'; text: string }
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
}

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
}

export class LLMError extends Error {
  /** Set when the call reached the model, so failures can still be inspected. */
  trace?: CallTrace;
}
