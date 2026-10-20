/**
 * Upper winds, over the records NAV CANADA actually served on 14 September
 * 2026 for Toronto and Ottawa. Nothing here is hand-written: the fixtures
 * are the responses verbatim, and the assertions are read off them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeUpperWind } from '../../src/decode/upperwind/decode.js';
import { interpolateDegrees, windAtAltitude, windComponents } from '../../src/decode/upperwind/interpolate.js';
import { sliceSpan } from '../../src/decode/span.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'navcanada', 'upperwind', '2026-09-14');

interface CfpsRecord {
  readonly location: string;
  readonly startValidity: string;
  readonly endValidity: string;
  readonly text: string;
}

function records(site: string): CfpsRecord[] {
  return (JSON.parse(readFileSync(join(DIR, `${site}.json`), 'utf8')) as { data: CfpsRecord[] }).data;
}

/** The low-level bulletin: the one a light aircraft is reading. */
function lowLevel(site: string): CfpsRecord {
  const found = records(site).find((r) => decodeUpperWind(r.text).levels.some((l) => l.altitudeFt === 3000));
  if (!found) throw new Error(`no low-level record for ${site}`);
  return found;
}

describe('decodeUpperWind', () => {
  it('reads a real Toronto record, and every value points at the text it came from', () => {
    const record = lowLevel('CYYZ');
    const d = decodeUpperWind(record.text);

    expect(d.bulletin?.value).toMatch(/^FBCN3[135]$/);
    // The low levels are Canada's own office; the levels above come from the US.
    expect(d.issuer?.value).toBe('CWAO');
    expect(d.unparsed).toEqual([]);

    // Spans index into the record as the service sent it.
    expect(sliceSpan(record.text, d.bulletin!.span)).toBe(`"${d.bulletin!.value}"`);
    for (const level of d.levels) {
      const cited = sliceSpan(record.text, level.span);
      expect(cited.startsWith(`[${level.altitudeFt},`)).toBe(true);
      expect(cited).toContain(String(level.speedKt));
    }

    // A light aircraft's levels, climbing, whatever order they arrived in.
    expect(d.levels.map((l) => l.altitudeFt)).toEqual([3000, 6000, 9000, 12000, 18000]);
    for (const level of d.levels) {
      expect(level.speedKt).toBeGreaterThanOrEqual(0);
      if (level.directionTrue !== null) expect(level.directionTrue).toBeGreaterThanOrEqual(0);
      if (level.directionTrue !== null) expect(level.directionTrue).toBeLessThanOrEqual(360);
    }
    // No temperature is forecast at 3,000 ft, where it would be the surface's.
    expect(d.levels[0]!.tempC).toBeNull();
    expect(d.levels[d.levels.length - 1]!.tempC).not.toBeNull();
  });

  it('reads the high-level bulletin as a separate forecast, not a continuation', () => {
    // CWAO covers 3,000 to 18,000 and KWNO the levels above: a briefing that
    // assumed one record held every level would be missing half the column.
    const high = records('CYYZ').find((r) => decodeUpperWind(r.text).issuer?.value === 'KWNO');
    const d = decodeUpperWind(high!.text);
    expect(d.levels.every((l) => l.altitudeFt >= 24000)).toBe(true);
    expect(d.levels.some((l) => l.altitudeFt === 3000)).toBe(false);
  });

  it('carries the window the forecast is to be used for', () => {
    const d = decodeUpperWind(lowLevel('CYOW').text);
    expect(d.useFrom!.value.getTime()).toBeLessThan(d.useTo!.value.getTime());
    expect(d.validAt!.value.getTime()).toBeGreaterThanOrEqual(d.basedOn!.value.getTime());
    // Three bulletins a day, each covering its own stretch of it.
    expect(d.useTo!.value.getTime() - d.useFrom!.value.getTime()).toBeLessThanOrEqual(13 * 3_600_000);
  });

  it('reports light and variable as having no direction rather than as northerly', () => {
    // The service sends a null direction with zero speed; 000 at 0 kt would
    // read as a wind from true north, which is not what it means.
    const d = decodeUpperWind(JSON.stringify(['FBCN35', 'CWAO', null, null, null, null, null, null, null, null, [[3000, null, 0, null, 0]]]));
    expect(d.levels[0]!.directionTrue).toBeNull();
    expect(d.levels[0]!.speedKt).toBe(0);
  });

  it('keeps what it could not read instead of dropping it', () => {
    const d = decodeUpperWind(JSON.stringify(['FBCN31', 'CWAO', null, null, null, null, null, null, null, null, [[3000, 330, 24, null, 0], 'nonsense', [null, 1, 2, 3, 0]]]));
    expect(d.levels).toHaveLength(1);
    expect(d.unparsed).toHaveLength(2);
  });

  it('returns nothing decodable rather than throwing on rubbish', () => {
    for (const bad of ['', 'not json', '{}', '[]']) {
      const d = decodeUpperWind(bad);
      expect(d.levels).toEqual([]);
    }
  });
});

