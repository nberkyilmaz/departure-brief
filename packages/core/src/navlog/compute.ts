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
 *
 * Fuel follows the handbook's own sample problem when there is a handbook
 * for the aircraft: the start, taxi and takeoff allowance, the climb from
 * its time-fuel-and-distance table, and the rest of the way at the cruise
 * table's burn for the power setting chosen. The climb's distance comes
 * off the first leg's cruise, as the handbook takes it off the trip; the
 * leg times are left as they were, so the time at each waypoint, which the
 * weather is read for, does not move.
 */
import { toMagnetic } from '../domain/airport.js';
import { MAGNETIC_MODEL, magneticVariation } from '../domain/magnetic.js';
import { deviationC, pressureAltitudeFt, readClimb, readCruise, type CruiseCellRef } from '../perf/read.js';
import type { PerformanceSpec } from '../perf/types.js';
import type { ResolvedFlight } from '../resolve/flight.js';
import type { WaypointWind } from '../resolve/wind.js';

export const NAVLOG_VERSION = 3;

export interface NavLogWind {
  readonly directionTrue: number;
  readonly speedKt: number;
  /** Which upper wind site it came from, and how far away that is. */
  readonly station: string;
  readonly distanceNm: number;
  readonly altitudeFt: number;
  readonly sha256: string;
  /** Present when a balloon measured it: where it went up, and when. */
  readonly measured?: { readonly by: string; readonly at: string };
}

/** The burn a leg is flown at, and where it came from. */
export interface LegBurn {
  readonly gph: number;
  /** `aircraft`: typed into the aircraft settings, which wins; `handbook`: read from its cruise table. */
  readonly source: 'aircraft' | 'handbook';
  readonly handbook: {
    readonly rpm: number;
    /** The temperature at cruise in degrees from standard; null when there was none and every column was read. */
    readonly deviationC: number | null;
    /** The printed cell the burn is, and the one the table's lowest speed here is. */
    readonly burnCell: CruiseCellRef;
    readonly speedCell: CruiseCellRef;
    /** Every printed cell either side of the flight. */
    readonly around: readonly CruiseCellRef[];
  } | null;
}

export interface NavLogLeg {
  readonly from: string;
  readonly to: string;
  readonly distanceNm: number;
  /** How much of the leg is spent climbing, whose fuel is the climb's rather than the leg's. */
  readonly climbNm: number;
  readonly trueCourse: number;
  /**
   * Degrees, east positive, where the leg begins, from the World Magnetic
   * Model for the date flown. `null` only outside the years the model covers.
   */
  readonly variation: number | null;
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
  readonly burn: LegBurn | null;
  /** The leg's cruise fuel: its distance after the climb, at its burn. */
  readonly fuelGal: number | null;
  /** Everything used by the end of the leg, the allowance and the climb included. */
  readonly cumulativeFuelGal: number | null;
  /** Why a number is missing, in words, rather than a silent blank. */
  readonly gaps: readonly string[];
}

/** The climb, read from the handbook's time, fuel and distance table. */
export interface NavLogClimb {
  /** Pressure altitudes, the field's and the cruise's. */
  readonly fromFt: number;
  readonly toFt: number;
  /** The printed rows read: the field's at or below it, the cruise's at or above. */
  readonly fromRowFt: number;
  readonly toRowFt: number;
  /** The warmer of the departure's and the first leg's, in degrees from standard; null when neither had a temperature. */
  readonly deviationC: number | null;
  /** The handbook's increase for a warm day, in percent. */
  readonly percent: number;
  readonly gal: number;
  readonly nm: number;
  readonly minutes: number;
}

/** What the handbook added before the first leg, and where it says so. */
export interface NavLogHandbook {
  readonly model: string;
  readonly filename: string;
  readonly sha256: string;
  readonly cruiseTable: { readonly figure: string; readonly page: number; readonly printedPage: string };
  readonly climbTable: { readonly figure: string; readonly page: number; readonly printedPage: string };
  /** The cruise altitude as the tables are read: a pressure altitude. */
  readonly pressureAltitudeFt: number;
  /** Whose altimeter setting made it one; null when there was none and the altitude was used as it is. */
  readonly altimeterFrom: string | null;
  /** Note 1 of the climb table. */
  readonly allowance: { readonly gal: number; readonly printed: string; readonly scanned: boolean };
  readonly climb: NavLogClimb | null;
  /** What was assumed about the climb, in words. */
  readonly notes: readonly string[];
}

export interface NavLog {
  readonly version: number;
  readonly tas: number;
  readonly altitudeFt: number;
  /** The power setting chosen, which the handbook's cruise table is read by. */
  readonly rpm: number | null;
  /** The highest burn of any leg: what the reserve is flown at. */
  readonly fuelGph: number | null;
  /**
   * Null when there are no handbook tables for this aircraft. A typed burn
   * replaces the cruise table only: the allowance and the climb still come
   * from the handbook, since typing a cruise figure says nothing about them.
   */
  readonly handbook: NavLogHandbook | null;
  readonly legs: readonly NavLogLeg[];
  readonly totalDistanceNm: number;
  /** `null` when any leg is missing its time, because a partial total is a lie. */
  readonly totalMinutes: number | null;
  /** The allowance, the climb and every leg's cruise; `null` when any of them is missing. */
  readonly totalFuelGal: number | null;
  /** Why there is no fuel figure, when the reason is not a missing time. */
  readonly fuelProblem: string | null;
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
    ...(w.measured ? { measured: { by: w.measured.by, at: w.measured.at.toISOString() } } : {}),
  };
}

