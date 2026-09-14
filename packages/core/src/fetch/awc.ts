import { rawReport, type RawReport } from '../store/types.js';
import { expectOk, type HttpClient } from './http.js';

/**
 * aviationweather.gov data API (NOAA Aviation Weather Center). Public domain.
 *
 * Shapes were verified against the live API on 2026-09-07; the recorded
 * responses in `test/fixtures/fetch/awc/` are what this client is tested on.
 * `format=json` returns one record per report with the verbatim text in
 * `rawOb` (METAR) or `rawTAF` (TAF); an unknown station yields `204 No Content`.
 */
export const AWC_BASE_URL = 'https://aviationweather.gov/api/data';

export interface AwcMetarRecord {
  readonly icaoId: string;
  readonly rawOb: string;
  /** Observation time, Unix seconds. */
  readonly obsTime: number;
  readonly receiptTime: string;
  readonly reportTime: string;
  readonly metarType: 'METAR' | 'SPECI';
  readonly [key: string]: unknown;
}

export interface AwcTafRecord {
  readonly icaoId: string;
  readonly rawTAF: string;
  readonly issueTime: string;
  readonly validTimeFrom: number;
  readonly validTimeTo: number;
  readonly [key: string]: unknown;
}

export interface AwcFetch {
  /** The URL requested, for the fetch log. */
  readonly request: string;
  readonly reports: readonly RawReport[];
}

export class AwcError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'AwcError';
  }
}

function normaliseIds(ids: readonly string[]): string {
  const clean = ids.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{3,4}$/.test(s));
  if (clean.length === 0) throw new Error('at least one station identifier is required');
  return clean.join(',');
}

async function getJsonArray(http: HttpClient, url: string): Promise<unknown[]> {
  const res = expectOk(url, await http.get(url));
  if (res.status === 204 || res.body.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new AwcError('response is not JSON', url);
  }
  if (!Array.isArray(parsed)) throw new AwcError('response is not a JSON array', url);
  return parsed;
}

function isMetar(x: unknown): x is AwcMetarRecord {
  const r = x as Partial<AwcMetarRecord>;
  return typeof r?.icaoId === 'string' && typeof r.rawOb === 'string' && typeof r.obsTime === 'number';
}

function isTaf(x: unknown): x is AwcTafRecord {
  const r = x as Partial<AwcTafRecord>;
  return typeof r?.icaoId === 'string' && typeof r.rawTAF === 'string' && typeof r.issueTime === 'string';
}

export class AwcClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = AWC_BASE_URL,
  ) {}

  /** Latest METAR per station, or the last `hours` of them. */
  async metars(ids: readonly string[], options: { readonly hours?: number } = {}): Promise<AwcFetch> {
    const url = `${this.baseUrl}/metar?ids=${normaliseIds(ids)}&format=json${options.hours ? `&hours=${options.hours}` : ''}`;
    const records = await getJsonArray(this.http, url);
    const reports = records.map((r) => {
      if (!isMetar(r)) throw new AwcError('METAR record missing icaoId/rawOb/obsTime', url);
      return rawReport({
        kind: 'metar',
        source: 'awc',
        station: r.icaoId,
        body: r.rawOb,
        issuedAt: new Date(r.obsTime * 1000),
        upstream: r,
      });
    });
    return { request: url, reports };
  }

  /** Latest TAF per station. */
  async tafs(ids: readonly string[]): Promise<AwcFetch> {
    const url = `${this.baseUrl}/taf?ids=${normaliseIds(ids)}&format=json`;
    const records = await getJsonArray(this.http, url);
    const reports = records.map((r) => {
      if (!isTaf(r)) throw new AwcError('TAF record missing icaoId/rawTAF/issueTime', url);
      return rawReport({
        kind: 'taf',
        source: 'awc',
        station: r.icaoId,
        body: r.rawTAF,
        issuedAt: new Date(r.issueTime),
        upstream: r,
      });
    });
    return { request: url, reports };
  }

  /**
   * Hazard advisories: the international SIGMETs and the American domestic
   * SIGMETs and AIRMETs, which are two feeds of the same thing with their
   * fields named differently.
   *
   * Unlike a METAR there is nothing to ask for by station — these belong to
   * areas — so both feeds come whole and the geometry decides what is about
   * any particular flight. That is a few hundred kilobytes for an answer
   * that is usually "none of these", which is why the freshness window
   * matters more here than anywhere else.
   */
  async sigmets(): Promise<AwcFetch> {
    const reports: RawReport[] = [];
    const requests: string[] = [];
    for (const [path, rawField] of [
      ['isigmet', 'rawSigmet'],
      ['airsigmet', 'rawAirSigmet'],
    ] as const) {
      const url = `${this.baseUrl}/${path}?format=json`;
      requests.push(url);
      const res = await this.http.get(url, { headers: { Accept: 'application/json' } });
      // A feed with nothing in it answers 204, which is not a failure.
      if (res.status === 204) continue;
      expectOk(url, res);
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new AwcError(`${path} response is not JSON`, url);
      }
      if (!Array.isArray(parsed)) throw new AwcError(`${path} response is not an array`, url);
      for (const record of parsed as Record<string, unknown>[]) {
        if (typeof record[rawField] !== 'string') continue;
        const from = record['validTimeFrom'];
        reports.push(
          rawReport({
            kind: 'sigmet',
            source: 'awc',
            // The region it is about, which is not an aerodrome.
            station: typeof record['firId'] === 'string' ? record['firId'] : typeof record['icaoId'] === 'string' ? (record['icaoId'] as string) : null,
            // The record as sent: the bulletin is inside it, and the area
            // has already been reduced to coordinates by the service.
            body: JSON.stringify(record),
            issuedAt: typeof from === 'number' ? new Date(from * 1000) : null,
            upstream: record,
          }),
        );
      }
    }
    return { request: requests.join(' '), reports };
  }
}
