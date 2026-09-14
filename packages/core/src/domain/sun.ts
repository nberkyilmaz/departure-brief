/**
 * Solar elevation, for day/night decisions. NOAA's low-precision algorithm
 * (Meeus), accurate to well under a degree for the next century — more than
 * enough to place civil twilight to the minute.
 */

import type { LatLon } from './geo.js';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Elevation of the sun's centre above the horizon, degrees, ignoring refraction. */
export function solarElevation(position: LatLon, at: Date): number {
  const jd = at.getTime() / 86_400_000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) +
    Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const declination = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const y = Math.tan(rad(eps) / 2) ** 2;
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * rad(L0)) -
        2 * e * Math.sin(rad(M)) +
        4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) -
        0.5 * y * y * Math.sin(4 * rad(L0)) -
        1.25 * e * e * Math.sin(2 * rad(M)),
    );
  const minutesUtc = at.getUTCHours() * 60 + at.getUTCMinutes() + at.getUTCSeconds() / 60;
  const trueSolarTime = (((minutesUtc + eqTime + 4 * position.lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 - 180;
  const lat = rad(position.lat);
  const cosZenith =
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(rad(hourAngle));
  return 90 - deg(Math.acos(Math.max(-1, Math.min(1, cosZenith))));
}

/** Civil twilight boundary: night when the sun is more than 6° below the horizon. */
export const CIVIL_TWILIGHT_ELEVATION = -6;

export function isNight(position: LatLon, at: Date): boolean {
  return solarElevation(position, at) < CIVIL_TWILIGHT_ELEVATION;
}

/**
 * Sunrise and sunset are taken at the sun's upper limb on the horizon with
 * refraction allowed for, which is where the published tables put them.
 */
export const HORIZON_ELEVATION = -0.833;

/** The next of each, after the instant asked about. `null` when it does not come. */
export interface SolarEvents {
  readonly sunrise: Date | null;
  readonly sunset: Date | null;
  /** Morning civil twilight begins; in Canada this is where night ends. */
  readonly civilDawn: Date | null;
  /** Evening civil twilight ends: last light, and where night begins. */
  readonly civilDusk: Date | null;
  /** Set at high latitudes when an event does not happen at all that day. */
  readonly allDay: boolean;
  readonly allNight: boolean;
}

/** The instant between `from` and `to` where the elevation crosses `target`. */
function crossing(position: LatLon, target: number, from: Date, to: Date): Date {
  let lo = from.getTime();
  let hi = to.getTime();
  // Which way the sun is going through the boundary, so the same bisection
  // works for a sunrise and a sunset.
  const rising = solarElevation(position, new Date(lo)) < target;
  // Twenty halvings of a ten-minute bracket is well under a second, which is
  // far finer than the algorithm's own accuracy — but cheap, and it means the
  // answer never depends on where the sampling happened to land.
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const above = solarElevation(position, new Date(mid)) >= target;
    if (above === rising) hi = mid;
    else lo = mid;
  }
  return new Date(Math.round((lo + hi) / 2));
}

/** Step size for finding the brackets. Fine enough not to step over a crossing. */
const SAMPLE_MS = 10 * 60_000;

/** How far ahead to look. Enough for a polar summer to prove it has no sunset. */
const HORIZON_HOURS = 36;

/**
 * The next of each solar event after an instant, at a position.
 *
 * Next, rather than "on that day", because a day is not the same thing in
 * Zulu as it is where the aeroplane is: last light in southern Ontario
 * falls after midnight Zulu for half the year, and in British Columbia it
 * always does. "The next sunset after your arrival" needs no timezone to
 * be stated in, and it is the question a pilot is actually asking.
 *
 * Found by walking forward and bisecting each crossing rather than by
 * closed form. It is a few hundred evaluations of arithmetic that is
 * already here, it handles the latitudes where the sun does not rise or
 * set at all — which in Canada is not a curiosity — and there is nothing
 * to get subtly wrong in the algebra.
 */
export function solarEvents(position: LatLon, after: Date): SolarEvents {
  const start = after.getTime();
  const end = start + HORIZON_HOURS * 3_600_000;

  let sunrise: Date | null = null;
  let sunset: Date | null = null;
  let civilDawn: Date | null = null;
  let civilDusk: Date | null = null;
  let highest = -90;
  let lowest = 90;

  let previous = solarElevation(position, new Date(start));
  for (let t = start + SAMPLE_MS; t <= end; t += SAMPLE_MS) {
    const current = solarElevation(position, new Date(t));
    highest = Math.max(highest, current);
    lowest = Math.min(lowest, current);
    const before = new Date(t - SAMPLE_MS);
    const now = new Date(t);
    if (!sunrise && previous < HORIZON_ELEVATION && current >= HORIZON_ELEVATION) sunrise = crossing(position, HORIZON_ELEVATION, before, now);
    if (!sunset && previous >= HORIZON_ELEVATION && current < HORIZON_ELEVATION) sunset = crossing(position, HORIZON_ELEVATION, before, now);
    if (!civilDawn && previous < CIVIL_TWILIGHT_ELEVATION && current >= CIVIL_TWILIGHT_ELEVATION) civilDawn = crossing(position, CIVIL_TWILIGHT_ELEVATION, before, now);
    if (!civilDusk && previous >= CIVIL_TWILIGHT_ELEVATION && current < CIVIL_TWILIGHT_ELEVATION) civilDusk = crossing(position, CIVIL_TWILIGHT_ELEVATION, before, now);
    previous = current;
  }

  return {
    sunrise,
    sunset,
    civilDawn,
    civilDusk,
    // Over a day and a half: if it never got dark, it is not going to.
    allDay: lowest >= CIVIL_TWILIGHT_ELEVATION,
    allNight: highest < CIVIL_TWILIGHT_ELEVATION,
  };
}
