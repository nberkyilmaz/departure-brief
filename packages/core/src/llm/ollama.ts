import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from './provider.js';

export interface OllamaOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Ollama's default is 2048; NOTAM prompts fit comfortably but set it explicitly. */
  readonly contextTokens?: number;
}

interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly model?: string;
  readonly error?: string;
}

/**
 * Local models through Ollama's chat API with `format` set to the JSON
 * schema, so the model is constrained to the shape we validate anyway.
 * Temperature 0: the pipeline is meant to be reproducible for a given
 * model and prompt version.
 */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly contextTokens: number;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.doFetch = options.fetch ?? fetch;
    this.contextTokens = options.contextTokens ?? 8192;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          stream: false,
          format: request.schema,
          options: { temperature: 0, num_predict: request.maxTokens, num_ctx: this.contextTokens },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt, ...(request.images?.length ? { images: request.images } : {}) },
          ],
        }),
      });
    } catch (e) {
      throw new LLMError(`cannot reach Ollama at ${this.baseUrl}: ${(e as Error).message}`, this.id);
    }
    if (!res.ok) throw new LLMError(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, this.id);
    const body = (await res.json()) as OllamaChatResponse;
    if (body.error) throw new LLMError(`Ollama: ${body.error}`, this.id);
    const text = body.message?.content ?? '';
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LLMError(`Ollama returned non-JSON despite the schema: ${text.slice(0, 200)}`, this.id);
    }
    return {
      json,
      text,
      model: body.model ?? request.model,
      provider: this.id,
      usage: { input: body.prompt_eval_count ?? 0, output: body.eval_count ?? 0 },
    };
  }
}
