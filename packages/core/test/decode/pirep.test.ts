/**
 * Pilot reports, over the AWC's cache file of 05:59Z on 9 November 2026: all
 * 23 PIREPs it held and a few of the airliner reports that make up the rest.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePirep } from '../../src/decode/pirep/decode.js';
import { sliceSpan } from '../../src/decode/span.js';
import { AwcError } from '../../src/fetch/awc.js';
import { AIRCRAFT_REPORT_CACHE_FILE, AWC_CACHE_BASE_URL, parseAircraftReportCache } from '../../src/fetch/awcCache.js';

const xml = readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'pireps-2026-11-09', 'aircraftreports.cache.xml'), 'utf8');
const URL_R = `${AWC_CACHE_BASE_URL}/${AIRCRAFT_REPORT_CACHE_FILE}`;
const reports = parseAircraftReportCache(xml, URL_R);
const filed = (start: string) => {
  const r = reports.find((x) => x.body.includes(`<raw_text>${start}`));
  if (!r) throw new Error(`no report starts ${start}`);
  return { report: r, d: decodePirep(r.body) };
};

describe('the aircraft report file', () => {
  it('keeps the PIREPs and leaves the airliners position reports behind', () => {
    expect(xml).toMatch(/<report_type>AIREP/);
    expect(reports).toHaveLength(23);
    expect(reports.every((r) => r.kind === 'pirep' && r.body.includes('<report_type>PIREP'))).toBe(true);
  });

  it('files each one verbatim under the station it came through, at the time it was made', () => {
    const { report } = filed('ITH UA');
    expect(report.station).toBe('ITH');
    expect(report.issuedAt).toEqual(new Date('2026-11-09T05:22:00Z'));
    expect(xml).toContain(report.body);
  });

  it('refuses what is not the file', () => {
    expect(() => parseAircraftReportCache('<html></html>', URL_R)).toThrow(AwcError);
    expect(() => parseAircraftReportCache('\x1f\x8bcompressed', URL_R)).toThrow(/compressed/);
  });
});

describe('a PIREP', () => {
  it('says where, how high, in what, and what was found', () => {
    const { report, d } = filed('ITH UA');
    expect(d.position).toEqual({ lat: 41.779, lon: -76.7689 });
    expect(d).toMatchObject({ altitudeFt: 9500, phase: null, aircraft: 'S22T', urgent: false, tempC: -7 });
    expect(d.icing).toEqual([{ intensity: 'MOD', type: 'RIME', baseFt: null, topFt: null }]);
    expect(d.text!.value).toBe('ITH UA /OV ITH210045/TM 0522/FL095/TP S22T/TA M07/IC MOD RIME');
    expect(sliceSpan(report.body, d.text!.span)).toBe(d.text!.value);
  });

  it('reads a band of turbulence the right way up however it was written', () => {
    // Written /TB MOD 130-110.
    expect(filed('JNU UA /OV JNU /TM 0552').d.turbulence).toEqual([{ intensity: 'MOD', type: null, frequency: null, baseFt: 11000, topFt: 13000 }]);
  });

  it('reads a band of icing, and a cloud base', () => {
    expect(filed('FAI UA').d.icing).toEqual([{ intensity: 'LGT', type: 'MIXED', baseFt: 4000, topFt: 6200 }]);
    expect(filed('BTV UA').d.clouds).toEqual([{ cover: null, baseFt: 2600, topFt: null }]);
  });

  it('takes wind shear and smooth air as what they are', () => {
    expect(filed('JST UA').d.turbulence[0]).toMatchObject({ type: 'LLWS', intensity: null });
    expect(filed('DEN UA /OV KDEN').d.turbulence[0]).toMatchObject({ intensity: 'NEG' });
  });

  it('has no height when the report gives none, rather than the zero it is filed under', () => {
    const unknown = filed('JNU UA /OV JNU /TM 0545');
    expect(unknown.report.body).toContain('<altitude_ft_msl>0</altitude_ft_msl>');
    expect(unknown.d).toMatchObject({ altitudeFt: null, phase: null });
    expect(filed('DEN UA /OV DEN/TM 0449').d).toMatchObject({ altitudeFt: null, phase: 'descending' });
  });

  it('keeps the height of one on the ground, which the service gives', () => {
    expect(filed('DEN UA /OV KDEN').d.altitudeFt).toBe(5500);
  });

  it('has the words even when the service could not split them into fields', () => {
    const { d } = filed('YKM UA');
    expect(d.turbulence).toEqual([]);
    expect(d.text!.value).toContain('/TB LGT-250-220');
  });

  it('reads every report in the file with nothing left over', () => {
    for (const r of reports) {
      const d = decodePirep(r.body);
      expect(d.unparsed, r.body).toEqual([]);
      expect(d.position).not.toBeNull();
      expect(d.aircraft).not.toBeNull();
    }
  });

  it('keeps what it cannot read rather than throwing', () => {
    expect(decodePirep('').unparsed).toEqual(['raw_text', 'position']);
    expect(decodePirep('not a report').text).toBeNull();
  });
});
