/**
 * Weight and balance against the 172M POH's own numbers. The POH prints a
 * worked example (figure 6-5); the computation must reproduce it exactly.
 */
import { describe, expect, it } from 'vitest';
import { computeLoading, forwardLimitAt, IncompleteSpecError, loadingText } from '../../src/wb/compute.js';
import type { Loading } from '../../src/wb/types.js';
import { transcribed, transcribedSpec } from '../helpers/wbspec.js';

const spec = transcribedSpec();
const t = transcribed();

/** The POH sample loading: sample airplane, full oil, 38 gal, two up front, two in the back, 11 lb in baggage 1. */
const sampleLoading: Loading = {
  emptyWeightLb: 1366,
  emptyMomentPer1000: 53.8,
  stations: { front: 340, rear: 340, bag1: 11, bag2: 0 },
  fuelGal: { fuel: 38 },
  category: 'normal',
};

describe('forwardLimitAt', () => {
  const normal = spec.envelopes[0]!;
  it('is flat below the first point, linear between points, flat above the last', () => {
    expect(forwardLimitAt(normal, 1800)).toBe(35.0);
    expect(forwardLimitAt(normal, 1950)).toBe(35.0);
    expect(forwardLimitAt(normal, 2125)).toBeCloseTo(36.75, 6);
    expect(forwardLimitAt(normal, 2300)).toBe(38.5);
    expect(forwardLimitAt(normal, 2400)).toBe(38.5);
  });
});

