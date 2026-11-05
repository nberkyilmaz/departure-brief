/**
 * The US winds aloft bulletin, over the last ones NOAA issued before the
 * NAM was retired on 3 November 2026: FBUS31, 33 and 35, FBAK31 and FBHW31
 * from 08:01Z that morning, exactly as tgftp.nws.noaa.gov served them.
 * Every expected value is read off the bulletin by eye.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeUpperWind } from '../../src/decode/upperwind/decode.js';
import { decodeFbWinds, splitFbBulletin } from '../../src/decode/upperwind/fb.js';
import { sliceSpan } from '../../src/decode/span.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'awc', 'windtemp');
const bulletin = (name: string) => readFileSync(join(DIR, `${name}.txt`), 'utf8');
const ISSUED = new Date('2026-11-03T08:01:00Z');

function site(name: string, id: string) {
  const excerpt = splitFbBulletin(bulletin(name)).find((e) => e.id === id);
  if (!excerpt) throw new Error(`${id} is not in ${name}`);
  return { excerpt, decoded: decodeFbWinds(excerpt.body, ISSUED) };
}

const at = (d: ReturnType<typeof decodeFbWinds>, ft: number) => d.levels.find((l) => l.altitudeFt === ft);

describe('splitFbBulletin', () => {
  it('gives every site its own excerpt, header and altitude row included', () => {
    const excerpts = splitFbBulletin(bulletin('fbus31.kwno.fd1.us1'));
    expect(excerpts.length).toBeGreaterThan(170);
    expect(excerpts.map((e) => e.id)).toEqual(expect.arrayContaining(['BOS', 'JFK', 'MIA', 'ABQ', 'ELP', 'EYW']));
    const bos = excerpts.find((e) => e.id === 'BOS')!;
    expect(bos.issued).toEqual({ day: 3, hour: 8, minute: 1 });
    expect(bos.body.split('\n')[0]).toBe('FBUS31 KWNO 030801');
    expect(bos.body.split('\n').at(-1)).toBe('BOS 2710 2815+09 2916+02 2822-03 3038-12 3152-22 335439 335749 335861');
  });

  it('drops the wire’s control characters, which a page cannot show', () => {
    expect(bulletin('fbus31.kwno.fd1.us1')).toContain('\x1e');
    for (const e of splitFbBulletin(bulletin('fbus31.kwno.fd1.us1'))) expect(e.body).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  });

  it('finds nothing in something that is not a bulletin', () => {
    expect(splitFbBulletin('')).toEqual([]);
    expect(splitFbBulletin('<html>maintenance</html>')).toEqual([]);
  });
});

describe('decodeFbWinds', () => {
  it('reads the times off the header, with the month and year from the issue time', () => {
    const { decoded } = site('fbus31.kwno.fd1.us1', 'BOS');
    expect(decoded.bulletin?.value).toBe('FBUS31');
    expect(decoded.issuer?.value).toBe('KWNO');
    expect(decoded.issuedAt?.value.toISOString()).toBe('2026-11-03T08:01:00.000Z');
    expect(decoded.basedOn?.value.toISOString()).toBe('2026-11-03T06:00:00.000Z');
    expect(decoded.validAt?.value.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(decoded.useFrom?.value.toISOString()).toBe('2026-11-03T08:00:00.000Z');
    expect(decoded.useTo?.value.toISOString()).toBe('2026-11-03T15:00:00.000Z');
  });

  it('carries a use window across midnight', () => {
    // FD3: valid 18Z, for use 15Z to midnight.
    const twelve = site('fbus33.kwno.fd3.us3', 'BOS').decoded;
    expect(twelve.useFrom?.value.toISOString()).toBe('2026-11-03T15:00:00.000Z');
    expect(twelve.useTo?.value.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    // FD5: valid 06Z the next day, for use from midnight to noon.
    const day = site('fbus35.kwno.fd5.us5', 'BOS').decoded;
    expect(day.validAt?.value.toISOString()).toBe('2026-11-04T06:00:00.000Z');
    expect(day.useFrom?.value.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(day.useTo?.value.toISOString()).toBe('2026-11-04T12:00:00.000Z');
  });

  it('reads every group of a full line, with the temperature sign as sent', () => {
    // BOS 2710 2815+09 2916+02 2822-03 3038-12 3152-22 335439 335749 335861
    const { excerpt, decoded } = site('fbus31.kwno.fd1.us1', 'BOS');
    expect(decoded.unparsed).toEqual([]);
    expect(decoded.levels.map((l) => l.altitudeFt)).toEqual([3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000]);
    expect(at(decoded, 3000)).toMatchObject({ directionTrue: 270, speedKt: 10, tempC: null });
    expect(at(decoded, 6000)).toMatchObject({ directionTrue: 280, speedKt: 15, tempC: 9 });
    expect(at(decoded, 12000)).toMatchObject({ directionTrue: 280, speedKt: 22, tempC: -3 });
    // Above 24,000 ft the sign is left off and the temperature is negative.
    expect(at(decoded, 30000)).toMatchObject({ directionTrue: 330, speedKt: 54, tempC: -39 });
    // Every level cites its own group.
    expect(sliceSpan(excerpt.body, at(decoded, 6000)!.span)).toBe('2815+09');
    expect(sliceSpan(excerpt.body, at(decoded, 39000)!.span)).toBe('335861');
  });

  it('puts each group under the altitude it is aligned with, not the next free one', () => {
    // ELP      3516    3013+06 ... — no 3,000 ft group, and no temperature at 6,000.
    const elp = site('fbus31.kwno.fd1.us1', 'ELP').decoded;
    expect(at(elp, 3000)).toBeUndefined();
    expect(at(elp, 6000)).toMatchObject({ directionTrue: 350, speedKt: 16, tempC: null });
    expect(at(elp, 9000)).toMatchObject({ directionTrue: 300, speedKt: 13, tempC: 6 });
    // ALS starts at 12,000: the field is at 7,500 ft.
    const als = site('fbus31.kwno.fd1.us1', 'ALS').decoded;
    expect(als.levels[0]).toMatchObject({ altitudeFt: 12000, directionTrue: 10, speedKt: 20, tempC: -5 });
    expect(als.unparsed).toEqual([]);
  });

  it('reads light and variable, and winds of a hundred knots and more', () => {
    // LAS ... 9900+10 ... 770357
    const las = site('fbus31.kwno.fd1.us1', 'LAS').decoded;
    expect(at(las, 9000)).toMatchObject({ directionTrue: null, speedKt: 0, tempC: 10 });
    expect(at(las, 39000)).toMatchObject({ directionTrue: 270, speedKt: 103, tempC: -57 });
    // ABQ ... 810245: 310 degrees at 102 knots, minus 45.
    expect(at(site('fbus31.kwno.fd1.us1', 'ABQ').decoded, 34000)).toMatchObject({ directionTrue: 310, speedKt: 102, tempC: -45 });
  });

  it('reads Alaska and Hawaii, whose altitude rows differ', () => {
    // FAI 9900 2107-04 ...
    const fai = site('fbak31.kwno.fd1.ak1', 'FAI').decoded;
    expect(at(fai, 3000)).toMatchObject({ directionTrue: null, speedKt: 0 });
    expect(at(fai, 6000)).toMatchObject({ directionTrue: 210, speedKt: 7, tempC: -4 });
    // LIH 0618 0621 0722 0725 0919+11 ... from 1,000 ft up.
    const lih = site('fbhw31.kwno.fd1.hw1', 'LIH').decoded;
    expect(lih.levels.slice(0, 4).map((l) => [l.altitudeFt, l.directionTrue, l.speedKt])).toEqual([
      [1000, 60, 18],
      [1500, 60, 21],
      [2000, 70, 22],
      [3000, 70, 25],
    ]);
    expect(at(lih, 6000)).toMatchObject({ directionTrue: 90, speedKt: 19, tempC: 11 });
  });

  it('reads the header the AWC API puts on the same bulletin', () => {
    const bos = site('fbus31.kwno.fd1.us1', 'BOS').excerpt.body.replace('FBUS31 KWNO 030801', '(Extracted from FBUS31 KWNO 030801)');
    const decoded = decodeFbWinds(bos, ISSUED);
    expect(decoded.bulletin?.value).toBe('FBUS31');
    expect(decoded.useTo?.value.toISOString()).toBe('2026-11-03T15:00:00.000Z');
    expect(decoded.levels).toHaveLength(9);
  });

  it('keeps what it cannot read rather than guessing', () => {
    const bos = site('fbus31.kwno.fd1.us1', 'BOS').excerpt.body.replace('2916+02', '29X6+02');
    const decoded = decodeFbWinds(bos, ISSUED);
    expect(decoded.unparsed).toEqual(['29X6+02']);
    expect(at(decoded, 9000)).toBeUndefined();
    expect(decoded.levels).toHaveLength(8);
  });

  it.each(['fbus31.kwno.fd1.us1', 'fbus33.kwno.fd3.us3', 'fbus35.kwno.fd5.us5', 'fbak31.kwno.fd1.ak1', 'fbhw31.kwno.fd1.hw1'])(
    'reads every group at every site of %s, leaving nothing over',
    (name) => {
      const excerpts = splitFbBulletin(bulletin(name));
      // Hawaii has six sites; the lower 48 have nearly two hundred.
      expect(excerpts.length).toBeGreaterThanOrEqual(6);
      const leftovers = excerpts
        .map((e) => ({ id: e.id, d: decodeFbWinds(e.body, ISSUED) }))
        .filter(({ d }) => d.unparsed.length > 0 || d.levels.length === 0 || !d.useFrom || !d.useTo)
        .map(({ id, d }) => `${id}: ${d.unparsed.join(' ')}`);
      expect(leftovers).toEqual([]);
    },
  );

  it('is what decodeUpperWind hands a US bulletin to', () => {
    const { excerpt, decoded } = site('fbus31.kwno.fd1.us1', 'JFK');
    expect(decodeUpperWind(excerpt.body, ISSUED)).toEqual(decoded);
  });
});
