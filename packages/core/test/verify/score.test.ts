import { describe, expect, it } from 'vitest';
import { reliabilityNote, reliabilityOf, reliabilityText, scorePair } from '../../src/verify/score.js';
import type { ForecastCheck, ForecastOutcome, VerificationPair } from '../../src/verify/types.js';

let n = 0;
function pair(forecast: Partial<ForecastCheck>, observed: Partial<ForecastOutcome>): VerificationPair {
  const key = `k${n++}`;
  const validAt = new Date(Date.UTC(2026, 8, 1 + (n % 20), 15, 0));
  return {
    check: {
      key,
      station: 'CYSN',
      validAt,
      tafSha256: 'taf',
      tafIssuedAt: new Date(validAt.getTime() - 4 * 3_600_000),
      tafDecoderVersion: 1,
      leadHours: 4,
      ceilingFt: null,
      visibilitySm: null,
      visibilityAtLeast: false,
      windDirTrue: null,
      windKt: null,
      gustKt: null,
      category: null,
      overlayWorstCategory: null,
      createdAt: validAt,
      ...forecast,
    },
    outcome: {
      checkKey: key,
      metarSha256: 'metar',
      observedAt: validAt,
      offsetMinutes: 0,
      ceilingFt: null,
      visibilitySm: null,
      visibilityAtLeast: false,
      windDirTrue: null,
      windKt: null,
      gustKt: null,
      category: null,
      matchedAt: validAt,
      ...observed,
    },
  };
}

describe('scorePair', () => {
  it('calls a forecast optimistic when it promised better than arrived', () => {
    const s = scorePair(pair({ ceilingFt: 3000, category: 'VFR' }, { ceilingFt: 900, category: 'IFR' }));
    expect(s.ceilingErrorFt).toBe(-2100);
    expect(s.ceiling).toBe('optimistic');
    expect(s.categoryMatched).toBe(false);
  });

  it('calls it pessimistic when it turned out better than promised', () => {
    const s = scorePair(pair({ ceilingFt: 800, visibilitySm: 2, category: 'IFR' }, { ceilingFt: 4000, visibilitySm: 10, category: 'VFR' }));
    expect(s.ceiling).toBe('pessimistic');
    expect(s.visibility).toBe('pessimistic');
  });

  it('treats "at least six miles" as satisfied by anything at or above six', () => {
    // Every fair-weather TAF says P6SM, and observations of 10SM are routine;
    // scoring that as a miss would measure the phrasing, not the forecast.
    const met = scorePair(pair({ visibilitySm: 6, visibilityAtLeast: true }, { visibilitySm: 10 }));
    expect(met.visibility).toBe('close');
    // And no error either: six-or-better that got ten is not four miles wrong.
    expect(met.visibilityErrorSm).toBeNull();
    expect(met.observed.visibilitySm).toBe(10);
    // A shortfall against the same forecast is still a miss.
    expect(scorePair(pair({ visibilitySm: 6, visibilityAtLeast: true }, { visibilitySm: 2 })).visibility).toBe('optimistic');
    // An exact forecast is compared exactly.
    expect(scorePair(pair({ visibilitySm: 6, visibilityAtLeast: false }, { visibilitySm: 10 })).visibility).toBe('pessimistic');
  });

  it('ignores a miss too small to mean anything', () => {
    expect(scorePair(pair({ ceilingFt: 3000 }, { ceilingFt: 2900 })).ceiling).toBe('close');
    expect(scorePair(pair({ visibilitySm: 6 }, { visibilitySm: 5.7 })).visibility).toBe('close');
    // Just outside the tolerance is a miss again.
    expect(scorePair(pair({ ceilingFt: 3000 }, { ceilingFt: 2750 })).ceiling).toBe('optimistic');
  });

  it('notices when the TAF had allowed for it in a TEMPO, and when it had not', () => {
    const covered = scorePair(pair({ ceilingFt: 3000, category: 'VFR', overlayWorstCategory: 'IFR' }, { ceilingFt: 800, category: 'IFR' }));
    expect(covered.overlayCovered).toBe(true);
    const blind = scorePair(pair({ ceilingFt: 3000, category: 'VFR', overlayWorstCategory: 'MVFR' }, { ceilingFt: 400, category: 'LIFR' }));
    expect(blind.overlayCovered).toBe(false);
    // An overlay is only a defence when the forecast was actually wrong.
    const right = scorePair(pair({ category: 'VFR', overlayWorstCategory: 'IFR' }, { category: 'VFR' }));
    expect(right.overlayCovered).toBe(false);
  });

  it('says nothing rather than something wrong when a value is missing', () => {
    const s = scorePair(pair({ ceilingFt: null, category: 'VFR' }, { ceilingFt: 600, category: 'IFR' }));
    expect(s.ceilingErrorFt).toBeNull();
    expect(s.ceiling).toBeNull();
    // The arithmetic could not see it, but the category comparison did.
    expect(s.categoryMatched).toBe(false);
  });
});

