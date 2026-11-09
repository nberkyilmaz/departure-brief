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

/** The position `distance` nm from `a`, setting out on `course` degrees true. */
export function pointOnCourse(a: LatLon, course: number, distance: number): LatLon {
  const δ = distance / EARTH_RADIUS_NM;
  const θ = rad(course);
  const φ1 = rad(a.lat);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = rad(a.lon) + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 };
}

/** The position `distance` nm from `a` along the great circle towards `b`. */
export function pointAlong(a: LatLon, b: LatLon, distance: number): LatLon {
  return pointOnCourse(a, initialCourse(a, b), distance);
}

/**
 * Where `p` lies against the great circle from `a` to `b`: how far along it
 * from `a` the point is abeam, negative when it is behind `a`, and how far
 * off it, positive to the right of the direction of flight.
 */
export function trackPosition(a: LatLon, b: LatLon, p: LatLon): { alongNm: number; offsetNm: number } {
  const d13 = distanceNm(a, p) / EARTH_RADIUS_NM;
  if (d13 === 0) return { alongNm: 0, offsetNm: 0 };
  const off = rad(initialCourse(a, p)) - rad(initialCourse(a, b));
  const cross = Math.asin(Math.sin(d13) * Math.sin(off));
  const along = Math.acos(Math.min(1, Math.max(-1, Math.cos(d13) / Math.cos(cross))));
  // The cosine loses which way along: a point behind `a` is ahead of it to `acos`.
  return { alongNm: (Math.cos(off) < 0 ? -along : along) * EARTH_RADIUS_NM, offsetNm: cross * EARTH_RADIUS_NM };
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
