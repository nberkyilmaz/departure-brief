import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LLMError, requestKey, type LLMProvider, type LLMRequest, type LLMResponse } from './provider.js';

/** What a recorded call looks like on disk: the request, for inspection, and the response. */
export interface RecordedCall {
  readonly key: string;
  readonly request: LLMRequest;
  readonly response: LLMResponse;
  readonly recordedAt: string;
}

export class FixtureMissingError extends LLMError {
  constructor(
    readonly key: string,
    readonly dir: string,
  ) {
    super(`no recorded response ${key} in ${dir} — record one with RecordingProvider`, 'fixture');
    this.name = 'FixtureMissingError';
  }
}

/**
 * Replays recorded responses keyed by request hash. Tests, CI and every
 * refactor run on this: no GPU, no API key, no network. A request that was
 * never recorded throws — silence would hide a prompt change.
 */
export class FixtureProvider implements LLMProvider {
  readonly id = 'fixture';

  constructor(private readonly dir: string) {}

  static path(dir: string, key: string): string {
    return join(dir, `${key}.json`);
  }

  has(request: LLMRequest): boolean {
    return existsSync(FixtureProvider.path(this.dir, requestKey(request)));
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const key = requestKey(request);
    const path = FixtureProvider.path(this.dir, key);
    if (!existsSync(path)) throw new FixtureMissingError(key, this.dir);
    const recorded = JSON.parse(readFileSync(path, 'utf8')) as RecordedCall;
    return { ...recorded.response, provider: `fixture:${recorded.response.provider}` };
  }
}

/**
 * Passes calls to a real provider and writes each response as a fixture,
 * so the next run — and every test — replays it.
 */
export class RecordingProvider implements LLMProvider {
  readonly id: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.id = `recording:${inner.id}`;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const key = requestKey(request);
    const path = FixtureProvider.path(this.dir, key);
    if (existsSync(path)) return (JSON.parse(readFileSync(path, 'utf8')) as RecordedCall).response;
    const response = await this.inner.complete(request);
    mkdirSync(this.dir, { recursive: true });
    // Page images are megabytes each; the key already covers them, so the
    // recording keeps their hashes and stays readable in a diff.
    const images = request.images?.length ? request.images.map((i) => `sha256:${createHash('sha256').update(i).digest('hex')}`) : undefined;
    const recorded: RecordedCall = { key, request: { ...request, ...(images ? { images } : {}) }, response, recordedAt: this.now().toISOString() };
    writeFileSync(path, JSON.stringify(recorded, null, 2));
    return response;
  }
}
