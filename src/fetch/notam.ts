import { rawReport, type RawReport } from '../store/types.js';
import { expectOk, type HttpClient } from './http.js';

/**
 * FAA NOTAM API (external-api.faa.gov/notamapi/v1). Requires a free
 * `client_id` / `client_secret` pair from the FAA developer portal.
 *
 * Request shape follows the published v1 documentation. **The response
 * handling below has not been verified against a live response** — no
 * credentials were available when this was written — so nothing is recorded
 * in fixtures and the parsing is deliberately minimal: every item in `items`
 * is stored verbatim as one raw report, and only the fields needed for
 * storage (`location`, `issued`) are read, defensively. Verify and tighten
 * once a key exists; see docs/plan.md step 2.
 */
export const FAA_NOTAM_BASE_URL = 'https://external-api.faa.gov/notamapi/v1/notams';

export interface NotamCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface NotamFetch {
  /** Every page requested, for the fetch log. */
  readonly requests: readonly string[];
  readonly reports: readonly RawReport[];
}

export class NotamError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'NotamError';
  }
}

interface NotamPage {
  readonly pageSize?: number;
  readonly pageNum?: number;
  readonly totalCount?: number;
  readonly totalPages?: number;
  readonly items?: unknown[];
}

function field(item: unknown, path: readonly string[]): unknown {
  let cur: unknown = item;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export class FaaNotamClient {
  constructor(
    private readonly http: HttpClient,
    private readonly credentials: NotamCredentials,
    private readonly baseUrl = FAA_NOTAM_BASE_URL,
  ) {}

  /** Build the page URL. Exposed so the request shape can be tested without credentials. */
  pageUrl(icaoLocation: string, pageNum: number, pageSize = 50): string {
    const loc = icaoLocation.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(loc)) throw new Error(`invalid ICAO location: ${icaoLocation}`);
    const q = new URLSearchParams({
      icaoLocation: loc,
      responseFormat: 'geoJson',
      pageSize: String(pageSize),
      pageNum: String(pageNum),
    });
    return `${this.baseUrl}?${q.toString()}`;
  }

  private headers(): Record<string, string> {
    return { client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret };
  }

  /** Every NOTAM the API returns for a location, across all pages. */
  async byLocation(icaoLocation: string, options: { readonly pageSize?: number; readonly maxPages?: number } = {}): Promise<NotamFetch> {
    const pageSize = options.pageSize ?? 50;
    const maxPages = options.maxPages ?? 20;
    const requests: string[] = [];
    const reports: RawReport[] = [];
    const station = icaoLocation.trim().toUpperCase();
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const url = this.pageUrl(station, pageNum, pageSize);
      requests.push(url);
      const res = expectOk(url, await this.http.get(url, { headers: this.headers() }));
      let page: NotamPage;
      try {
        page = JSON.parse(res.body) as NotamPage;
      } catch {
        throw new NotamError('response is not JSON', url);
      }
      const items = Array.isArray(page.items) ? page.items : [];
      for (const item of items) {
        const issued = field(item, ['properties', 'coreNOTAMData', 'notam', 'issued']);
        const location = field(item, ['properties', 'coreNOTAMData', 'notam', 'location']);
        reports.push(
          rawReport({
            kind: 'notam',
            source: 'faa-notam',
            station: typeof location === 'string' ? location : station,
            // The whole item is the record; it has no canonical text form upstream.
            body: JSON.stringify(item),
            issuedAt: typeof issued === 'string' && !Number.isNaN(Date.parse(issued)) ? new Date(issued) : null,
            upstream: null,
          }),
        );
      }
      const totalPages = typeof page.totalPages === 'number' ? page.totalPages : 1;
      if (pageNum >= totalPages || items.length === 0) break;
    }
    return { requests, reports };
  }
}
