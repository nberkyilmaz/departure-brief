import type { Airport } from '../domain/airport.js';
import type { FlightPlan } from '../domain/flight.js';
import { distanceNm, initialCourse, parseLatLon, type LatLon } from '../domain/geo.js';
import type { DegreesTrue, NauticalMiles } from '../domain/units.js';
import { nm } from '../domain/units.js';
import type { AirportStore } from '../store/types.js';

export interface Waypoint {
  /** As written in the plan, upper-cased. */
  readonly id: string;
  readonly airport: Airport | null;
  readonly position: LatLon;
  readonly role: 'departure' | 'enroute' | 'destination' | 'alternate';
}

export interface Leg {
  readonly from: Waypoint;
  readonly to: Waypoint;
  readonly distance: NauticalMiles;
  readonly trueCourse: DegreesTrue;
}

export interface RoutePoint {
  readonly waypoint: Waypoint;
  readonly cumulative: NauticalMiles;
  /** Departure time plus cumulative distance at planned TAS. No wind. */
  readonly eta: Date;
}

export interface Route {
  readonly points: readonly RoutePoint[];
  readonly legs: readonly Leg[];
  readonly total: NauticalMiles;
  /** From the destination, at the same TAS. */
  readonly alternate: { readonly point: RoutePoint; readonly leg: Leg } | null;
}

export class UnknownWaypointError extends Error {
  constructor(readonly id: string) {
    super(`unknown waypoint "${id}": not an airport in the store and not a lat,lon pair`);
    this.name = 'UnknownWaypointError';
  }
}

async function resolveWaypoint(store: AirportStore, spec: string, role: Waypoint['role']): Promise<Waypoint> {
  const pos = parseLatLon(spec);
  if (pos) return { id: spec.replace(/\s+/g, ''), airport: null, position: pos, role };
  const id = spec.trim().toUpperCase();
  const airport = await store.getAirport(id);
  if (!airport) throw new UnknownWaypointError(id);
  return { id, airport, position: { lat: airport.lat, lon: airport.lon }, role };
}

function leg(from: Waypoint, to: Waypoint): Leg {
  return { from, to, distance: distanceNm(from.position, to.position), trueCourse: initialCourse(from.position, to.position) };
}

/**
 * Turn a flight plan into positioned waypoints, legs, and an ETA at each
 * point. ETAs are departure time plus distance over planned TAS — no wind;
 * winds-aloft interpolation is optional scope and may be added later.
 */
export async function resolveRoute(store: AirportStore, plan: FlightPlan): Promise<Route> {
  const departure = new Date(plan.departureTime);
  const waypoints: Waypoint[] = [
    await resolveWaypoint(store, plan.departure, 'departure'),
    ...(await Promise.all(plan.route.map((r) => resolveWaypoint(store, r, 'enroute')))),
    await resolveWaypoint(store, plan.destination, 'destination'),
  ];
  const legs: Leg[] = [];
  const points: RoutePoint[] = [];
  let cumulative = 0;
  const etaAt = (dist: number) => new Date(departure.getTime() + (dist / plan.cruise.tas) * 3_600_000);
  waypoints.forEach((w, i) => {
    if (i > 0) {
      const l = leg(waypoints[i - 1]!, w);
      legs.push(l);
      cumulative += l.distance;
    }
    points.push({ waypoint: w, cumulative: nm(cumulative), eta: etaAt(cumulative) });
  });
  let alternate: Route['alternate'] = null;
  if (plan.alternate) {
    const alt = await resolveWaypoint(store, plan.alternate, 'alternate');
    const l = leg(waypoints[waypoints.length - 1]!, alt);
    alternate = { leg: l, point: { waypoint: alt, cumulative: nm(cumulative + l.distance), eta: etaAt(cumulative + l.distance) } };
  }
  return { points, legs, total: nm(cumulative), alternate };
}
