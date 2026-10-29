/**
 * OurAirports parsing against a verbatim slice of the 2026-09-07 snapshot
 * (test/fixtures/fetch/ourairports): CYSN, CYKF, CYHM, CYYZ, KJFK and
 * CNC3. Toronto is there because it is the upper wind site the others
 * borrow from — the nearest one to any of them.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOurAirports, readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { FIXTURES } from '../helpers/http.js';

const dir = join(FIXTURES, 'ourairports', '2026-09-07');
const all = readOurAirportsDirectory(dir, { snapshot: '2026-09-07' });
const byIcao = (id: string) => all.find((a) => a.icaoId === id)!;

describe('readOurAirportsDirectory', () => {
  it('reads every airport in the slice with source and snapshot', () => {
    expect(all.map((a) => a.icaoId).sort()).toEqual(['CNC3', 'CYHM', 'CYKF', 'CYSN', 'CYYZ', 'KJFK']);
    expect(new Set(all.map((a) => a.source))).toEqual(new Set(['ourairports']));
    expect(new Set(all.map((a) => a.cycle))).toEqual(new Set(['2026-09-07']));
  });

  it('filters by country', () => {
    const ca = readOurAirportsDirectory(dir, { snapshot: '2026-09-07', country: 'ca' });
    expect(ca.map((a) => a.icaoId).sort()).toEqual(['CNC3', 'CYHM', 'CYKF', 'CYSN', 'CYYZ']);
  });

  it('CYSN: identity, position, elevation, three runways with true headings', () => {
    const a = byIcao('CYSN');
    expect(a.name).toBe('Niagara District Airport');
    expect(a.country).toBe('CA');
    expect(a.state).toBe('ON');
    expect(a.lat).toBeCloseTo(43.191598, 5);
    expect(a.lon).toBeCloseTo(-79.171686, 5);
    expect(a.elevation).toBe(321);
    expect(a.magneticVariation).toBeNull();
    expect(a.runways.map((r) => r.id)).toEqual(['01/19', '06/24', '11/29']);
    const r0624 = a.runways[1]!;
    expect(r0624.length).toBe(5000);
    expect(r0624.width).toBe(150);
    expect(r0624.surface).toBe('ASP');
    expect(r0624.lighting).toBe('LIGHTED');
    expect(r0624.ends.map((e) => [e.id, e.trueHeading])).toEqual([
      ['06', 52.7],
      ['24', 232.7],
    ]);
    expect(a.runways[0]!.lighting).toBeNull();
  });

  it('CYHM: displaced threshold and runway end coordinates', () => {
    const r1230 = byIcao('CYHM').runways.find((r) => r.id === '12/30')!;
    expect(r1230.length).toBe(10006);
    expect(r1230.ends[0]!.displacedThreshold).toBe(1600);
    expect(r1230.ends[1]!.displacedThreshold).toBeNull();
    expect(r1230.ends[0]!.lat).toBeCloseTo(43.180599, 5);
    expect(r1230.ends[0]!.trueHeading).toBe(107);
  });

  it('CYKF runway set matches what AWC reports for the field', () => {
    expect(byIcao('CYKF').runways.map((r) => r.id).sort()).toEqual(['08/26', '14/32']);
  });

  it('an ident-only field with no icao_code still gets an ICAO-shaped id', () => {
    const cnc3 = byIcao('CNC3');
    expect(cnc3.faaId).toBe('CNC3');
    expect(cnc3.icaoId).toBe('CNC3');
  });

  /*
   * Rows as they appear in the 2026-10-28 snapshot. An American private
   * strip's ident is often an identifier the FAA has since given to someone
   * else, so it is not taken as an ICAO code the way a Canadian one is.
   */
  it('an American field is filed under its FAA identifier, or the K form of it, never a stale ident', () => {
    const header = '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"';
    const rows = [
      '3685,"KMIA","large_airport","Miami International Airport",25.796011,-80.289751,8,"NA","US","US-FL","Miami","yes","KMIA","MIA","KMIA","MIA","https://www.miami-airport.com/","https://en.wikipedia.org/wiki/Miami_International_Airport","MFW, South Florida, Wilcox Field, Pan American Field"',
      '45279,"AA05","small_airport","Shelby Strip",61.507867,-149.078925,40,"NA","US","US-AK","Palmer","no",,,"AA25","AA25",,,"AA05"',
      '21403,"KX51","medium_airport","Miami Homestead General Aviation Airport",25.499201,-80.554296,7,"NA","US","US-FL","Homestead","no",,,,"X51","http://www.miami-airport.com/homestead.asp","https://en.wikipedia.org/wiki/Homestead_General_Aviation_Airport",',
      '6551,"00N","small_airport","Bucks Airport",39.472998,-75.184346,105,"NA","US","US-NJ","Bridgeton","no",,,"K00N","00N",,"https://en.wikipedia.org/wiki/Bucks_Airport",',
    ];
    const ids = parseOurAirports([header, ...rows].join('\n'), new Map(), { snapshot: '2026-10-28' }).map((a) => [a.icaoId, a.faaId]);
    expect(ids).toEqual([
      ['KMIA', 'MIA'],
      [null, 'AA25'],
      ['KX51', 'X51'],
      ['K00N', '00N'],
    ]);
  });
});
