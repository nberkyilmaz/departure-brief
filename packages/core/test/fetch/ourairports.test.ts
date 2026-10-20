/**
 * OurAirports parsing against a verbatim slice of the 2026-09-07 snapshot
 * (test/fixtures/fetch/ourairports): CYSN, CYKF, CYHM, CYYZ, KJFK and
 * CNC3. Toronto is there because it is the upper wind site the others
 * borrow from — the nearest one to any of them.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
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
});
