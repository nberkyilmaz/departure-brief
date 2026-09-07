import { describe, expect, it } from 'vitest';
import {
  ceiling,
  decodeMetar,
  flightCategory,
  observationTime,
  visibilityStatuteMiles,
  windKnots,
} from '../../../src/decode/metar/index.js';
import { at } from '../../helpers/span.js';

describe('ceiling', () => {
  it('is the lowest BKN/OVC layer', () => {
    const raw = 'KXYZ 071100Z 00000KT 10SM FEW009 SCT050 BKN110 OVC150 21/20 A2987';
    expect(ceiling(decodeMetar(raw))).toEqual({ value: 11000, span: at(raw, 'BKN110') });
  });

  it('uses vertical visibility', () => {
    const raw = 'KXYZ 071100Z 00000KT 1/4SM FG VV002 10/10 A3013';
    expect(ceiling(decodeMetar(raw))).toEqual({ value: 200, span: at(raw, 'VV002') });
  });

  it('is null with only FEW/SCT, CLR, or an unreported height', () => {
    expect(ceiling(decodeMetar('KXYZ 071100Z 00000KT 10SM FEW009 SCT050 21/20 A2987'))).toBeNull();
    expect(ceiling(decodeMetar('KXYZ 071100Z 00000KT 10SM CLR 21/20 A2987'))).toBeNull();
    expect(ceiling(decodeMetar('KXYZ 071100Z 00000KT 10SM BKN/// 21/20 A2987'))).toBeNull();
  });

  it('picks the lowest even when layers are out of height order', () => {
    const raw = 'KXYZ 071100Z 00000KT 10SM OVC050 BKN020 21/20 A2987';
    expect(ceiling(decodeMetar(raw))?.value).toBe(2000);
  });
});

describe('visibilityStatuteMiles', () => {
  it('passes statute through and converts metric', () => {
    expect(visibilityStatuteMiles({ kind: 'statute', miles: 2.5 as never, qualifier: null })).toBe(2.5);
    expect(visibilityStatuteMiles({ kind: 'meters', meters: 1609.344 as never, direction: null, minimum: null })).toBeCloseTo(1);
    expect(visibilityStatuteMiles({ kind: 'meters', meters: 9999 as never, direction: null, minimum: null })).toBeCloseTo(6.21, 2);
    expect(visibilityStatuteMiles({ kind: 'cavok' })).toBeCloseTo(6.21, 2);
    expect(visibilityStatuteMiles({ kind: 'missing' })).toBeNull();
  });
});

describe('flightCategory', () => {
  const cases: [string, string | null][] = [
    ['KXYZ 071100Z 00000KT 10SM FEW045 SCT250 09/M04 A3012', 'VFR'],
    ['KXYZ 071100Z 00000KT 10SM CLR 09/M04 A3012', 'VFR'],
    ['KXYZ 071100Z 00000KT 6SM BKN035 09/M04 A3012', 'VFR'],
    ['KXYZ 071100Z 00000KT 5SM HZ BKN035 09/M04 A3012', 'MVFR'],
    ['KXYZ 071100Z 00000KT 10SM BKN030 09/M04 A3012', 'MVFR'],
    ['KXYZ 071100Z 00000KT 10SM OVC010 09/M04 A3012', 'MVFR'],
    ['KXYZ 071100Z 00000KT 10SM OVC009 09/M04 A3012', 'IFR'],
    ['KXYZ 071100Z 00000KT 2 1/2SM BR SCT020 09/M04 A3012', 'IFR'],
    ['KXYZ 071100Z 00000KT 3SM BR OVC005 09/M04 A3012', 'IFR'],
    ['KXYZ 071100Z 00000KT 1/4SM FG VV001 10/10 A3013', 'LIFR'],
    ['KXYZ 071100Z 00000KT 10SM OVC004 10/10 A3013', 'LIFR'],
    ['KXYZ 071100Z 00000KT 3/4SM BR OVC020 10/10 A3013', 'LIFR'],
    ['UUWW 071100Z 31007MPS 9999 BKN046 12/05 Q1013', 'VFR'],
    // 6000 m ≈ 3.7 SM → MVFR on visibility; 4000 m ≈ 2.5 SM → IFR.
    ['UUWW 071100Z 31007MPS 6000 BR BKN046 12/05 Q1013', 'MVFR'],
    ['UUWW 071100Z 31007MPS 4000 BR BKN046 12/05 Q1013', 'IFR'],
    ['UUWW 071100Z 31007MPS CAVOK 12/05 Q1013', 'VFR'],
    ['KXYZ 071100Z 00000KT BKN020 12/05 A3013', 'MVFR'],
    ['KXYZ 071100Z 00000KT 12/05 A3013', null],
    ['KXYZ 071100Z 00000KT //// BKN/// 12/05 A3013', null],
  ];
  it.each(cases)('%s → %s', (raw, expected) => {
    expect(flightCategory(decodeMetar(raw))).toBe(expected);
  });
});

describe('windKnots', () => {
  it('converts MPS and KMH, passes KT through', () => {
    expect(windKnots(decodeMetar('KXYZ 071100Z 28016G24KT').wind!.value)).toEqual({ speed: 16, gust: 24 });
    const mps = windKnots(decodeMetar('UUWW 071100Z 31010MPS').wind!.value);
    expect(mps.speed).toBeCloseTo(19.44, 1);
    expect(mps.gust).toBeNull();
    const kmh = windKnots(decodeMetar('XXXX 071100Z 31037KMH').wind!.value);
    expect(kmh.speed).toBeCloseTo(20, 0);
    expect(windKnots(decodeMetar('KXYZ 071100Z /////KT').wind!.value)).toEqual({ speed: null, gust: null });
  });
});

describe('observationTime', () => {
  it('resolves against a reference instant', () => {
    const m = decodeMetar('KJFK 071104Z 00000KT 10SM CLR 10/10 A3013');
    expect(observationTime(m, new Date('2026-09-07T12:00:00Z'))?.toISOString()).toBe('2026-09-07T11:04:00.000Z');
    expect(observationTime(decodeMetar('KJFK'), new Date())).toBeNull();
  });
});
