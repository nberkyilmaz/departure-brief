import type { DegreesTrue, NauticalMiles } from './units.js';
import { degTrue, nm } from './units.js';

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

const EARTH_RADIUS_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in nautical miles (haversine). */
export function distanceNm(a: LatLon, b: LatLon): NauticalMiles {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return nm(2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Initial great-circle course from `a` to `b`, degrees true, 0–360. */
export function initialCourse(a: LatLon, b: LatLon): DegreesTrue {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
  return degTrue((deg(Math.atan2(y, x)) + 360) % 360);
}

/** `"40.6399,-73.7787"` → a position; `null` if it is not one. */
export function parseLatLon(text: string): LatLon | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
