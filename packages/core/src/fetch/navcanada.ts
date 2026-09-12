import { rawReport, type RawReport } from '../store/types.js';
import { expectOk, type HttpClient } from './http.js';

/**
 * NAV CANADA Collaborative Flight Planning Services — the JSON endpoint
 * behind plan.navcanada.ca. **Unofficial**: it is what their own site
 * calls, not a published API, and may change without notice. Used here
 * because Canadian NOTAMs have no public API and the alternative is pasting
 * text. Every response is stored verbatim, so a change in shape breaks
 * loudly in the client rather than silently in the data.
 *
 * Shape verified 2026-09-12: `{ meta: { now, count }, data: [{ type, pk,
 * location, startValidity, endValidity, text, hasError, position }] }`
 * where `text` is a JSON *string* with `raw` (the ICAO NOTAM), `english`,
 * `french`. Times are UTC without a `Z`.
 */
export const NAVCANADA_CFPS_BASE_URL = 'https://plan.navcanada.ca/weather/api/alpha/';

export interface CfpsNotamRecord {
  readonly type: string;
  readonly pk: number;
  readonly location: string | null;
  readonly startValidity: string | null;
  readonly endValidity: string | null;
  /** JSON string: `{ raw, english, french }`. */
  readonly text: string;
  readonly hasError?: boolean;
  readonly position?: unknown;
}

export interface CfpsFetch {
  readonly request: string;
  readonly reports: readonly RawReport[];
}

export class NavCanadaError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'NavCanadaError';
  }
}

/** CFPS times are UTC with no designator; make them unambiguous. */
function utc(text: string | null | undefined): Date | null {
  if (!text) return null;
  const d = new Date(/[Zz]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class NavCanadaClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = NAVCANADA_CFPS_BASE_URL,
  ) {}

  /** Every NOTAM CFPS associates with a site (its own plus FIR-wide ones). */
  async notams(site: string): Promise<CfpsFetch> {
    const id = site.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(id)) throw new Error(`invalid site identifier: ${site}`);
    const url = `${this.baseUrl}?site=${id}&alpha=notam`;
    const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'application/json' } }));
    let parsed: { data?: unknown };
    try {
      parsed = JSON.parse(res.body) as { data?: unknown };
    } catch {
      throw new NavCanadaError('response is not JSON', url);
    }
    if (!Array.isArray(parsed.data)) throw new NavCanadaError('response has no data array', url);
    const reports: RawReport[] = [];
    for (const item of parsed.data as CfpsNotamRecord[]) {
      if (item.type !== 'notam' || typeof item.text !== 'string') continue;
      let text: { raw?: unknown };
      try {
        text = JSON.parse(item.text) as { raw?: unknown };
      } catch {
        throw new NavCanadaError(`item ${item.pk} has a non-JSON text field`, url);
      }
      if (typeof text.raw !== 'string') throw new NavCanadaError(`item ${item.pk} has no raw NOTAM text`, url);
      reports.push(
        rawReport({
          kind: 'notam',
          source: 'navcanada-cfps',
          station: item.location ?? null,
          body: text.raw,
          issuedAt: utc(item.startValidity),
          upstream: item,
        }),
      );
    }
    return { request: url, reports };
  }
}
