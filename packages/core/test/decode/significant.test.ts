/**
 * Significant levels, over the 12Z flights of 9 November 2026: each balloon's
 * mandatory file, its significant product as the NWS API answered, and the
 * Storm Prediction Center's decoding of the same flight to check them against.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceSpan } from '../../src/decode/span.js';
import { decodeUpperWind } from '../../src/decode/upperwind/decode.js';
import { freezingLevel, windAtAltitude } from '../../src/decode/upperwind/interpolate.js';
import { soundingReport } from '../../src/fetch/soundings.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'noaa', 'significant-2026-11-09');
const WHEN = new Date('2026-11-09T21:30:00Z');
const FILES = { FGZ: 'usus45.kfgz.man.fgz', ILN: 'usus41.kiln.man.iln', GGW: 'usus45.kggw.man.ggw', CHS: 'usus42.kchs.man.chs' } as const;
type Site = keyof typeof FILES;
const SITES = Object.keys(FILES) as Site[];

const productText = (name: string) => (JSON.parse(readFileSync(join(DIR, name), 'utf8')) as { productText: string }).productText;
const mandatory = (site: Site) => readFileSync(join(DIR, `${FILES[site]}.txt`), 'latin1');
const bodyOf = (site: Site) => soundingReport(mandatory(site), WHEN, productText(`${site}.sgl.json`))!.body;
const decoded = (site: Site) => decodeUpperWind(bodyOf(site), WHEN);

/** SPC's copy, one row a level: pressure, height in metres, temperature, dew point, direction, speed. */
function spc(site: Site): number[][] {
  return readFileSync(join(DIR, `${site}.spc.txt`), 'latin1')
    .split('\n')
    .filter((l) => /^\s*[\d.]+,/.test(l))
    .map((l) => l.split(',').map((x) => Number(x.trim())));
}

describe('the winds in between', () => {
  const body = bodyOf('FGZ');
  const d = decoded('FGZ');

  it('reads each wind at the height its group names', () => {
    // 90/89 29002 10010 15505 91012 03501 16502 20501: the surface, then 8,000 and 9,000, then 10,000, 11,000 and 12,000.
    const at = (ft: number) => d.levels.find((l) => l.altitudeFt === ft);
    expect(at(8000)).toMatchObject({ directionTrue: 100, speedKt: 10, tempC: null });
    expect(at(9000)).toMatchObject({ directionTrue: 155, speedKt: 5, tempC: null });
    expect(at(10_000)).toMatchObject({ directionTrue: 35, speedKt: 1 });
    expect(at(11_000)).toMatchObject({ directionTrue: 165, speedKt: 2 });
    expect(at(12_000)).toMatchObject({ directionTrue: 205, speedKt: 1 });
  });

  it('cites each one from the height group through its own wind', () => {
    const level = d.levels.find((l) => l.altitudeFt === 9000)!;
    expect(sliceSpan(body, level.span)).toBe('90/89 29002 10010 15505');
  });

  it('adds to the mandatory levels and does not change them', () => {
    const alone = decodeUpperWind(mandatory('FGZ').trim(), WHEN);
    const ttbb = body.indexOf('TTBB');
    expect(d.levels.filter((l) => l.span.start < ttbb)).toEqual(alone.levels);
    expect(d.levels.length).toBeGreaterThan(alone.levels.length + 20);
  });

  it('has nothing at or below the ground, and the surface only once', () => {
    const ground = d.levels[0]!.altitudeFt;
    expect(d.levels.filter((l) => l.altitudeFt === ground)).toHaveLength(1);
    expect(d.levels.slice(1).every((l) => l.altitudeFt > ground)).toBe(true);
  });

  it('matches SPC wherever SPC has a wind at the same height', () => {
    let compared = 0;
    for (const site of SITES) {
      const rows = spc(site).filter((r) => r[4]! >= 0 && r[5]! >= 0);
      const body = bodyOf(site);
      for (const l of decoded(site).levels) {
        if (l.span.start < body.indexOf('PPBB')) continue;
        const row = rows.find((r) => Math.abs(r[1]! - l.altitudeFt * 0.3048) < 0.6);
        if (!row) continue;
        compared++;
        // SPC writes north as 0 where the bulletin says 360.
        if (l.directionTrue !== null) expect(row[4]! % 360, `${site} ${l.altitudeFt}`).toBeCloseTo(l.directionTrue % 360, 0);
        expect(Math.abs(row[5]! - l.speedKt), `${site} ${l.altitudeFt}`).toBeLessThanOrEqual(1.1);
      }
    }
    expect(compared).toBeGreaterThan(90);
  });
});

