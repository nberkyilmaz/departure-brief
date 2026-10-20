import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from './provider.js';

export class BudgetExceededError extends LLMError {
  constructor(
    readonly spent: number,
    readonly cap: number,
  ) {
    super(`token budget exhausted: ${spent} of ${cap} output tokens spent`, 'budget');
    this.name = 'BudgetExceededError';
  }
}

/**
 * The second of the two spend caps the plan requires (the first is the
 * provider's own limit): a counter in code that refuses to exceed a
 * ceiling of output tokens. Counts what the inner provider reports.
 */
export class BudgetedProvider implements LLMProvider {
  readonly id: string;
  private spentOutput = 0;

  constructor(
    private readonly inner: LLMProvider,
    private readonly capOutputTokens: number,
  ) {
    this.id = `budgeted:${inner.id}`;
  }

  get spent(): number {
    return this.spentOutput;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (this.spentOutput >= this.capOutputTokens) throw new BudgetExceededError(this.spentOutput, this.capOutputTokens);
    const res = await this.inner.complete(request);
    this.spentOutput += res.usage.output;
    return res;
  }
}
