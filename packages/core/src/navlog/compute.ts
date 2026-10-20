/**
 * The nav log: the arithmetic a pilot does on the kitchen table, done once
 * and shown working.
 *
 * Nothing here is clever. It is the wind triangle, leg by leg, and the
 * point of doing it here is not that it is hard — it is that doing it by
 * hand at eleven at night, for six legs, is where the arithmetic mistakes
 * live, and that every number can be traced back to the forecast it came
 * from.
 *
 * What it will not do is fill a gap. No wind forecast for a leg means no
 * groundspeed for that leg, and therefore no time and no fuel: a nav log
 * with a plausible number where the forecast was missing is worse than one
 * with a blank, because the blank is the only honest way to say "you will
 * have to work this one out yourself".
 */
import type { Airport } from '../domain/airport.js';
import { toMagnetic } from '../domain/airport.js';
import type { ResolvedFlight } from '../resolve/flight.js';
import type { WaypointWind } from '../resolve/wind.js';

export const NAVLOG_VERSION = 1;

export interface NavLogWind {
  readonly directionTrue: number;
  readonly speedKt: number;
  /** Which upper wind site it came from, and how far away that is. */
  readonly station: string;
  readonly distanceNm: number;
  readonly altitudeFt: number;
  readonly sha256: string;
}

export interface NavLogLeg {
  readonly from: string;
  readonly to: string;
  readonly distanceNm: number;
  readonly trueCourse: number;
  /** `null` where the airport data carries no magnetic variation, which OurAirports never does. */
  readonly magneticCourse: number | null;
  readonly wind: NavLogWind | null;
  /** Degrees to turn into wind; positive is right. `null` without a wind. */
  readonly windCorrectionAngle: number | null;
  readonly trueHeading: number | null;
  readonly magneticHeading: number | null;
  readonly groundspeedKt: number | null;
  readonly minutes: number | null;
  /** Minutes from departure to the end of this leg, when every leg before it has a time. */
  readonly cumulativeMinutes: number | null;
  readonly fuelGal: number | null;
  readonly cumulativeFuelGal: number | null;
  /** Why a number is missing, in words, rather than a silent blank. */
  readonly gaps: readonly string[];
}

export interface NavLog {
  readonly version: number;
  readonly tas: number;
  readonly altitudeFt: number;
  readonly fuelGph: number | null;
  readonly legs: readonly NavLogLeg[];
  readonly totalDistanceNm: number;
  /** `null` when any leg is missing its time, because a partial total is a lie. */
  readonly totalMinutes: number | null;
  readonly totalFuelGal: number | null;
  /** The alternate leg, which is not part of the totals. */
  readonly alternate: NavLogLeg | null;
}

/** Degrees to radians, and back. */
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * A direction as a pilot writes it: 1 to 360, because north on a heading
 * bug is 360 and nobody says "fly zero degrees".
 */
const compass = (d: number): number => {
  const wrapped = ((d % 360) + 360) % 360;
  return wrapped === 0 ? 360 : wrapped;
};

/** Rounded to a tenth, and never negative zero, which reads as a mistake. */
const round1 = (n: number): number => {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? 0 : r;
};

export interface WindSolution {
  readonly windCorrectionAngle: number;
  readonly trueHeading: number;
  readonly groundspeedKt: number;
}

/**
 * The wind triangle for one leg.
 *
 * `null` when the crosswind component is greater than the aircraft's true
 * airspeed — the course cannot be held at all, which is a real answer and
 * not an error to swallow.
 */
export function solveWind(trueCourse: number, tas: number, wind: { directionTrue: number; speedKt: number }): WindSolution | null {
  if (!(tas > 0)) return null;
  const off = rad(wind.directionTrue - trueCourse);
  const across = wind.speedKt * Math.sin(off);
  const along = wind.speedKt * Math.cos(off);
  if (Math.abs(across) > tas) return null;
  const wca = deg(Math.asin(across / tas));
  const groundspeed = tas * Math.cos(rad(wca)) - along;
  if (!(groundspeed > 0)) return null;
  return { windCorrectionAngle: round1(wca), trueHeading: compass(trueCourse + wca), groundspeedKt: round1(groundspeed) };
}

function windOf(w: WaypointWind | null): NavLogWind | null {
  if (!w || w.wind.directionTrue === null) return null;
  return {
    directionTrue: w.wind.directionTrue,
    speedKt: w.wind.speedKt,
    station: w.station,
    distanceNm: w.distance,
    altitudeFt: w.wind.altitudeFt,
    sha256: w.report.sha256,
  };
}

/** Variation is east-positive; `null` from any source that does not publish it. */
function variationOf(airport: Airport | null): number | null {
  return airport?.magneticVariation ?? null;
}

interface LegInput {
  readonly from: string;
  readonly to: string;
  readonly distanceNm: number;
  readonly trueCourse: number;
  readonly wind: WaypointWind | null;
  readonly variation: number | null;
}

