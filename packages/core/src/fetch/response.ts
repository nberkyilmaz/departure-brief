/**
 * What an upstream client needs from a transport, and nothing that ties it
 * to one.
 *
 * Kept apart from `http.ts` because that file reaches for the filesystem
 * and `node:crypto` for its development cache, and the clients that parse
 * the weather services' answers have no business depending on either. With
 * the seam here, the same client runs on a server over the polite Node
 * transport and in a browser over `fetch` through the relay — and parses
 * the answer with the same code in both.
 */

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

/** Throw unless the response is 2xx. */
export function expectOk(url: string, res: HttpResponse): HttpResponse {
  if (res.status < 200 || res.status >= 300) throw new HttpError(url, res.status, res.body);
  return res;
}
