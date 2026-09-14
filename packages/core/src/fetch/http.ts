import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpRequestInit {
  readonly headers?: Readonly<Record<string, string>>;
}

/** The one thing every upstream client depends on. Tests replay recorded responses through it. */
export interface HttpClient {
  get(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
}

export interface HttpClientOptions {
  /** Sent on every request. The FAA- and NOAA-style APIs want a real one. */
  readonly userAgent: string;
  /** Minimum spacing between request starts through this client. Default 250 ms. */
  readonly minIntervalMs?: number;
  /** Retries on network errors, 429 and 5xx. Default 3. */
  readonly retries?: number;
  /** First backoff; doubles per attempt. Default 500 ms. */
  readonly backoffMs?: number;
  /**
   * How long one attempt may take before it is abandoned. Default 10 s.
   * Requests are serialised, so without a deadline a single upstream that
   * accepts a connection and then says nothing stops every caller behind it.
   */
  readonly timeoutMs?: number;
  /** Development cache of 2xx responses on disk, keyed by URL; skipped when `null`. */
  readonly cache?: { readonly dir: string; readonly ttlMs: number } | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

interface CacheEntry {
  url: string;
  fetchedAt: number;
  status: number;
  body: string;
  headers: Record<string, string>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A polite HTTP GET client: real `User-Agent`, serialised requests with a
 * minimum interval, retries with exponential backoff, and an optional
 * on-disk cache so repeated development runs cost the upstream nothing.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const minInterval = options.minIntervalMs ?? 250;
  const retries = options.retries ?? 3;
  const backoff = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const doFetch = options.fetch ?? fetch;
  const cache = options.cache ?? null;

  let lastStart = Number.NEGATIVE_INFINITY;
  let queue: Promise<unknown> = Promise.resolve();

  const cachePath = (url: string) =>
    join(cache!.dir, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`);

  const readCache = (url: string): HttpResponse | null => {
    if (!cache) return null;
    const path = cachePath(url);
    if (!existsSync(path)) return null;
    try {
      const entry = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
      if (entry.url !== url || now() - entry.fetchedAt > cache.ttlMs) return null;
      return { status: entry.status, body: entry.body, headers: entry.headers };
    } catch {
      return null;
    }
  };

  const writeCache = (url: string, res: HttpResponse): void => {
    if (!cache || res.status < 200 || res.status >= 300) return;
    mkdirSync(cache.dir, { recursive: true });
    const entry: CacheEntry = { url, fetchedAt: now(), status: res.status, body: res.body, headers: { ...res.headers } };
    writeFileSync(cachePath(url), JSON.stringify(entry));
  };

  const once = async (url: string, init: HttpRequestInit | undefined): Promise<HttpResponse> => {
    const wait = lastStart + minInterval - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
    const res = await doFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': options.userAgent, Accept: 'application/json, text/plain;q=0.9, */*;q=0.8', ...init?.headers },
      // Aborts the body too, so a response that stalls half-read also ends.
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, body: await res.text(), headers };
  };

  const withRetries = async (url: string, init: HttpRequestInit | undefined): Promise<HttpResponse> => {
    let attempt = 0;
    for (;;) {
      let res: HttpResponse;
      try {
        res = await once(url, init);
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(backoff * 2 ** attempt);
        attempt++;
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) return res;
      await sleep(backoff * 2 ** attempt);
      attempt++;
    }
  };

  return {
    get(url, init) {
      const cached = readCache(url);
      if (cached) return Promise.resolve(cached);
      // Serialise so the interval is honoured across concurrent callers.
      const run = queue.then(() => withRetries(url, init));
      queue = run.catch(() => undefined);
      return run.then((res) => {
        writeCache(url, res);
        return res;
      });
    },
  };
}

/** Throw unless the response is 2xx. */
export function expectOk(url: string, res: HttpResponse): HttpResponse {
  if (res.status < 200 || res.status >= 300) throw new HttpError(url, res.status, res.body);
  return res;
}
