/**
 * Does the route go through the area?
 *
 * Hazard advisories — SIGMETs and the like — come with a polygon, and the
 * only question that matters is whether the flight crosses it. That is two
 * plain geometric tests: is an endpoint inside, and does any leg cross an
 * edge.
 *
 * Treated as flat in longitude and latitude. Over the few hundred miles a
 * light aircraft flies, and against areas drawn to the nearest degree, the
 * error is far smaller than the polygon's own precision. Two places where
 * flat is not good enough are refused rather than answered wrongly: a
 * polygon that wraps the antimeridian, and one that reaches a pole.
 */
import type { LatLon } from './geo.js';

/** Longitude span beyond which a polygon is assumed to wrap the antimeridian. */
const WRAP_DEGREES = 180;
/** Latitude beyond which longitude stops behaving like a distance. */
const POLAR_LATITUDE = 85;

export interface AreaProblem {
  readonly reason: string;
}

/**
 * `true` when the area can be tested flat. Areas that cannot are reported,
 * never quietly judged: an answer of "your route does not cross this" is
 * worth nothing if the geometry was wrong.
 */
export function areaIsTestable(area: readonly LatLon[]): AreaProblem | null {
  if (area.length < 3) return { reason: 'the area has fewer than three corners' };
  const lons = area.map((p) => p.lon);
  if (Math.max(...lons) - Math.min(...lons) > WRAP_DEGREES) return { reason: 'the area spans more than half the globe, so it wraps the antimeridian' };
  if (area.some((p) => Math.abs(p.lat) > POLAR_LATITUDE)) return { reason: 'the area reaches the pole, where this test does not hold' };
  return null;
}

/**
 * Ray casting: count the edges a ray east of the point crosses. Odd means
 * inside. A point exactly on an edge may land either way, which no
 * briefing should depend on — and does not, because the leg test catches
 * the same case.
 */
export function pointInArea(point: LatLon, area: readonly LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    const a = area[i]!;
    const b = area[j]!;
    const straddles = a.lat > point.lat !== b.lat > point.lat;
    if (!straddles) continue;
    const crossing = ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon;
    if (point.lon < crossing) inside = !inside;
  }
  return inside;
}

/** Do the two segments cross? Touching counts, which is the cautious reading. */
export function segmentsCross(p1: LatLon, p2: LatLon, p3: LatLon, p4: LatLon): boolean {
  const d = (a: LatLon, b: LatLon, c: LatLon) => (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear and overlapping: a leg running along an edge is inside it.
  const onSegment = (a: LatLon, b: LatLon, c: LatLon) =>
    Math.min(a.lat, b.lat) <= c.lat && c.lat <= Math.max(a.lat, b.lat) && Math.min(a.lon, b.lon) <= c.lon && c.lon <= Math.max(a.lon, b.lon);
  return (d1 === 0 && onSegment(p3, p4, p1)) || (d2 === 0 && onSegment(p3, p4, p2)) || (d3 === 0 && onSegment(p1, p2, p3)) || (d4 === 0 && onSegment(p1, p2, p4));
}

/**
 * Does a route — the points in order — enter the area at any point along
 * it? A route that starts and ends outside but passes through counts, which
 * is the whole reason this is not just a test of the waypoints.
 */
export function routeCrossesArea(route: readonly LatLon[], area: readonly LatLon[]): boolean {
  if (route.some((p) => pointInArea(p, area))) return true;
  for (let i = 1; i < route.length; i++) {
    const from = route[i - 1]!;
    const to = route[i]!;
    for (let j = 0, k = area.length - 1; j < area.length; k = j++) {
      if (segmentsCross(from, to, area[j]!, area[k]!)) return true;
    }
  }
  return false;
}

/**
 * The shortest distance from a point to the area's boundary, in degrees of
 * latitude — which is close enough to nautical miles at 60 to the degree
 * for judging "near". Zero inside.
 */
function distanceToSegmentDeg(point: LatLon, a: LatLon, b: LatLon): number {
  // Longitude shrinks with latitude; without this, "near" would be several
  // times wider than it is tall anywhere in Canada.
  const scale = Math.cos((point.lat * Math.PI) / 180);
  const px = (point.lon - a.lon) * scale;
  const py = point.lat - a.lat;
  const bx = (b.lon - a.lon) * scale;
  const by = b.lat - a.lat;
  const lengthSquared = bx * bx + by * by;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared));
  const dx = px - t * bx;
  const dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** How far the route passes from the area, in nautical miles. Zero when it crosses. */
export function routeDistanceToAreaNm(route: readonly LatLon[], area: readonly LatLon[]): number {
  if (routeCrossesArea(route, area)) return 0;
  let nearest = Infinity;
  for (const point of route) {
    for (let j = 0, k = area.length - 1; j < area.length; k = j++) {
      nearest = Math.min(nearest, distanceToSegmentDeg(point, area[j]!, area[k]!));
    }
  }
  return nearest * 60;
}