function computeLeg(leg: LegInput, tas: number, fuelGph: number | null): Omit<NavLogLeg, 'cumulativeMinutes' | 'cumulativeFuelGal'> {
  const gaps: string[] = [];
  const wind = windOf(leg.wind);
  if (!wind) {
    gaps.push(
      leg.wind
        ? `the wind at ${leg.to} is light and variable, so there is no correction to apply`
        : `no upper wind forecast covers ${leg.to} at this altitude and time, so there is no groundspeed`,
    );
  }
  const magneticCourse = leg.variation === null ? null : toMagnetic(leg.trueCourse as never, leg.variation);
  if (leg.variation === null) gaps.push(`no magnetic variation published for ${leg.to}; courses are true`);

  const solved = wind ? solveWind(leg.trueCourse, tas, wind) : null;
  if (wind && !solved) gaps.push(`the wind at ${leg.to} is stronger across the course than the aircraft is fast; this course cannot be held`);

  /*
   * With no wind to correct for, the heading is the course and the
   * groundspeed is the airspeed. That is the right answer for a light and
   * variable forecast, and it is stated as one rather than left blank.
   */
  const groundspeed = solved ? solved.groundspeedKt : leg.wind && !wind ? tas : null;
  const trueHeading = solved ? solved.trueHeading : leg.wind && !wind ? leg.trueCourse : null;
  const minutes = groundspeed !== null && groundspeed > 0 ? Math.round((leg.distanceNm / groundspeed) * 60) : null;

  return {
    from: leg.from,
    to: leg.to,
    distanceNm: Math.round(leg.distanceNm * 10) / 10,
    trueCourse: compass(Math.round(leg.trueCourse)),
    magneticCourse: magneticCourse === null ? null : compass(Math.round(magneticCourse)),
    wind,
    windCorrectionAngle: solved?.windCorrectionAngle ?? (trueHeading !== null ? 0 : null),
    trueHeading: trueHeading === null ? null : compass(Math.round(trueHeading)),
    magneticHeading: trueHeading === null || leg.variation === null ? null : compass(Math.round(toMagnetic(trueHeading as never, leg.variation))),
    groundspeedKt: groundspeed,
    minutes,
    fuelGal: minutes !== null && fuelGph !== null ? round1((minutes / 60) * fuelGph) : null,
    gaps,
  };
}

/**
 * Build the nav log for a resolved flight. The wind for a leg is the one
 * forecast at the point it ends at — the usual simplification, and the
 * finer alternative would need a forecast at the midpoint, which nobody
 * publishes.
 */
export function navLog(flight: ResolvedFlight, fuelGph: number | null = null): NavLog {
  const tas = flight.plan.cruise.tas;
  const points = flight.points;
  const inputs: LegInput[] = [];
  for (let i = 1; i < points.length; i++) {
    const to = points[i]!;
    const leg = flight.route.legs[i - 1]!;
    inputs.push({
      from: points[i - 1]!.point.waypoint.id,
      to: to.point.waypoint.id,
      distanceNm: leg.distance,
      trueCourse: leg.trueCourse,
      wind: to.wind,
      variation: variationOf(to.point.waypoint.airport),
    });
  }

  const legs: NavLogLeg[] = [];
  let minutes = 0;
  let fuel = 0;
  let broken = false;
  for (const input of inputs) {
    const leg = computeLeg(input, tas, fuelGph);
    if (leg.minutes === null) broken = true;
    else minutes += leg.minutes;
    if (leg.fuelGal !== null) fuel += leg.fuelGal;
    legs.push({
      ...leg,
      // A running total stops as soon as one leg has no time: a cumulative
      // figure that quietly skips a leg would read as if it included it.
      cumulativeMinutes: broken ? null : minutes,
      cumulativeFuelGal: broken || fuelGph === null ? null : round1(fuel),
    });
  }

  let alternate: NavLogLeg | null = null;
  if (flight.alternate && flight.route.alternate) {
    const last = points[points.length - 1]!;
    const computed = computeLeg(
      {
        from: last.point.waypoint.id,
        to: flight.alternate.point.waypoint.id,
        distanceNm: flight.route.alternate.leg.distance,
        trueCourse: flight.route.alternate.leg.trueCourse,
        wind: flight.alternate.wind,
        variation: variationOf(flight.alternate.point.waypoint.airport),
      },
      tas,
      fuelGph,
    );
    alternate = { ...computed, cumulativeMinutes: null, cumulativeFuelGal: null };
  }

  const totalDistanceNm = round1(legs.reduce((sum, l) => sum + l.distanceNm, 0));
  return {
    version: NAVLOG_VERSION,
    tas,
    altitudeFt: flight.plan.cruise.altitude,
    fuelGph,
    legs,
    totalDistanceNm,
    totalMinutes: broken ? null : minutes,
    totalFuelGal: broken || fuelGph === null ? null : round1(fuel),
    alternate,
  };
}
