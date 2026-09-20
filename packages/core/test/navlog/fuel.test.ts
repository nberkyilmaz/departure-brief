import { describe, expect, it } from 'vitest';
import type { NavLog, NavLogLeg } from '../../src/navlog/compute.js';
import { fuelPlan, RESERVE_MINUTES } from '../../src/navlog/fuel.js';

/**
 * Trip, reserve, aboard — CARs 602.88 as arithmetic.
 *
 * The nav logs here are built by hand rather than resolved from a flight,
 * because the thing under test is the sum and not the wind triangle. Every
 * number is chosen so the expected answer can be checked in the head.
 */

const leg = (from: string, to: string, minutes: number | null, fuelGal: number | null): NavLogLeg => ({
  from,
  to,
  distanceNm: 50,
  trueCourse: 270,
  magneticCourse: null,
  wind: null,
  windCorrectionAngle: null,
  trueHeading: 270,
  magneticHeading: null,
  groundspeedKt: minutes === null ? null : 100,
  minutes,
  cumulativeMinutes: minutes,
  fuelGal,
  cumulativeFuelGal: fuelGal,
  gaps: minutes === null ? ['no wind for this leg'] : [],
});

/** Sixty minutes at eight gallons an hour, with an optional alternate. */
const log = (over: Partial<NavLog> = {}): NavLog => ({
  version: 1,
  tas: 105,
  altitudeFt: 3500,
  fuelGph: 8,
  legs: [leg('CYSN', 'CYKF', 60, 8)],
  totalDistanceNm: 50,
  totalMinutes: 60,
  totalFuelGal: 8,
  alternate: null,
  ...over,
});

describe('the reserve', () => {
  it('is thirty minutes by day, under 602.88(3)', () => {
    const plan = fuelPlan(log(), 20, false);
    expect(plan.reserve).toEqual({ minutes: RESERVE_MINUTES.day, basis: 'day', rule: 'CARs 602.88(3)', gal: 4 });
  });

  it('is forty-five minutes by night, under 602.88(4)', () => {
    const plan = fuelPlan(log(), 20, true);
    expect(plan.reserve).toEqual({ minutes: RESERVE_MINUTES.night, basis: 'night', rule: 'CARs 602.88(4)', gal: 6 });
  });
});

describe('the sum', () => {
  it('adds the trip and the reserve, and takes both from what is aboard', () => {
    const plan = fuelPlan(log(), 20, false);
    expect(plan.tripGal).toBe(8);
    expect(plan.requiredGal).toBe(12);
    expect(plan.aboardGal).toBe(20);
    expect(plan.marginGal).toBe(8);
    // Eight gallons at eight an hour is an hour.
    expect(plan.marginMinutes).toBe(60);
    expect(plan.gaps).toEqual([]);
  });

  it('says short as a negative margin, not as a clamped zero', () => {
    const plan = fuelPlan(log(), 10, false);
    expect(plan.requiredGal).toBe(12);
    expect(plan.marginGal).toBe(-2);
    expect(plan.marginMinutes).toBe(-15);
  });

  it('shows the alternate beside the requirement rather than inside it', () => {
    // 602.88(3) names the destination only; a planned alternate is what a
    // diversion would take, and a pilot wants both numbers.
    const plan = fuelPlan(log({ alternate: leg('CYKF', 'CYHM', 30, 4) }), 20, false);
    expect(plan.requiredGal).toBe(12);
    expect(plan.alternateGal).toBe(4);
    expect(plan.withAlternateGal).toBe(16);
    expect(plan.marginGal).toBe(8);
  });

  it('rounds to a tenth and never prints negative zero', () => {
    const plan = fuelPlan(log({ fuelGph: 7.3, totalFuelGal: 7.3 }), 10.95, false);
    expect(plan.reserve.gal).toBe(3.7);
    expect(plan.requiredGal).toBe(11);
    expect(Object.is(plan.marginGal, -0)).toBe(false);
  });
});

describe('what is missing, said in words', () => {
  it('with no burn rate, nothing can be worked out and it says why', () => {
    const plan = fuelPlan(log({ fuelGph: null, totalFuelGal: null, legs: [leg('CYSN', 'CYKF', 60, null)] }), 20, false);
    expect(plan.tripGal).toBeNull();
    expect(plan.reserve.gal).toBeNull();
    expect(plan.requiredGal).toBeNull();
    expect(plan.marginGal).toBeNull();
    expect(plan.gaps).toEqual(['no cruise burn rate in the aircraft file, so neither the trip fuel nor the reserve can be worked out']);
  });

  it('with no fuel aboard, the requirement is known and the margin is not', () => {
    const plan = fuelPlan(log(), null, false);
    expect(plan.requiredGal).toBe(12);
    expect(plan.aboardGal).toBeNull();
    expect(plan.marginGal).toBeNull();
    expect(plan.gaps).toEqual(['no fuel aboard given in the flight plan']);
  });

  it('with a leg that has no time, the trip cannot be totalled and it says which', () => {
    const plan = fuelPlan(log({ legs: [leg('CYSN', 'CYKF', null, null)], totalMinutes: null, totalFuelGal: null }), 20, false);
    expect(plan.tripGal).toBeNull();
    // The reserve is still computable: it depends on the burn rate alone.
    expect(plan.reserve.gal).toBe(4);
    expect(plan.requiredGal).toBeNull();
    expect(plan.gaps).toEqual(['a leg has no time, so the trip fuel cannot be totalled']);
  });

  it('an alternate leg with no time leaves the alternate figure blank, with the reason', () => {
    const plan = fuelPlan(log({ alternate: leg('CYKF', 'CYHM', null, null) }), 20, false);
    expect(plan.requiredGal).toBe(12);
    expect(plan.alternateGal).toBeNull();
    expect(plan.withAlternateGal).toBeNull();
    expect(plan.gaps).toEqual(['the alternate leg has no time, so the fuel to reach it is unknown']);
  });

  it('lists every gap, not just the first', () => {
    const plan = fuelPlan(log({ fuelGph: null, totalFuelGal: null }), null, false);
    expect(plan.gaps).toHaveLength(2);
  });
});