describe('the temperatures in between', () => {
  it('reads them at the pressures TTBB gives', () => {
    const body = bodyOf('FGZ');
    const d = decoded('FGZ');
    // 11780 07627: 780 hPa, 7.6 °C.
    const level = d.temperatures!.find((t) => sliceSpan(body, t.span) === '11780 07627')!;
    expect(level.tempC).toBe(7.6);
  });

  it('matches SPC at every level, and puts each within 140 ft of where SPC does', () => {
    for (const site of SITES) {
      const body = bodyOf(site);
      const rows = spc(site);
      const significant = decoded(site).temperatures!.filter((t) => t.span.start > body.indexOf('TTBB'));
      expect(significant.length).toBeGreaterThan(20);
      for (const t of significant) {
        const ppp = Number(sliceSpan(body, t.span).slice(2, 5));
        const row = rows.find((r) => r[0] === ppp + (ppp < 100 ? 1000 : 0) && r[2]! > -900)!;
        expect(row, `${site} ${ppp}`).toBeDefined();
        expect(t.tempC, `${site} ${ppp}`).toBeCloseTo(row[2]!, 1);
        expect(Math.abs(t.altitudeFt - row[1]! / 0.3048), `${site} ${ppp}`).toBeLessThan(140);
      }
    }
  });

  it('keeps the mandatory levels\' temperatures among them, climbing', () => {
    const d = decoded('ILN');
    for (const l of decodeUpperWind(mandatory('ILN').trim(), WHEN).levels) {
      if (l.tempC !== null) expect(d.temperatures!.some((t) => t.altitudeFt === l.altitudeFt && t.tempC === l.tempC)).toBe(true);
    }
    for (const [i, t] of d.temperatures!.entries()) if (i > 0) expect(t.altitudeFt).toBeGreaterThan(d.temperatures![i - 1]!.altitudeFt);
  });
});

describe('at the altitude flown', () => {
  it('takes the wind from the two winds around it, and cites only those', () => {
    const body = bodyOf('FGZ');
    const d = decoded('FGZ');
    const w = windAtAltitude(d.levels, 8500, d.temperatures)!;
    expect(w).toMatchObject({ directionTrue: 128, speedKt: 8, basis: 'interpolated' });
    expect(w.from.map((l) => sliceSpan(body, l.span))).toEqual(['90/89 29002 10010', '90/89 29002 10010 15505']);
  });

  it('takes the temperature from the temperatures, where the winds have none', () => {
    const d = decoded('ILN');
    const w = windAtAltitude(d.levels, 6500, d.temperatures)!;
    expect(w.from.every((l) => l.tempC === null)).toBe(true);
    expect(w.tempC).toBe(6);
  });

  it('is nearer what was measured than the mandatory levels alone can say', () => {
    const alone = decodeUpperWind(mandatory('ILN').trim(), WHEN);
    const between = windAtAltitude(alone.levels, 6500)!;
    const d = decoded('ILN');
    const full = windAtAltitude(d.levels, 6500, d.temperatures)!;
    expect([between.directionTrue, between.speedKt]).toEqual([308, 30]);
    expect([full.directionTrue, full.speedKt]).toEqual([325, 33]);
  });

  it('finds the freezing level from the temperatures, inversion and all', () => {
    expect(freezingLevel(decoded('CHS').temperatures!)).toEqual({ crossingsFt: [13300], belowFt: null, aboveFt: null });
    // Below freezing on the ground at Flagstaff, warmer straight above it, and freezing again at 13,900.
    expect(freezingLevel(decoded('FGZ').temperatures!)).toEqual({ crossingsFt: [7200, 13900], belowFt: 7149, aboveFt: null });
  });

  it('gives a level at exactly zero to the same hundred feet as any other', () => {
    // GGW has a TTBB level at 0.0 °C, which lands on a height the arithmetic left unrounded.
    const level = freezingLevel(decoded('GGW').temperatures!)!;
    expect(level.crossingsFt.every((ft) => ft % 100 === 0)).toBe(true);
  });
});

describe('what cannot be used', () => {
  it('reads every recorded flight with nothing left over', () => {
    for (const site of SITES) expect(decoded(site).unparsed, site).toEqual([]);
  });

  it('ignores a bulletin from another flight even if one is put there', () => {
    const earlier = readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'noaa', 'soundings-2026-11-09', 'usus41.kaly.man.aly.txt'), 'latin1').trim();
    const alone = decodeUpperWind(earlier, new Date('2026-11-09T04:53:45Z'));
    const mixed = decodeUpperWind(`${earlier}\n\n${productText('ALY.sgl.json').trim()}`, new Date('2026-11-09T04:53:45Z'));
    expect(mixed.levels).toEqual(alone.levels);
    expect(mixed.temperatures).toBeUndefined();
    expect(mixed.unparsed).toEqual([]);
  });

  it('has nothing to add from a balloon that sent an empty bulletin', () => {
    // Kotzebue reported nothing at 12Z: TTBB 5912/ 70133 51515 10159=
    const r = soundingReport(productText('OTZ.man.json'), WHEN, productText('OTZ.sgl.json'))!;
    const d = decodeUpperWind(r.body, WHEN);
    expect(d.levels).toEqual([]);
    expect(d.temperatures).toBeUndefined();
    expect(d.unparsed).toEqual([]);
  });

  it('reads an Alaskan pair the same way, from the product API', () => {
    const r = soundingReport(productText('ANC.man.json'), WHEN, productText('ANC.sgl.json'))!;
    const d = decodeUpperWind(r.body, WHEN);
    expect(d.unparsed).toEqual([]);
    // 90/12 30002 02015 04010: the surface, then 1,000 and 2,000 ft.
    expect(d.levels.find((l) => l.altitudeFt === 1000)).toMatchObject({ directionTrue: 20, speedKt: 15 });
    expect(d.levels.find((l) => l.altitudeFt === 2000)).toMatchObject({ directionTrue: 40, speedKt: 10 });
    expect(d.temperatures!.length).toBeGreaterThan(40);
  });
});