interface LegInput {
  readonly from: string;
  readonly to: string;
  readonly distanceNm: number;
  readonly climbNm: number;
  readonly trueCourse: number;
  readonly wind: WaypointWind | null;
  readonly variation: number | null;
}

/** A leg's burn: typed in, read from the handbook, or none and why. */
interface Burned {
  readonly burn: LegBurn | null;
  readonly problem: string | null;
}

function computeLeg(leg: LegInput, tas: number, { burn, problem }: Burned): Omit<NavLogLeg, 'cumulativeMinutes' | 'cumulativeFuelGal'> {
  const gaps: string[] = [];
  const wind = windOf(leg.wind);
  if (!wind) {
    gaps.push(
      leg.wind
        ? `the wind at ${leg.to} is light and variable, so there is no correction to apply`
        : `no upper wind forecast or balloon sounding covers ${leg.to} at this altitude and time, so there is no groundspeed`,
    );
  }
  const magneticCourse = leg.variation === null ? null : toMagnetic(leg.trueCourse as never, leg.variation);
  if (leg.variation === null) gaps.push(`the ${MAGNETIC_MODEL.name} magnetic model does not cover this date, so courses are true`);

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

  if (problem) gaps.push(problem);
  const cruiseNm = Math.max(0, leg.distanceNm - leg.climbNm);
  const fuelGal = groundspeed !== null && groundspeed > 0 && minutes !== null && burn ? round1((cruiseNm / groundspeed) * burn.gph) : null;

  return {
    from: leg.from,
    to: leg.to,
    distanceNm: Math.round(leg.distanceNm * 10) / 10,
    climbNm: Math.round(leg.climbNm * 10) / 10,
    trueCourse: compass(Math.round(leg.trueCourse)),
    variation: leg.variation === null ? null : round1(leg.variation),
    magneticCourse: magneticCourse === null ? null : compass(Math.round(magneticCourse)),
    wind,
    windCorrectionAngle: solved?.windCorrectionAngle ?? (trueHeading !== null ? 0 : null),
    trueHeading: trueHeading === null ? null : compass(Math.round(trueHeading)),
    magneticHeading: trueHeading === null || leg.variation === null ? null : compass(Math.round(toMagnetic(trueHeading as never, leg.variation))),
    groundspeedKt: groundspeed,
    minutes,
    burn,
    fuelGal,
    gaps,
  };
}

/**
 * Build the nav log for a resolved flight. The wind for a leg is the one
 * forecast at the point it ends at — the usual simplification, and the
 * finer alternative would need a forecast at the midpoint, which nobody
 * publishes. The variation is taken where the leg begins, which is where
 * its great-circle course is measured, so the two belong to the same place.
 *
 * `typedGph` is a burn typed into the aircraft settings, which is used on
 * every leg ahead of the handbook. `performance` is the handbook's tables,
 * passed only when they are for this aircraft.
 */