describe('reliabilityOf', () => {
  /** Ten checks where the ceiling came in lower than forecast four times. */
  const pairs: VerificationPair[] = [
    ...Array.from({ length: 4 }, () => pair({ ceilingFt: 3000, visibilitySm: 6, category: 'VFR' }, { ceilingFt: 1200, visibilitySm: 5.8, category: 'MVFR' })),
    ...Array.from({ length: 5 }, () => pair({ ceilingFt: 2500, visibilitySm: 6, category: 'MVFR' }, { ceilingFt: 2450, visibilitySm: 6, category: 'MVFR' })),
    pair({ ceilingFt: 1000, visibilitySm: 3, category: 'IFR' }, { ceilingFt: 5000, visibilitySm: 9, category: 'VFR' }),
  ];

  it('counts which way the misses went, and how big the worst one was', () => {
    const r = reliabilityOf('CYSN', pairs);
    expect(r.pairs).toBe(10);
    expect(r.ceiling.compared).toBe(10);
    expect(r.ceiling.optimistic).toBe(4);
    expect(r.ceiling.close).toBe(5);
    expect(r.ceiling.pessimistic).toBe(1);
    expect(r.ceiling.worstOptimistic).toBe(-1800);
    expect(r.categoryAgreement).toBeCloseTo(0.5, 5);
    expect(r.categoryOptimistic).toBe(4);
  });

  it('reports the median signed error, which says the typical direction', () => {
    const r = reliabilityOf('CYSN', pairs);
    // Four at -1800, five at -50, one at +4000.
    expect(r.ceiling.medianError).toBe(-50);
  });

  it('says nothing at all about a station it has barely seen', () => {
    expect(reliabilityNote(reliabilityOf('CYSN', pairs.slice(0, 3)))).toBeNull();
    expect(reliabilityNote(reliabilityOf('CYSN', []))).toBeNull();
  });

  it('leads with the direction that matters, in words a pilot can act on', () => {
    const note = reliabilityNote(reliabilityOf('CYSN', pairs))!;
    expect(note).toContain('CYSN');
    expect(note).toContain('forecast the ceiling higher than it turned out');
    expect(note).toContain('40%');
    expect(note).toContain('1800 ft');
  });

  it('falls back to plain category agreement when nothing is biased enough to report', () => {
    const steady = Array.from({ length: 10 }, () => pair({ ceilingFt: 3000, visibilitySm: 6, category: 'VFR' }, { ceilingFt: 3050, visibilitySm: 6, category: 'VFR' }));
    const note = reliabilityNote(reliabilityOf('CYKF', steady))!;
    expect(note).toContain('matched the observed flight category in 100%');
  });

  it('renders a table that explains what optimistic means', () => {
    const text = reliabilityText(reliabilityOf('CYSN', pairs));
    expect(text).toContain('10 forecasts checked');
    expect(text).toContain('ceiling');
    expect(text).toContain('promised better than arrived');
  });
});
