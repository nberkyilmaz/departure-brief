/**
 * Fuel: what the trip takes, what the regulation adds, what is aboard.
 *
 * CARs 602.88 is short. A VFR flight by day carries enough to reach the
 * destination and then fly for thirty minutes at normal cruising speed;
 * by night, forty-five. That is the whole rule, and this is the whole
 * arithmetic: trip fuel out of the nav log, the reserve out of the burn
 * rate, the sum against what the pilot says is in the tanks.
 *
 * The burn is the handbook's, read from its cruise table for the power
 * setting the pilot chose, or a figure the pilot typed in, which wins. The
 * trip is what the nav log adds up: the handbook's start, taxi and takeoff
 * allowance, its climb, and each leg's cruise. The fuel aboard is in the
 * flight plan because only the person who dipped the tanks knows it. When
 * any of it is missing the plan says so, in words, in the place the number
 * would have gone.
 *
 * The reserve is flown at the highest burn of any leg: thirty minutes "at
 * normal cruising speed" after the destination, and the burn there is the
 * last leg's or near it, so the highest is the figure that is never short.
 *
 * An alternate is not part of the regulation for VFR — 602.88(3) and (4)
 * name the destination only — but a pilot who planned one wants to know
 * what reaching it would take, so that figure is shown beside the required
 * one rather than folded into it.
 *
 * FAR 91.151(a) says the same thing in the same numbers for a flight in the
 * United States, night by the same civil twilight, so the arithmetic is
 * shared and only the regulation cited changes. Which one is decided by
 * where the flight starts.
 */
import type { Jurisdiction } from '../rules/vfrMinima.js';
import type { NavLog } from './compute.js';

/** CARs 602.88(3) and (4), and FAR 91.151(a)(1) and (2): minutes at normal cruising speed, after the destination. */
export const RESERVE_MINUTES = { day: 30, night: 45 } as const;

const RESERVE_RULE = {
  CA: { day: 'CARs 602.88(3)', night: 'CARs 602.88(4)' },
  US: { day: 'FAR 91.151(a)(1)', night: 'FAR 91.151(a)(2)' },
} as const;

export interface FuelPlan {
  /** From the nav log, departure to destination: the allowance, the climb and the legs. */
  readonly tripGal: number | null;
  /** What the trip is made of, when the handbook supplied the first two. */
  readonly allowanceGal: number | null;
  readonly climbGal: number | null;
  readonly cruiseGal: number | null;
  /** The alternate leg on its own, when one is planned. Not part of `requiredGal`. */
  readonly alternateGal: number | null;
  readonly reserve: {
    readonly minutes: 30 | 45;
    /** Which subsection applies and why. */
    readonly basis: 'day' | 'night';
    readonly rule: (typeof RESERVE_RULE)[Jurisdiction]['day' | 'night'];
    readonly gal: number | null;
  };
  /** Trip plus reserve: what the regulation requires at the moment of departure. */
  readonly requiredGal: number | null;
  /** Trip, alternate and reserve: what reaching the planned alternate would take. */
  readonly withAlternateGal: number | null;
  readonly aboardGal: number | null;
  /** Aboard minus required. Negative is short. */
  readonly marginGal: number | null;
  /** The same margin as minutes of flying at cruise burn. */
  readonly marginMinutes: number | null;
  /** Why any figure above is missing, in words. Empty when every figure is present. */
  readonly gaps: readonly string[];
}

const round1 = (n: number): number => {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * The fuel plan for a flight.
 *
 * `night` is whether any point of the flight — departure to destination —
 * is at night, which is what makes it a night VFR flight for 602.88(4).
 * The alternate leg does not count: a diversion is a different flight.
 */
export function fuelPlan(log: NavLog, aboardGal: number | null, night: boolean, jurisdiction: Jurisdiction = 'CA'): FuelPlan {
  const gaps: string[] = [];
  const gph = log.fuelGph;
  const reserveMinutes = night ? RESERVE_MINUTES.night : RESERVE_MINUTES.day;
  const rule = RESERVE_RULE[jurisdiction][night ? 'night' : 'day'];

  if (gph === null) gaps.push(`${log.fuelProblem ?? 'no cruise burn rate in the aircraft file'}, so neither the trip fuel nor the reserve can be worked out`);
  if (log.totalFuelGal === null && gph !== null) {
    gaps.push(log.legs.some((l) => l.minutes === null) ? 'a leg has no time, so the trip fuel cannot be totalled' : `${log.fuelProblem ?? 'a leg has no fuel figure'}, so the trip fuel cannot be totalled`);
  }
  if (aboardGal === null) gaps.push('no fuel aboard given in the flight plan');

  const reserveGal = gph === null ? null : round1((reserveMinutes / 60) * gph);
  const tripGal = log.totalFuelGal;
  const allowanceGal = log.handbook && tripGal !== null ? log.handbook.allowance.gal : null;
  const climbGal = log.handbook?.climb && tripGal !== null ? log.handbook.climb.gal : null;
  const cruiseGal = tripGal === null ? null : round1(tripGal - (allowanceGal ?? 0) - (climbGal ?? 0));
  const alternateGal = log.alternate?.fuelGal ?? null;
  const requiredGal = tripGal !== null && reserveGal !== null ? round1(tripGal + reserveGal) : null;
  const withAlternateGal = requiredGal !== null && log.alternate ? (alternateGal !== null ? round1(requiredGal + alternateGal) : null) : null;
  if (log.alternate && alternateGal === null && gph !== null) {
    gaps.push(log.alternate.minutes === null ? 'the alternate leg has no time, so the fuel to reach it is unknown' : 'the alternate leg has no burn, so the fuel to reach it is unknown');
  }

  const marginGal = aboardGal !== null && requiredGal !== null ? round1(aboardGal - requiredGal) : null;
  const marginMinutes = marginGal !== null && gph !== null && gph > 0 ? Math.round((marginGal / gph) * 60) : null;

  return {
    tripGal,
    allowanceGal,
    climbGal,
    cruiseGal,
    alternateGal,
    reserve: { minutes: reserveMinutes, basis: night ? 'night' : 'day', rule, gal: reserveGal },
    requiredGal,
    withAlternateGal,
    aboardGal,
    marginGal,
    marginMinutes,
    gaps,
  };
}
