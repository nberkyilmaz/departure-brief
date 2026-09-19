import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpClient, HttpRequestInit, HttpResponse } from '../../src/fetch/http.js';

export const FIXTURES = join(__dirname, '..', 'fixtures', 'fetch');

export interface ReplayRoute {
  readonly status: number;
  /** Path under test/fixtures/fetch, or an inline body. */
  readonly file?: string;
  readonly body?: string;
  /** Response headers, lower-cased as `fetch` gives them. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ReplayCall {
  readonly url: string;
  readonly init: HttpRequestInit | undefined;
}

/**
 * An HttpClient that answers from recorded fixtures by exact URL. Any URL
 * not in the table throws, so a test can never quietly hit the network or
 * an unexpected endpoint.
 */
export function replayHttp(routes: Readonly<Record<string, ReplayRoute>>): HttpClient & { calls: ReplayCall[] } {
  const calls: ReplayCall[] = [];
  return {
    calls,
    async get(url, init) {
      calls.push({ url, init });
      const route = routes[url];
      if (!route) throw new Error(`replayHttp: no recorded response for ${url}`);
      const body = route.file !== undefined ? readFileSync(join(FIXTURES, route.file), 'utf8') : (route.body ?? '');
      const res: HttpResponse = { status: route.status, body, headers: route.headers ?? {} };
      return res;
    },
  };
}
