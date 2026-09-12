import { BudgetedProvider } from './budget.js';
import { FixtureProvider, RecordingProvider } from './fixture.js';
import { OllamaProvider } from './ollama.js';
import type { LLMProvider } from './provider.js';

export interface ConfiguredLLM {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly description: string;
}

/**
 * The model configuration, from the environment, shared by the CLI and
 * the API so both make the same choice:
 *
 * - `HOLDSHORT_LLM=ollama` with `OLLAMA_MODEL` (default `qwen2.5:7b`) —
 *   local, the development default once Ollama is installed.
 * - `HOLDSHORT_LLM=fixture` with `HOLDSHORT_LLM_FIXTURE_DIR` — replay only;
 *   what tests and CI use.
 * - unset — no model: NOTAMs are fetched, filtered and shown but not ranked.
 *
 * `HOLDSHORT_LLM_RECORD_DIR` wraps a live provider so every answer is
 * written as a fixture. `HOLDSHORT_LLM_OUTPUT_TOKEN_CAP` (default 200,000)
 * is the in-code spend ceiling per process.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): ConfiguredLLM | null {
  const kind = env['HOLDSHORT_LLM']?.trim().toLowerCase();
  if (!kind) return null;
  const model = env['OLLAMA_MODEL'] ?? 'qwen2.5:7b';
  const cap = Number(env['HOLDSHORT_LLM_OUTPUT_TOKEN_CAP'] ?? 200_000);
  let provider: LLMProvider;
  let description: string;
  if (kind === 'ollama') {
    provider = new OllamaProvider();
    description = `ollama ${model}`;
  } else if (kind === 'fixture') {
    const dir = env['HOLDSHORT_LLM_FIXTURE_DIR'];
    if (!dir) throw new Error('HOLDSHORT_LLM=fixture needs HOLDSHORT_LLM_FIXTURE_DIR');
    provider = new FixtureProvider(dir);
    description = `fixtures from ${dir} (as ${model})`;
  } else {
    throw new Error(`unknown HOLDSHORT_LLM "${kind}" (ollama | fixture)`);
  }
  const record = env['HOLDSHORT_LLM_RECORD_DIR'];
  if (record && kind !== 'fixture') {
    provider = new RecordingProvider(provider, record);
    description += `, recording to ${record}`;
  }
  return { provider: new BudgetedProvider(provider, cap), model, description };
}
