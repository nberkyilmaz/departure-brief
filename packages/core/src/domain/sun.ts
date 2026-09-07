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
