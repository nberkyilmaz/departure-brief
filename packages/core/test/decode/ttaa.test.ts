/**
 * Balloon soundings, over the files NOAA held at 04:53Z on 9 November 2026:
 * one per station, the 00Z sounding in nearly all of them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeUpperWind } from '../../src/decode/upperwind/decode.js';
import { freezingLevel, windAtAltitude } from '../../src/decode/upperwind/interpolate.js';
import { sliceSpan } from '../../src/decode/span.js';
import { SOUNDING_USE_HOURS } from '../../src/decode/upperwind/ttaa.js';
import { SOUNDING_STATIONS } from '../../src/domain/soundings.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'noaa', 'soundings-2026-11-09');
const text = (name: string) => readFileSync(join(DIR, name), 'latin1').trim();
const ALBANY = text('usus41.kaly.man.aly.txt');
const WHEN = new Date('2026-11-09T04:53:45Z');
const REPORTS = readdirSync(DIR).filter((n) => n.endsWith('.txt'));

describe('a sounding', () => {
  const d = decodeUpperWind(ALBANY, WHEN);

  it('says when the balloon flew, and how long that is worth using', () => {
    expect(d.validAt!.value).toEqual(new Date('2026-11-09T00:00:00Z'));
    expect(d.useFrom!.value).toEqual(d.validAt!.value);
    expect(d.useTo!.value).toEqual(new Date(`2026-11-09T${String(SOUNDING_USE_HOURS).padStart(2, '0')}:00:00Z`));
    expect(d.bulletin!.value).toBe('USUS41');
    expect(d.issuer!.value).toBe('KALY');
    expect(sliceSpan(ALBANY, d.validAt!.span)).toBe('59001');
  });

  it('reads the ground and every pressure level, each where the balloon found it', () => {
    expect(d.levels.slice(0, 5).map((l) => [l.altitudeFt, l.directionTrue, l.speedKt, l.tempC])).toEqual([
      // Albany's own elevation: the first level is the surface, 10.0 °C, 025° at 2.
      [289, 25, 2, 10],
      // 925 hPa at 699 m.
      [2293, 260, 10, 7],
      // 850 hPa at 1,388 m.
      [4554, 265, 29, 1.4],
      // 700 hPa at 2,939 m, the odd last digit making it below zero.
      [9642, 280, 25, -4.1],
      // 500 hPa at 5,500 m.
      [18045, 245, 42, -22.3],
    ]);
    expect(d.unparsed).toEqual([]);
  });

  it('cites each level from the groups it was read from', () => {
    expect(sliceSpan(ALBANY, d.levels[2]!.span)).toBe('85388 01435 26529');
  });

  it('leaves out the level the ground is above', () => {
    // 00054 ///// /////: 1000 hPa was at 177 ft, below Albany's 289.
    expect(d.levels.some((l) => l.altitudeFt === 177)).toBe(false);
  });

  it('gives the wind between levels and the freezing level from what was measured', () => {
    expect(windAtAltitude(d.levels, 6500)).toMatchObject({ directionTrue: 271, speedKt: 27, basis: 'interpolated' });
    expect(freezingLevel(d.levels)).toEqual({ crossingsFt: [5800], belowFt: null, aboveFt: null });
  });
});

describe('every file NOAA had', () => {
  it('decodes with nothing left over, climbing, and with believable numbers', () => {
    const empty: string[] = [];
    for (const name of REPORTS) {
      const raw = text(name);
      const d = decodeUpperWind(raw, WHEN);
      if (d.levels.length === 0) empty.push(name);
      // The Yuma range file has no station in the table, and so no known ground under its first level.
      if (!name.includes('1y7')) expect(d.unparsed, name).toEqual([]);
      for (const [i, l] of d.levels.entries()) {
        expect(sliceSpan(raw, l.span), name).toMatch(/^\d{2}[\d/]{3}( |\n)/);
        if (i > 0) expect(l.altitudeFt, name).toBeGreaterThan(d.levels[i - 1]!.altitudeFt);
        expect(l.speedKt, name).toBeLessThan(250);
        if (l.tempC !== null) expect(Math.abs(l.tempC), name).toBeLessThan(90);
      }
    }
    // The balloons that reported no levels at all, with the 5900/ that says so.
    expect(empty).toEqual(['usus43.koax.man.oax.txt', 'usus44.kewx.man.drt.txt', 'usus45.ktwc.man.twc.txt']);
  });

  it('puts the first level of a high station at its own ground, and nothing below it', () => {
    const flagstaff = decodeUpperWind(text('usus45.kfgz.man.fgz.txt'), WHEN);
    expect(flagstaff.levels[0]!.altitudeFt).toBe(7149);
    expect(flagstaff.levels.every((l) => l.altitudeFt >= 7149)).toBe(true);
  });

  it('has a station in the table for every balloon file but the Yuma range one', () => {
    const inFiles = REPORTS.filter((n) => !n.includes('1y7')).map((n) => n.replace('.txt', '')).sort();
    expect(inFiles).toEqual(SOUNDING_STATIONS.map((s) => s.file).sort());
  });

  it('reads no wind above the level the bulletin says winds stop at', () => {
    // A special from the Yuma range in July: 72174 says winds end at 400 hPa.
    const raw = text('usus45.kpsr.man.1y7.txt');
    const d = decodeUpperWind(raw, new Date('2026-07-22T18:00:00Z'));
    expect(d.validAt!.value).toEqual(new Date('2026-07-22T17:00:00Z'));
    expect(sliceSpan(raw, d.levels.at(-1)!.span)).toMatch(/^40\d{3} /);
    expect(d.unparsed).toEqual(['99997 36274 24502']);
  });
});
