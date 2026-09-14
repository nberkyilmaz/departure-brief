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

/**
 * An upper wind record. `text` is a JSON *array*, not an object: the
 * bulletin and office, five timestamps, four nulls, then the levels as
 * `[altitude, direction, speed, temperature, ?]`. Shape verified
 * 2026-09-14 against CYYZ and CYOW.
 */
export interface CfpsUpperWindRecord {
  readonly type: string;
  readonly pk: number;
  readonly location: string | null;
  readonly startValidity: string | null;
  readonly endValidity: string | null;
  readonly text: string;
  readonly position?: { readonly pointReference?: string } | null;
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

  /**
   * Upper winds for one or more sites. Six records come back per site that
   * has them: three bulletins covering the day, each issued twice — by
   * Canada's office for the levels a light aircraft flies, and by the US
   * office for the levels above. All six are stored; which one applies is a
   * question about the time of the flight, and that is the resolver's to
   * answer, not the fetcher's.
   *
   * A site that publishes no upper winds simply contributes nothing, which
   * is how most aerodromes answer.
   */
  async upperWinds(sites: string | readonly string[]): Promise<CfpsFetch> {
    const ids = (typeof sites === 'string' ? [sites] : sites).map((s) => s.trim().toUpperCase());
    if (ids.length === 0) return { request: '', reports: [] };
    for (const id of ids) if (!/^[A-Z0-9]{3,4}$/.test(id)) throw new Error(`invalid site identifier: ${id}`);
    /*
     * Several sites in one request, which matters because most aerodromes
     * are not upper wind sites at all: asking CYSN returns nothing, and the
     * answer a flight from there needs is Toronto's. Rather than probing
     * one candidate at a time, every candidate goes in one request and the
     * service answers for whichever of them it publishes.
     */
    const url = `${this.baseUrl}?${ids.map((id) => `site=${id}`).join('&')}&alpha=upperwind`;
    const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'application/json' } }));
    let parsed: { data?: unknown };
    try {
      parsed = JSON.parse(res.body) as { data?: unknown };
    } catch {
      throw new NavCanadaError('response is not JSON', url);
    }
    if (!Array.isArray(parsed.data)) throw new NavCanadaError('response has no data array', url);
    const reports: RawReport[] = [];
    for (const item of parsed.data as CfpsUpperWindRecord[]) {
      if (item.type !== 'upperwind' || typeof item.text !== 'string') continue;
      /*
       * The service reports the location as `YYZ` but references the
       * aerodrome as `CYYZ`. Stored under the identifier a flight plan
       * would name, so a briefing can find it.
       */
      const station = item.position?.pointReference ?? (item.location ? `C${item.location}` : null);
      reports.push(
        rawReport({
          kind: 'upperwind',
          source: 'navcanada-cfps',
          station,
          body: item.text,
          // When the forecast starts applying: its own validity, not the issue time.
          issuedAt: utc(item.startValidity),
          upstream: item,
        }),
      );
    }
    return { request: url, reports };
  }
}
