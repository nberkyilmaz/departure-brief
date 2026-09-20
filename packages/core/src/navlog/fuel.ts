/**
 * Fuel: what the trip takes, what the regulation adds, what is aboard.
 *
 * CARs 602.88 is short. A VFR flight by day carries enough to reach the
 * destination and then fly for thirty minutes at normal cruising speed;
 * by night, forty-five. That is the whole rule, and this is the whole
 * arithmetic: trip fuel out of the nav log, the reserve out of the burn
 * rate, the sum against what the pilot says is in the tanks.
 *
 * Three numbers come from the pilot and none are invented here. The burn
 * rate is in the aircraft file because the handbook prints it against
 * power setting and altitude and only the pilot knows which row they fly.
 * The fuel aboard is in the flight plan because only the person who
 * dipped the tanks knows it. When either is missing the plan says so, in
 * words, in the place the number would have gone.
 *
 * An alternate is not part of the regulation for VFR — 602.88(3) and (4)
 * name the destination only — but a pilot who planned one wants to know
 * what reaching it would take, so that figure is shown beside the required
 * one rather than folded into it.
 */
import type { NavLog } from './compute.js';

/** CARs 602.88(3) and (4): minutes at normal cruising speed, after the destination. */
export const RESERVE_MINUTES = { day: 30, night: 45 } as const;

export interface FuelPlan {
  /** From the nav log's legs, departure to destination. */
  readonly tripGal: number | null;
  /** The alternate leg on its own, when one is planned. Not part of `requiredGal`. */
  readonly alternateGal: number | null;
  readonly reserve: {
    readonly minutes: 30 | 45;
    /** Which subsection applies and why. */
    readonly basis: 'day' | 'night';
    readonly rule: 'CARs 602.88(3)' | 'CARs 602.88(4)';
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
export function fuelPlan(log: NavLog, aboardGal: number | null, night: boolean): FuelPlan {
  const gaps: string[] = [];
  const gph = log.fuelGph;
  const reserveMinutes = night ? RESERVE_MINUTES.night : RESERVE_MINUTES.day;
  const rule = night ? 'CARs 602.88(4)' : 'CARs 602.88(3)';

  if (gph === null) gaps.push('no cruise burn rate in the aircraft file, so neither the trip fuel nor the reserve can be worked out');
  if (log.totalFuelGal === null && gph !== null) gaps.push('a leg has no time, so the trip fuel cannot be totalled');
  if (aboardGal === null) gaps.push('no fuel aboard given in the flight plan');

  const reserveGal = gph === null ? null : round1((reserveMinutes / 60) * gph);
  const tripGal = log.totalFuelGal;
  const alternateGal = log.alternate?.fuelGal ?? null;
  const requiredGal = tripGal !== null && reserveGal !== null ? round1(tripGal + reserveGal) : null;
  const withAlternateGal = requiredGal !== null && log.alternate ? (alternateGal !== null ? round1(requiredGal + alternateGal) : null) : null;
  if (log.alternate && alternateGal === null && gph !== null) gaps.push('the alternate leg has no time, so the fuel to reach it is unknown');

  const marginGal = aboardGal !== null && requiredGal !== null ? round1(aboardGal - requiredGal) : null;
  const marginMinutes = marginGal !== null && gph !== null && gph > 0 ? Math.round((marginGal / gph) * 60) : null;

  return {
    tripGal,
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
