import type { FlightPlan } from '../domain/flight.js';
import type { Store } from '../store/types.js';
import { stationsAlong, type CorridorStation, type EnrouteStation } from './enroute.js';
import { forecastAt, type WaypointForecast } from './forecast.js';
import { hazardsKnownBy, type HazardAdvisory } from './hazards.js';
import { observationAt, type WaypointObservation } from './observation.js';
import { resolveRoute, type Route, type RoutePoint } from './route.js';
import { windAt, type WaypointWind } from './wind.js';

export interface ResolvedPoint {
  readonly point: RoutePoint;
  /** The forecast governing this point at its ETA, or `null` with the reason visible to the user. */
  readonly forecast: WaypointForecast | null;
  /**
   * The observation describing this place: the field's own while it is
   * current, otherwise the nearest reporting one, labelled with whose it is
   * and how far away. Null only when nothing is in reach at all.
   */
  readonly metar: WaypointObservation | null;
  /**
   * The forecast wind at the planned cruise altitude. Null when no upper
   * wind forecast covers this place and time — never filled in with a
   * guess, because the whole point of the number is the fuel it implies.
   */
  readonly wind: WaypointWind | null;
}

export interface ResolvedFlight {
  readonly plan: FlightPlan;
  /** The briefing instant: only reports known by then are used. */
  readonly asOf: Date;
  readonly route: Route;
  readonly points: readonly ResolvedPoint[];
  readonly alternate: ResolvedPoint | null;
  /**
   * Hazard advisories known at `asOf`. Kept on the flight rather than the
   * points, because an area is not a place: which points it concerns is
   * decided by geometry, not by which aerodrome it was filed under.
   */
  readonly hazards: readonly HazardAdvisory[];
  /**
   * The reporting stations near the track between the points, in the order
   * they are passed, each read for the time the aircraft is abeam it.
   */
  readonly enroute: readonly EnrouteStation[];
}

async function resolvePoint(store: Store, point: RoutePoint, asOf: Date, cruiseAltitudeFt: number): Promise<ResolvedPoint> {
  const station = point.waypoint.airport?.icaoId ?? null;
  const forecast = await forecastAt(store, point.waypoint.position, station, point.eta, asOf);
  const metar = await observationAt(store, point.waypoint.position, station, asOf);
  const wind = await windAt(store, point.waypoint.position, station, cruiseAltitudeFt, point.eta, asOf);
  return { point, forecast, metar, wind };
}

/**
 * Resolve a flight plan to conditions at each point at the time the aircraft
 * will be there, using only what the store knew at `asOf`. `corridor` is
 * the stations beside the route, when the caller has already found them for
 * the same route at another time.
 */
export async function resolveFlight(store: Store, plan: FlightPlan, asOf: Date, corridor?: readonly CorridorStation[]): Promise<ResolvedFlight> {
  const route = await resolveRoute(store, plan);
  const cruise = plan.cruise.altitude;
  const points = [];
  for (const p of route.points) points.push(await resolvePoint(store, p, asOf, cruise));
  const alternate = route.alternate ? await resolvePoint(store, route.alternate.point, asOf, cruise) : null;
  const last = [...points, ...(alternate ? [alternate] : [])].reduce((latest, p) => Math.max(latest, p.point.eta.getTime()), asOf.getTime());
  const hazards = await hazardsKnownBy(store, asOf, new Date(last));
  // Every station a named field already reads, its own or borrowed, so none of them is read twice.
  const known = new Set<string>();
  for (const p of [...points, ...(alternate ? [alternate] : [])]) {
    const id = p.point.waypoint.airport?.icaoId;
    if (id) known.add(id.toUpperCase());
    if (p.forecast) known.add(p.forecast.station.toUpperCase());
    if (p.metar) known.add(p.metar.station.toUpperCase());
  }
  const enroute = await stationsAlong(store, route, plan.cruise.tas, asOf, known, corridor);
  return { plan, asOf, route, points, alternate, hazards, enroute };
}
