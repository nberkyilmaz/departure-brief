/**
 * G-AIRMETs and the combined SIGMET endpoint, over the AWC's files of 04:53Z
 * on 9 November 2026 (an extract: every record as sent, most of the country
 * left out).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSigmet } from '../../src/decode/sigmet/decode.js';
import { GAIRMET_HALF_WINDOW_MS } from '../../src/decode/sigmet/gairmet.js';
import { sliceSpan } from '../../src/decode/span.js';
import { areaIsTestable } from '../../src/domain/polygon.js';
import { AwcError } from '../../src/fetch/awc.js';
import { AwcClient } from '../../src/fetch/awc.js';
import { AWC_CACHE_BASE_URL, GAIRMET_CACHE_FILE, parseGairmetCache } from '../../src/fetch/awcCache.js';
import type { HttpClient } from '../../src/fetch/response.js';
import { reviveSigmet } from '../../src/store/revive.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'northeast-2026-11-09');
const xml = readFileSync(join(DIR, 'gairmets.cache.xml'), 'utf8');
const combined = readFileSync(join(DIR, 'sigmet.json'), 'utf8');
const URL_G = `${AWC_CACHE_BASE_URL}/${GAIRMET_CACHE_FILE}`;
const reports = parseGairmetCache(xml, URL_G);
const decoded = reports.map((r) => ({ report: r, d: decodeSigmet(r.body) }));

describe('the G-AIRMET cache file', () => {
  it('keeps the hazards and leaves the freezing level contours behind', () => {
    expect(xml).toMatch(/hazard type="FZLVL"/);
    expect(xml).toMatch(/hazard type="M_FZLVL"/);
    expect(reports.every((r) => !/type="M?_?FZLVL"/.test(r.body))).toBe(true);
    expect(new Set(decoded.map(({ d }) => d.hazard))).toEqual(new Set(['icing', 'ifr', 'mountain-obscuration', 'turbulence', 'low-level-wind-shear', 'surface-wind']));
  });

  it('files each one verbatim, under when it was issued', () => {
    expect(reports[0]!.kind).toBe('sigmet');
    expect(reports[0]!.body.startsWith('<GAIRMET>') && reports[0]!.body.endsWith('</GAIRMET>')).toBe(true);
    expect(xml).toContain(reports[0]!.body);
    expect(reports[0]!.issuedAt).toBeInstanceOf(Date);
  });

  it('refuses what is not the file', () => {
    expect(() => parseGairmetCache('<html></html>', URL_G)).toThrow(AwcError);
    expect(() => parseGairmetCache('\x1f\x8bcompressed', URL_G)).toThrow(/compressed/);
  });
});

describe('a G-AIRMET', () => {
  const first = (hazard: string) => decoded.find(({ d }) => d.hazardCode?.value === hazard)!.d;

  it('reads every record the file holds, with nothing left over', () => {
    for (const { d } of decoded) {
      expect(d.unparsed).toEqual([]);
      expect(d.kind).toBe('airmet');
      expect(d.series).toMatch(/^(SIERRA|TANGO|ZULU) \d[WCE]$/);
      expect(areaIsTestable(d.area)).toBeNull();
    }
  });

  it('speaks for the hours half way to the pictures either side', () => {
    const d = first('ICE');
    expect(d.validTo!.getTime() - d.snapshotAt!.getTime()).toBe(GAIRMET_HALF_WINDOW_MS);
    expect(d.snapshotAt!.getTime() - d.validFrom!.getTime()).toBe(GAIRMET_HALF_WINDOW_MS);
    expect(GAIRMET_HALF_WINDOW_MS).toBe(90 * 60_000);
  });

  it('reads an altitude band, severity and the code, cited', () => {
    const { report, d } = decoded.find((x) => x.d.hazardCode?.value === 'ICE')!;
    expect(d.hazard).toBe('icing');
    expect(d.qualifier!.value).toBe('MOD');
    expect(sliceSpan(report.body, d.hazardCode!.span)).toBe('ICE');
    expect(sliceSpan(report.body, d.qualifier!.span)).toBe('MOD');
    expect(d.baseFt).toBeGreaterThan(0);
    expect(d.topFt).toBeGreaterThan(d.baseFt!);
  });

  it('takes SFC as the surface', () => {
    expect(decoded.find(({ report }) => report.body.includes('min_ft_msl="SFC"'))!.d.baseFt).toBe(0);
  });

  it('reads the lowest of the freezing level range for a base given as FZL', () => {
    const { report, d } = decoded.find(({ report: r }) => r.body.includes('min_ft_msl="FZL"'))!;
    const lowest = /<fzl_altitude><min_ft_msl>(\d+)</.exec(report.body)![1]!;
    expect(d.baseFt).toBe(Number(lowest));
  });

  it('has no altitudes where the file gives none, and says what an IFR area is made of', () => {
    const d = first('IFR');
    expect(d.baseFt).toBeNull();
    expect(d.topFt).toBeNull();
    expect(d.qualifier).toBeNull();
    expect(d.dueTo).toMatch(/^CIG BLW 010 VIS BLW 3SM/);
    expect(first('MT_OBSC').dueTo).toMatch(/^MTNS OBSC BY/);
    expect(first('ICE').dueTo).toBeNull();
  });

  it('comes back from the store with its instant', () => {
    const d = first('ICE');
    expect(reviveSigmet(JSON.parse(JSON.stringify(d))).snapshotAt).toEqual(d.snapshotAt);
  });
});

describe('the combined SIGMET endpoint', () => {
  const records = JSON.parse(combined) as Record<string, unknown>[];

  it('is one request, and answers with both kinds', async () => {
    const asked: string[] = [];
    const http: HttpClient = { async get(url) { asked.push(url); return { status: 200, body: combined, headers: {} }; } };
    const { request, reports: got } = await new AwcClient(http, 'https://aviationweather.gov/api/data').sigmets();
    expect(asked).toEqual(['https://aviationweather.gov/api/data/sigmet?format=json']);
    expect(request).toBe(asked[0]);
    expect(got).toHaveLength(records.length);
    expect(got.map((r) => r.station)).toContain('KMKC');
  });

  it('treats 204 as nothing in force', async () => {
    const http: HttpClient = { get: async () => ({ status: 204, body: '', headers: {} }) };
    expect((await new AwcClient(http).sigmets()).reports).toEqual([]);
  });

  it('reads a convective SIGMET, now called CONV, as a thunderstorm', () => {
    const d = decodeSigmet(JSON.stringify(records.find((r) => r['hazard'] === 'CONV')));
    expect(d.hazard).toBe('thunderstorm');
    expect(d.kind).toBe('sigmet');
    expect(d.baseFt).toBeNull();
    expect(d.topFt).toBe(29000);
    expect(d.region).toBe('KMKC');
    expect(d.bulletin!.value).toContain('CONVECTIVE SIGMET');
  });

  it('reads the base and top the old domestic feed split across four fields', () => {
    const d = decodeSigmet(JSON.stringify(records.find((r) => r['firId'] === 'KSLC')));
    expect(d.baseFt).toBe(33000);
    expect(d.topFt).toBe(45000);
    expect(d.qualifier!.value).toBe('OCNL SEV');
  });

  it('knows every hazard it sends', () => {
    expect(records.map((r) => decodeSigmet(JSON.stringify(r))).flatMap((d) => d.unparsed.filter((u) => u.startsWith('hazard ')))).toEqual([]);
  });
});
