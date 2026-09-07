/**
 * NASR parsing against a verbatim slice of the 2026-09-03 cycle
 * (test/fixtures/fetch/nasr): KJFK, KTEB, KHPN and N07 (Lincoln Park, no ICAO id).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toMagnetic, toTrue } from '../../src/domain/airport.js';
import { parseCsv } from '../../src/fetch/csv.js';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { FIXTURES } from '../helpers/http.js';

const airports = readNasrDirectory(join(FIXTURES, 'nasr', '2026-09-03'));
const byFaa = (id: string) => airports.find((a) => a.faaId === id)!;

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, CRLF and unquoted empties', () => {
    const rows = parseCsv('"A","B",C\r\n"x, y","say ""hi""",\r\n1,,3\n');
    expect(rows).toEqual([
      { A: 'x, y', B: 'say "hi"', C: '' },
      { A: '1', B: '', C: '3' },
    ]);
  });

  it('handles a newline inside quotes and a missing trailing newline', () => {
    expect(parseCsv('"A"\n"line1\nline2"')).toEqual([{ A: 'line1\nline2' }]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('readNasrDirectory', () => {
  it('reads every airport in the slice with its cycle', () => {
    expect(airports.map((a) => a.faaId).sort()).toEqual(['HPN', 'JFK', 'N07', 'TEB']);
    expect(new Set(airports.map((a) => a.cycle))).toEqual(new Set(['2026-09-03']));
  });

  it('KJFK: identity, position, elevation, magnetic variation', () => {
    const jfk = byFaa('JFK');
    expect(jfk.icaoId).toBe('KJFK');
    expect(jfk.siteNo).toBe('15793.');
    expect(jfk.siteType).toBe('A');
    expect(jfk.name).toBe('JOHN F KENNEDY INTL');
    expect(jfk.city).toBe('NEW YORK');
    expect(jfk.state).toBe('NY');
    expect(jfk.country).toBe('US');
    expect(jfk.lat).toBeCloseTo(40.63992805, 6);
    expect(jfk.lon).toBeCloseTo(-73.77869222, 6);
    expect(jfk.elevation).toBe(13);
    expect(jfk.magneticVariation).toBe(-13);
    expect(jfk.magneticVariationYear).toBe(2020);
    expect(jfk.patternAltitude).toBeNull();
  });

  it('KJFK: runways with true headings, declared distances and displaced thresholds', () => {
    const jfk = byFaa('JFK');
    const r = jfk.runways.find((x) => x.id === '04L/22R')!;
    expect(r.length).toBe(12079);
    expect(r.width).toBe(200);
    expect(r.surface).toBe('CONC');
    expect(r.condition).toBe('EXCELLENT');
    expect(r.lighting).toBe('HIGH');
    expect(r.ends.map((e) => e.id)).toEqual(['04L', '22R']);
    const e04 = r.ends[0]!;
    expect(e04.trueHeading).toBe(31);
    expect(e04.ils).toBe('ILS/DME');
    expect(e04.rightHandPattern).toBe(false);
    expect(e04.lat).toBeCloseTo(40.62202094, 6);
    expect(e04.elevation).toBeCloseTo(11.9, 1);
    expect(e04.displacedThreshold).toBe(460);
    expect([e04.tora, e04.toda, e04.asda, e04.lda]).toEqual([11351, 11351, 11470, 11010]);
    const e22 = r.ends[1]!;
    expect(e22.trueHeading).toBe(211);
    expect(e22.displacedThreshold).toBe(3424);
    expect(e22.lda).toBe(7795);
    expect(jfk.runways.length).toBe(4);
  });

  it('a field without an ICAO id has icaoId null but is still an airport', () => {
    const n07 = byFaa('N07');
    expect(n07.icaoId).toBeNull();
    expect(n07.runways.length).toBeGreaterThan(0);
    expect(n07.lat).toBeGreaterThan(40);
  });

  it('every runway end in the slice has a true heading', () => {
    for (const a of airports) for (const r of a.runways) for (const e of r.ends) expect(e.trueHeading).not.toBeNull();
  });
});

describe('magnetic conversion', () => {
  it('KJFK 04L: true 031 with 13W variation is magnetic 044', () => {
    const jfk = byFaa('JFK');
    const end = jfk.runways.find((r) => r.id === '04L/22R')!.ends[0]!;
    expect(toMagnetic(end.trueHeading!, jfk.magneticVariation!)).toBe(44);
    expect(toTrue(toMagnetic(end.trueHeading!, jfk.magneticVariation!), jfk.magneticVariation!)).toBe(31);
  });

  it('wraps around 360', () => {
    expect(toMagnetic(5 as never, 10)).toBe(355);
    expect(toMagnetic(355 as never, -10)).toBe(5);
    expect(toTrue(355 as never, 10)).toBe(5);
  });
});
