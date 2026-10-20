import { rawReport, type RawReport } from '../store/types.js';
import { AwcError, type AwcFetch } from './awc.js';
import { parseCsv } from './csv.js';
import { expectOk, type HttpClient } from './response.js';

/**
 * The AWC's cache files: every current METAR on earth in one file, every
 * current TAF in another, rebuilt by the service about once a minute.
 *
 * This is how "every station in the country" has to be asked for. The data
 * API's `bbox` looks like the answer and is not: over a large area it thins
 * the stations it returns, without saying so. Measured on 2026-10-20, one
 * box over Canada and the border states returned 145 METARs; the same area
 * as four boxes returned 550, and splitting any of those again found more.
 * A briefing built on the first answer would have been missing most of the
 * country while looking complete. The cache file has no such behaviour —
 * 4,837 stations, 422 of them Canadian, in 227 KB compressed — and it is
 * the service's own recommendation for bulk use.
 *
 * The files are gzip, served as `application/octet-stream` with no
 * `Content-Encoding`, so nothing decompresses them on the way. The relay
 * adds the header that makes a browser do it, which is why this client is
 * pointed at the relay and not at the service: given the bytes still
 * compressed, it says so rather than parsing noise.
 *
 * The text of each report is identical to what the data API returns for
 * the same observation, so a report is named by the same hash whichever
 * way it arrived.
 */
export const AWC_CACHE_BASE_URL = 'https://aviationweather.gov/data/cache';
export const METAR_CACHE_FILE = 'metars.cache.csv.gz';
export const TAF_CACHE_FILE = 'tafs.cache.xml.gz';

function refuseCompressed(text: string, url: string): void {
  // 0x1f 0x8b is the gzip magic; decoded as text the first byte survives.
  if (text.charCodeAt(0) === 0x1f) throw new AwcError('the cache file arrived still compressed; it has to come through a transport that decompresses it', url);
}

/** When the text says, or null — never a guess. */
function instant(text: string | null | undefined): Date | null {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Every METAR in the cache file, verbatim. The file has carried a few lines
 * of preamble before its header in some years and none in others, so the
 * header is found rather than assumed to be the first line.
 */
export function parseMetarCache(text: string, url: string): RawReport[] {
  refuseCompressed(text, url);
  const header = text.search(/^raw_text,/m);
  if (header < 0) throw new AwcError('METAR cache file has no raw_text header', url);
  const reports: RawReport[] = [];
  for (const row of parseCsv(text.slice(header))) {
    const body = row['raw_text']?.trim();
    const station = row['station_id']?.trim();
    if (!body || !station) continue;
    reports.push(rawReport({ kind: 'metar', source: 'awc', station, body, issuedAt: instant(row['observation_time']), upstream: null }));
  }
  return reports;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]!);
}

/** One child element's text, from CDATA or plain text; null when absent. */
function element(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
  if (!m) return null;
  return m[1] ?? decodeEntities(m[2] ?? '');
}

/**
 * Every TAF in the cache file, verbatim. There is no CSV of TAFs, only XML,
 * and only three fields of it are wanted: the report, its station and when
 * it was issued. The service generates this XML to a published schema, so
 * reading those three by pattern is reading a known shape, not scraping —
 * and it keeps an XML parser out of a package that has to run in a browser
 * and in Node alike.
 */
export function parseTafCache(text: string, url: string): RawReport[] {
  refuseCompressed(text, url);
  if (!/<data\b/.test(text)) throw new AwcError('TAF cache file has no data element', url);
  const reports: RawReport[] = [];
  for (const m of text.matchAll(/<TAF>([\s\S]*?)<\/TAF>/g)) {
    const xml = m[1]!;
    const body = element(xml, 'raw_text')?.trim();
    const station = element(xml, 'station_id')?.trim();
    if (!body || !station) continue;
    reports.push(rawReport({ kind: 'taf', source: 'awc', station, body, issuedAt: instant(element(xml, 'issue_time')), upstream: null }));
  }
  return reports;
}

export class AwcCacheClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = AWC_CACHE_BASE_URL,
  ) {}

  /** The latest METAR from every station reporting anywhere. */
  async metars(): Promise<AwcFetch> {
    const url = `${this.baseUrl}/${METAR_CACHE_FILE}`;
    const res = expectOk(url, await this.http.get(url));
    return { request: url, reports: parseMetarCache(res.body, url) };
  }

  /** Every TAF currently in force, anywhere. */
  async tafs(): Promise<AwcFetch> {
    const url = `${this.baseUrl}/${TAF_CACHE_FILE}`;
    const res = expectOk(url, await this.http.get(url));
    return { request: url, reports: parseTafCache(res.body, url) };
  }
}