describe('windAtAltitude', () => {
  const levels = decodeUpperWind(lowLevel('CYYZ').text).levels;

  it('uses a forecast level as it stands', () => {
    const at = windAtAltitude(levels, 6000)!;
    expect(at.basis).toBe('level');
    expect(at.speedKt).toBe(levels.find((l) => l.altitudeFt === 6000)!.speedKt);
    expect(at.from).toHaveLength(1);
  });

  it('interpolates between the two levels a light aircraft flies between', () => {
    const at = windAtAltitude(levels, 4500)!;
    const below = levels.find((l) => l.altitudeFt === 3000)!;
    const above = levels.find((l) => l.altitudeFt === 6000)!;
    expect(at.basis).toBe('interpolated');
    expect(at.from).toEqual([below, above]);
    expect(at.speedKt).toBeGreaterThanOrEqual(Math.min(below.speedKt, above.speedKt));
    expect(at.speedKt).toBeLessThanOrEqual(Math.max(below.speedKt, above.speedKt));
  });

  it('says when it is reporting the lowest or highest level rather than the asked-for altitude', () => {
    // Below 3,000 the forecast has nothing to say: friction and terrain
    // take over, and pretending otherwise would be inventing a surface wind.
    expect(windAtAltitude(levels, 1500)!.basis).toBe('below-lowest');
    expect(windAtAltitude(levels, 30000)!.basis).toBe('above-highest');
    expect(windAtAltitude([], 3500)).toBeNull();
  });

  it('goes the short way round the compass', () => {
    expect(interpolateDegrees(350, 10, 0.5)).toBe(0);
    expect(interpolateDegrees(10, 350, 0.5)).toBe(0);
    expect(interpolateDegrees(90, 270, 0)).toBe(90);
    // Exactly opposite: no short way, so clockwise by definition.
    expect(interpolateDegrees(0, 180, 0.5)).toBe(90);

    const made = [
      { altitudeFt: 3000, directionTrue: 350, speedKt: 20, tempC: null, span: { start: 0, end: 1 } },
      { altitudeFt: 6000, directionTrue: 10, speedKt: 30, tempC: -2, span: { start: 1, end: 2 } },
    ];
    const at = windAtAltitude(made, 4500)!;
    expect(at.directionTrue).toBe(0);
    expect(at.speedKt).toBe(25);
  });

  it('carries the direction that exists when the other level is light and variable', () => {
    const made = [
      { altitudeFt: 3000, directionTrue: null, speedKt: 0, tempC: null, span: { start: 0, end: 1 } },
      { altitudeFt: 6000, directionTrue: 270, speedKt: 20, tempC: 4, span: { start: 1, end: 2 } },
    ];
    const at = windAtAltitude(made, 4500)!;
    expect(at.directionTrue).toBe(270);
    expect(at.speedKt).toBe(10);
    expect(at.tempC).toBe(4);
  });
});

describe('windComponents', () => {
  it('splits the wind along and across the course', () => {
    // Straight down the nose.
    expect(windComponents(360, { directionTrue: 360, speedKt: 20 })).toEqual({ headwindKt: 20, crosswindKt: 0 });
    // Straight up the tail.
    expect(windComponents(360, { directionTrue: 180, speedKt: 20 })).toEqual({ headwindKt: -20, crosswindKt: 0 });
    // Square on from the right, then from the left.
    expect(windComponents(360, { directionTrue: 90, speedKt: 20 })).toEqual({ headwindKt: 0, crosswindKt: 20 });
    expect(windComponents(360, { directionTrue: 270, speedKt: 20 })).toEqual({ headwindKt: -0, crosswindKt: -20 });
  });

  it('is 45 degrees off at the value every pilot knows', () => {
    const c = windComponents(360, { directionTrue: 45, speedKt: 20 })!;
    // Seven tenths, which is why 45° off is "about three quarters of it".
    expect(c.headwindKt).toBeCloseTo(14.1, 1);
    expect(c.crosswindKt).toBeCloseTo(14.1, 1);
  });

  it('has nothing to say about a wind with no direction', () => {
    expect(windComponents(360, { directionTrue: null, speedKt: 0 })).toBeNull();
  });
});
