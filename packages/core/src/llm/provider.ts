/**
 * The one interface every model call goes through. Structured output only:
 * a request carries a JSON schema and the response is the parsed object.
 * Providers never see prompts they did not get here, and nothing in the
 * request path of the API ever calls one.
 */

import { contentHash } from '../brief/canonical.js';

export type JsonSchema = Record<string, unknown>;

export interface LLMRequest {
  /** PNG pages, base64, for a model that can see; empty for text-only work. Part of the cache key. */
  readonly images?: readonly string[];
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly maxTokens: number;
}

export interface LLMResponse {
  /** The parsed structured output. Validation against the schema is the caller's job. */
  readonly json: unknown;
  /** The raw text the model produced. */
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly usage: { readonly input: number; readonly output: number };
}

export interface LLMProvider {
  readonly id: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/** The cache key for a request: same model, prompts and schema → same key. */
export function requestKey(request: LLMRequest): string {
  return contentHash({ model: request.model, system: request.system, prompt: request.prompt, schema: request.schema , images: request.images ?? []});
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
