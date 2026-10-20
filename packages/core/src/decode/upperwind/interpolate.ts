/**
 * The wind at the altitude actually being flown.
 *
 * A forecast gives 3,000 and 6,000; a Cessna cruises at 3,500. Pilots
 * interpolate between the two, and so does this — linearly in altitude for
 * speed and temperature, and around the shorter way for direction, which is
 * the only part with a trap in it: halfway between 350° and 010° is 000°,
 * not 180°.
 *
 * What it will not do is extrapolate. Below the lowest forecast level the
 * wind is heading for the surface, where friction and terrain take over and
 * the forecast says nothing; above the highest it is simply unforecast.
 * Both are reported as what they are.
 */
import type { UpperWindLevel } from './types.js';

export type WindBasis =
  /** The altitude is a forecast level, used as it stands. */
  | 'level'
  /** Between two forecast levels. */
  | 'interpolated'
  /** Below the lowest level; that level is reported, and this says so. */
  | 'below-lowest'
  /** Above the highest level. */
  | 'above-highest';

export interface WindAloft {
  readonly altitudeFt: number;
  /** Degrees true, or `null` for light and variable. */
  readonly directionTrue: number | null;
  readonly speedKt: number;
  readonly tempC: number | null;
  readonly basis: WindBasis;
  /** The forecast level or levels this came from — the citation. */
  readonly from: readonly UpperWindLevel[];
}

/**
 * Interpolate an angle the short way round, in degrees. Two directions
 * exactly opposite have no short way, so the turn is taken clockwise —
 * arbitrary, but fixed, because a value that depended on rounding would be
 * worse than one that is simply stated.
 */
export function interpolateDegrees(a: number, b: number, fraction: number): number {
  const forward = (((b - a) % 360) + 360) % 360;
  const delta = forward > 180 ? forward - 360 : forward;
  return (((a + delta * fraction) % 360) + 360) % 360;
}

const between = (a: number, b: number, f: number) => a + (b - a) * f;

/**
 * The forecast wind at `altitudeFt`, or `null` when there are no levels at
 * all. Levels must be sorted lowest first, which the decoder guarantees.
 */
export function windAtAltitude(levels: readonly UpperWindLevel[], altitudeFt: number): WindAloft | null {
  if (levels.length === 0) return null;
  const lowest = levels[0]!;
  const highest = levels[levels.length - 1]!;

  const exact = levels.find((l) => l.altitudeFt === altitudeFt);
  if (exact) {
    return { altitudeFt, directionTrue: exact.directionTrue, speedKt: exact.speedKt, tempC: exact.tempC, basis: 'level', from: [exact] };
  }
  if (altitudeFt < lowest.altitudeFt) {
    return { altitudeFt, directionTrue: lowest.directionTrue, speedKt: lowest.speedKt, tempC: lowest.tempC, basis: 'below-lowest', from: [lowest] };
  }
  if (altitudeFt > highest.altitudeFt) {
    return { altitudeFt, directionTrue: highest.directionTrue, speedKt: highest.speedKt, tempC: highest.tempC, basis: 'above-highest', from: [highest] };
  }

  let below = lowest;
  let above = highest;
  for (const level of levels) {
    if (level.altitudeFt <= altitudeFt) below = level;
    if (level.altitudeFt >= altitudeFt) {
      above = level;
      break;
    }
  }
  const fraction = (altitudeFt - below.altitudeFt) / (above.altitudeFt - below.altitudeFt);
  const speedKt = Math.round(between(below.speedKt, above.speedKt, fraction));

  /*
   * A level with no direction is light and variable. There is nothing to
   * interpolate towards, so the direction that does exist is carried — and
   * if neither has one, the result has none either.
   */
  const directionTrue =
    below.directionTrue !== null && above.directionTrue !== null
      ? Math.round(interpolateDegrees(below.directionTrue, above.directionTrue, fraction))
      : (below.directionTrue ?? above.directionTrue);

  const tempC =
    below.tempC !== null && above.tempC !== null
      ? Math.round(between(below.tempC, above.tempC, fraction))
      : // A temperature is forecast at every level but the lowest, so one
        // missing end means the answer is only as good as the other end.
        (above.tempC ?? below.tempC);

  return { altitudeFt, directionTrue, speedKt, tempC, basis: 'interpolated', from: [below, above] };
}

export interface WindComponents {
  /** Positive is a headwind, negative a tailwind. */
  readonly headwindKt: number;
  /** Positive from the right, negative from the left. */
  readonly crosswindKt: number;
}

/**
 * The wind split along and across a course. Both in knots, and both
 * signed — a tailwind is not the same news as a headwind, and which side
 * the crosswind is from matters to the pilot flying it.
 */
export function windComponents(course: number, wind: { directionTrue: number | null; speedKt: number }): WindComponents | null {
  if (wind.directionTrue === null) return null;
  // Wind direction is where it comes *from*, so the angle off the nose is
  // measured from the course to that bearing.
  const angle = (((wind.directionTrue - course) % 360) + 360) % 360;
  const radians = (angle * Math.PI) / 180;
  return {
    headwindKt: Math.round(wind.speedKt * Math.cos(radians) * 10) / 10,
    crosswindKt: Math.round(wind.speedKt * Math.sin(radians) * 10) / 10,
  };
}
