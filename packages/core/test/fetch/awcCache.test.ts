/**
 * The AWC cache files, against extracts of the real files recorded on
 * 2026-10-20 at 04:53Z (test/fixtures/fetch/awc-cache-2026-10-20): every
 * row and element is exactly as the service wrote it, with most of the
 * world's stations left out. No network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeMetar } from '../../src/decode/metar/index.js';
import { decodeTaf } from '../../src/decode/taf/index.js';
import { AwcError } from '../../src/fetch/awc.js';
import { AWC_CACHE_BASE_URL, AwcCacheClient, METAR_CACHE_FILE, parseMetarCache, parseTafCache, TAF_CACHE_FILE } from '../../src/fetch/awcCache.js';
import { HttpError } from '../../src/fetch/http.js';
import { rawReport } from '../../src/store/types.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const DIR = 'awc-cache-2026-10-20';
const metarCsv = readFileSync(join(FIXTURES, DIR, 'metars.cache.csv'), 'utf8');
const tafXml = readFileSync(join(FIXTURES, DIR, 'tafs.cache.xml'), 'utf8');
const URL_M = `${AWC_CACHE_BASE_URL}/${METAR_CACHE_FILE}`;
const URL_T = `${AWC_CACHE_BASE_URL}/${TAF_CACHE_FILE}`;

describe('parseMetarCache', () => {
  const reports = parseMetarCache(metarCsv, URL_M);

  it('reads every row, verbatim, with its station and observation time', () => {
    expect(reports).toHaveLength(13);
    const yyz = reports.find((r) => r.station === 'CYYZ')!;
    expect(yyz.kind).toBe('metar');
    expect(yyz.source).toBe('awc');
    expect(yyz.body).toBe('METAR CYYZ 200400Z 35010KT 15SM SKC 11/07 A3036 RMK SLP286');
    expect(yyz.issuedAt?.toISOString()).toBe('2026-10-20T04:00:00.000Z');
  });

  it('names a report by the same hash the data API would have given it', () => {
    // Fetched from /api/data/metar?ids=CYYZ at the same minute: rawOb was this exact text.
    const viaApi = rawReport({ kind: 'metar', source: 'awc', station: 'CYYZ', body: 'METAR CYYZ 200400Z 35010KT 15SM SKC 11/07 A3036 RMK SLP286', issuedAt: new Date('2026-10-20T04:00:00Z'), upstream: { anything: true } });
    expect(reports.find((r) => r.station === 'CYYZ')!.sha256).toBe(viaApi.sha256);
  });

  it('keeps a SPECI as a SPECI, and trims the trailing space some stations send', () => {
    const xs = reports.find((r) => r.station === 'CYXS')!;
    expect(xs.body.startsWith('SPECI CYXS')).toBe(true);
    const nyc = reports.find((r) => r.station === 'KNYC')!;
    expect(nyc.body.endsWith('$')).toBe(true);
  });

  it('gives the decoder text it decodes', () => {
    for (const r of reports) expect(decodeMetar(r.body).station?.value).toBe(r.station);
  });

  it('finds the header after a preamble, which the file has carried in some years', () => {
    const withPreamble = `No errors\nNo warnings\n4 ms\ndata source=metars\n13 results\n${metarCsv}`;
    expect(parseMetarCache(withPreamble, URL_M).map((r) => r.sha256)).toEqual(reports.map((r) => r.sha256));
  });

  it('refuses a file with no header rather than returning nothing', () => {
    expect(() => parseMetarCache('<html>maintenance</html>', URL_M)).toThrow(AwcError);
  });

  it('refuses bytes that are still compressed, rather than parsing noise', () => {
    expect(() => parseMetarCache('\u001f�\b\u0000garbage', URL_M)).toThrow(/still compressed/);
  });
});

describe('parseTafCache', () => {
  const reports = parseTafCache(tafXml, URL_T);

  it('reads every TAF element, with its station and issue time', () => {
    expect(reports.map((r) => r.station).sort()).toEqual(['CYHM', 'CYOW', 'CYTZ', 'CYUL', 'CYYZ', 'EGLL', 'KBUF', 'MMMY']);
    const mmmy = reports.find((r) => r.station === 'MMMY')!;
    expect(mmmy.kind).toBe('taf');
    expect(mmmy.body.startsWith('TAF COR MMMY 200451Z 2000/2100 15005KT')).toBe(true);
    expect(mmmy.issuedAt?.toISOString()).toBe('2026-10-20T04:51:00.000Z');
  });

  it('gives the decoder text it decodes', () => {
    for (const r of reports) expect(decodeTaf(r.body).station?.value).toBe(r.station);
  });

  it('reads plain text as well as CDATA, and undoes the five XML entities', () => {
    const xml = '<response><data num_results="1"><TAF><raw_text>TAF CXXX 200000Z 2000/2012 VRB03KT P6SM SKC RMK A&amp;B</raw_text><station_id>CXXX</station_id><issue_time>2026-10-20T00:00:00.000Z</issue_time></TAF></data></response>';
    expect(parseTafCache(xml, URL_T)[0]!.body).toBe('TAF CXXX 200000Z 2000/2012 VRB03KT P6SM SKC RMK A&B');
  });

  it('refuses a document that is not a TAF response', () => {
    expect(() => parseTafCache('<html>maintenance</html>', URL_T)).toThrow(AwcError);
  });
});

describe('AwcCacheClient', () => {
  it('asks for the two files by their own names, under whatever base it is given', async () => {
    const base = 'https://relay.example/awc/cache';
    const http = replayHttp({
      [`${base}/${METAR_CACHE_FILE}`]: { status: 200, file: `${DIR}/metars.cache.csv` },
      [`${base}/${TAF_CACHE_FILE}`]: { status: 200, file: `${DIR}/tafs.cache.xml` },
    });
    const client = new AwcCacheClient(http, base);
    const m = await client.metars();
    const t = await client.tafs();
    expect(m.request).toBe(`${base}/${METAR_CACHE_FILE}`);
    expect(m.reports).toHaveLength(13);
    expect(t.reports).toHaveLength(8);
  });

  it('throws on a failed fetch rather than reporting an empty world', async () => {
    const http = replayHttp({ [URL_M]: { status: 503, body: 'down' } });
    await expect(new AwcCacheClient(http).metars()).rejects.toThrow(HttpError);
  });
});