export function navLog(flight: ResolvedFlight, typedGph: number | null = null, performance: PerformanceSpec | null = null): NavLog {
  const tas = flight.plan.cruise.tas;
  const rpm = flight.plan.cruise.rpm ?? null;
  const points = flight.points;
  const departure = points[0];
  const departureId = departure?.point.waypoint.id ?? flight.plan.departure;

  /*
   * The tables are read by pressure altitude. The departure's altimeter
   * setting makes one of the cruise altitude, as a pilot would on the
   * ground before leaving; without one, the altitude is used as it is and
   * the log says so.
   */
  const setting = departure?.metar?.decoded.altimeter?.value ?? null;
  const cruisePa = pressureAltitudeFt(flight.plan.cruise.altitude, setting) ?? flight.plan.cruise.altitude;

  const burnOf = (wind: WaypointWind | null): Burned => {
    if (typedGph !== null) return { burn: { gph: typedGph, source: 'aircraft', handbook: null }, problem: null };
    if (!performance || rpm === null) return { burn: null, problem: null };
    const tempC = wind?.wind.tempC ?? null;
    const deviation = tempC === null ? null : deviationC(tempC, cruisePa);
    const read = readCruise(performance.cruise, cruisePa, deviation, rpm);
    if ('problem' in read) return { burn: null, problem: read.problem };
    return {
      burn: { gph: read.gph, source: 'handbook', handbook: { rpm, deviationC: deviation, burnCell: read.burnCell, speedCell: read.speedCell, around: read.around } },
      problem: null,
    };
  };

  let handbook: NavLogHandbook | null = null;
  let climbProblem: string | null = null;
  if (performance) {
    const notes: string[] = [];
    const elevation = departure?.point.waypoint.airport?.elevation ?? null;
    if (setting === null) notes.push(`no altimeter setting at ${departureId}, so altitudes are read as pressure altitudes`);
    if (elevation === null) notes.push(`no field elevation for ${departureId}, so the climb is taken from sea level`);
    const fieldPa = elevation === null ? 0 : (pressureAltitudeFt(elevation, setting) ?? elevation);

    // A warm day slows the climb; the warmer of the two ends of it is the one used.
    const fieldTemp = departure?.metar?.decoded.temperature?.value.temperature ?? null;
    const cruiseTemp = points[1]?.wind?.wind.tempC ?? null;
    const warm = [
      fieldTemp !== null && elevation !== null ? deviationC(fieldTemp, fieldPa) : null,
      cruiseTemp !== null ? deviationC(cruiseTemp, cruisePa) : null,
    ].filter((d): d is number => d !== null);
    const deviation = warm.length > 0 ? Math.max(...warm) : null;
    if (deviation === null) notes.push(`no temperature at ${departureId} or at cruise, so the climb is the table's, for a standard day`);

    const read = readClimb(performance.climb, fieldPa, cruisePa, deviation);
    if ('problem' in read) climbProblem = read.problem;
    handbook = {
      model: performance.model,
      filename: performance.source.filename,
      sha256: performance.source.documentSha256,
      cruiseTable: { figure: performance.cruise.figure, page: performance.cruise.page, printedPage: performance.cruise.printedPage },
      climbTable: { figure: performance.climb.figure, page: performance.climb.page, printedPage: performance.climb.printedPage },
      pressureAltitudeFt: cruisePa,
      altimeterFrom: setting === null ? null : (departure?.metar?.station ?? null),
      allowance: {
        gal: performance.climb.allowanceGal.value,
        printed: performance.climb.allowanceGal.printed,
        scanned: performance.climb.allowanceGal.scan !== null && performance.climb.allowanceGal.scan.unconfirmed.length === 0,
      },
      climb: 'problem' in read ? null : { fromFt: fieldPa, toFt: cruisePa, deviationC: deviation, ...read },
      notes,
    };
  }

  // The climb's distance comes off the legs in order: usually all from the first.
  let climbLeft = handbook?.climb?.nm ?? 0;
  const inputs: LegInput[] = [];
  for (let i = 1; i < points.length; i++) {
    const to = points[i]!;
    const leg = flight.route.legs[i - 1]!;
    const climbNm = Math.min(climbLeft, leg.distance);
    climbLeft -= climbNm;
    inputs.push({
      from: points[i - 1]!.point.waypoint.id,
      to: to.point.waypoint.id,
      distanceNm: leg.distance,
      climbNm,
      trueCourse: leg.trueCourse,
      wind: to.wind,
      variation: magneticVariation(points[i - 1]!.point.waypoint.position, points[i - 1]!.point.eta),
    });
  }

  const before = handbook ? handbook.allowance.gal + (handbook.climb?.gal ?? 0) : 0;
  const legs: NavLogLeg[] = [];
  let minutes = 0;
  let fuel = before;
  let broken = false;
  let unfuelled = climbProblem !== null;
  let legProblem: string | null = null;
  for (const input of inputs) {
    const burned = burnOf(input.wind);
    legProblem ??= burned.problem;
    const leg = computeLeg(input, tas, burned);
    if (leg.minutes === null) broken = true;
    else minutes += leg.minutes;
    if (leg.fuelGal === null) unfuelled = true;
    else fuel += leg.fuelGal;
    legs.push({
      ...leg,
      // A running total stops as soon as one leg has no time: a cumulative
      // figure that quietly skips a leg would read as if it included it.
      cumulativeMinutes: broken ? null : minutes,
      cumulativeFuelGal: broken || unfuelled ? null : round1(fuel),
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
        climbNm: 0,
        trueCourse: flight.route.alternate.leg.trueCourse,
        wind: flight.alternate.wind,
        variation: magneticVariation(last.point.waypoint.position, last.point.eta),
      },
      tas,
      burnOf(flight.alternate.wind),
    );
    alternate = { ...computed, cumulativeMinutes: null, cumulativeFuelGal: null };
  }

  const burns = legs.flatMap((l) => (l.burn ? [l.burn.gph] : []));
  const fuelProblem =
    climbProblem ??
    legProblem ??
    (typedGph === null && performance && rpm === null ? `no power setting chosen for the ${performance.model} cruise table and no cruise burn typed in` : null);

  const totalDistanceNm = round1(legs.reduce((sum, l) => sum + l.distanceNm, 0));
  return {
    version: NAVLOG_VERSION,
    tas,
    altitudeFt: flight.plan.cruise.altitude,
    rpm,
    fuelGph: burns.length > 0 ? Math.max(...burns) : null,
    handbook,
    legs,
    totalDistanceNm,
    totalMinutes: broken ? null : minutes,
    totalFuelGal: broken || unfuelled ? null : round1(fuel),
    fuelProblem,
    alternate,
  };
}