describe('computeLoading', () => {
  it('reproduces the POH sample loading problem to the printed figures', () => {
    const r = computeLoading(spec, sampleLoading);
    expect(r.totalWeightLb).toBe(t.sampleLoadingProblem.totalWeightLb);
    expect(r.totalMomentPer1000).toBe(t.sampleLoadingProblem.totalMomentPer1000);
    // 102.9 / 2300 * 1000
    expect(r.cgIn).toBe(44.7);
    expect(r.verdict).toBe('within-limits');
    expect(r.limits).toEqual({ maxWeightLb: 2300, forwardArmIn: 38.5, aftArmIn: 47.3 });
    // Each row's moment matches what the POH printed for it.
    const byLabel = Object.fromEntries(r.rows.map((row) => [row.label, row.momentPer1000]));
    expect(byLabel['Oil']).toBe(-0.2);
    expect(byLabel['Fuel (standard tanks)']).toBe(10.9);
    // 12.6, not the 12.8 the scan's OCR shows: 340 lb at 37 in is 12,580 lb-in,
    // and only 12.6 makes the page's own total of 102.9 add up.
    expect(byLabel['Pilot and front passenger']).toBe(12.6);
    expect(byLabel['Rear passengers']).toBe(24.8);
    expect(byLabel['Baggage area 1']).toBe(1.0);
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([
      ['wb.weight', 'routine'],
      ['wb.cg.forward', 'routine'],
      ['wb.cg.aft', 'routine'],
    ]);
  });

  it('flags over-weight, an aft CG, and a baggage area over its limit, each citing the limit it broke', () => {
    const heavy = computeLoading(spec, { ...sampleLoading, stations: { front: 400, rear: 400, bag1: 120, bag2: 50 }, fuelGal: { fuel: 38 } });
    expect(heavy.verdict).toBe('outside-limits');
    expect(heavy.findings.find((f) => f.rule === 'wb.weight')!.severity).toBe('alert');
    expect(heavy.findings.find((f) => f.rule === 'wb.baggage')!.summary).toContain('combined 120 lb');
    expect(heavy.totalWeightLb).toBe(1366 + 15 + 228 + 400 + 400 + 120 + 50);

    // Light up front, everything in the back: aft of 47.3.
    const aft = computeLoading(spec, { ...sampleLoading, stations: { front: 120, rear: 340, bag1: 120, bag2: 0 }, fuelGal: { fuel: 10 } });
    expect(aft.cgIn).toBeGreaterThan(47.3);
    expect(aft.findings.find((f) => f.rule === 'wb.cg.aft')!.severity).toBe('alert');
    expect(aft.verdict).toBe('outside-limits');

    // Utility category: 2000 lb and 40.5 in aft; the sample loading is well outside it.
    const util = computeLoading(spec, { ...sampleLoading, category: 'utility' });
    expect(util.limits).toEqual({ maxWeightLb: 2000, forwardArmIn: 35.5, aftArmIn: 40.5 });
    expect(util.findings.filter((f) => f.severity === 'alert').map((f) => f.rule)).toEqual(['wb.weight', 'wb.cg.aft']);
  });

  it('a forward CG is caught against the sloped limit', () => {
    // Heavy front seats, nothing behind: CG forward of 35.0 at under 1950 lb is not reachable in a 172M with
    // 37 in front seats, so check the finding logic with a spec-level fact: the limit rises with weight.
    const r = computeLoading(spec, { ...sampleLoading, stations: { front: 400, rear: 0, bag1: 0, bag2: 0 }, fuelGal: { fuel: 38 } });
    expect(r.limits.forwardArmIn).toBeCloseTo(forwardLimitAt(spec.envelopes[0]!, r.totalWeightLb), 1);
    expect(r.findings.find((f) => f.rule === 'wb.cg.forward')!.values['forwardArmIn']).toBe(r.limits.forwardArmIn);
  });

  it('refuses to judge against an incomplete spec, naming what is missing', () => {
    const noEnvelope = { ...spec, envelopes: [] };
    expect(() => computeLoading(noEnvelope, sampleLoading)).toThrow(IncompleteSpecError);
    expect(() => computeLoading(noEnvelope, sampleLoading)).toThrow('no normal category envelope');
  });

  it('refuses a load at a station the data has no arm for, rather than quietly not counting it', () => {
    /*
     * The real shape of a half-extracted spec: the rear-seat arm did not
     * verify, so there is no rear station. Without this check the 340 lb of
     * rear passengers is dropped, the aeroplane comes back 340 lb lighter
     * than it is, and an over-gross loading reads as within limits.
     */
    const noRear = { ...spec, stations: spec.stations.filter((s) => s.id !== 'rear') };
    expect(() => computeLoading(noRear, sampleLoading)).toThrow(IncompleteSpecError);
    expect(() => computeLoading(noRear, sampleLoading)).toThrow('loaded at "rear"');
    // Zero at a missing station is not a load, so it is not an error.
    expect(computeLoading(noRear, { ...sampleLoading, stations: { ...sampleLoading.stations, rear: 0 } }).verdict).toBe('within-limits');
  });

  it('refuses numbers that are not numbers', () => {
    expect(() => computeLoading(spec, { ...sampleLoading, emptyWeightLb: Number.NaN })).toThrow('not a number');
    expect(() => computeLoading(spec, { ...sampleLoading, emptyMomentPer1000: Number.POSITIVE_INFINITY })).toThrow('not a number');
    expect(() => computeLoading(spec, { ...sampleLoading, stations: { ...sampleLoading.stations, front: Number.NaN } })).toThrow('not a number');
    expect(() => computeLoading(spec, { ...sampleLoading, emptyWeightLb: 0 })).toThrow('greater than zero');
  });

  it('refuses when only the light end of the sloped forward limit was extracted', () => {
    /*
     * The real failure this guards against: extraction found "35.0 inches at
     * 1950 lbs. or less" but not "38.5 inches at 2300 lbs.". Held flat, the
     * 35.0 limit would pass a 2300 lb loading whose CG is at 36 in — nose
     * heavy, outside the real envelope, reported as within limits.
     */
    const half = {
      ...spec,
      envelopes: [{ ...spec.envelopes[0]!, forward: [spec.envelopes[0]!.forward[0]!] }, spec.envelopes[1]!],
    };
    expect(() => computeLoading(half, sampleLoading)).toThrow(IncompleteSpecError);
    expect(() => computeLoading(half, sampleLoading)).toThrow('only stated up to 1950 lb');
    // Would have been judged against the wrong limit, and passed.
    expect(forwardLimitAt(half.envelopes[0]!, 2300)).toBe(35.0);
    // A loading inside the stated range is still judged normally.
    const light = computeLoading(half, { ...sampleLoading, stations: { front: 170, rear: 0, bag1: 0, bag2: 0 }, fuelGal: { fuel: 20 } });
    expect(light.totalWeightLb).toBeLessThanOrEqual(1950);
    expect(light.verdict).toBe('within-limits');
  });

  it('renders a table a pilot can read', () => {
    const text = loadingText(computeLoading(spec, sampleLoading));
    expect(text).toContain('WITHIN LIMITS');
    expect(text).toContain('TOTAL');
    expect(text).toContain('2300.0');
    expect(text).toContain('not an official');
  });
});
