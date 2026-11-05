/**
 * The weather between the places a flight names.
 *
 * A flight is judged where it leaves, where it turns and where it lands.
 * Flown direct, that is two fields, and a briefing of two fields can say
 * VFR at both ends of a flight that crosses a line of thunderstorms half way.
 * On the day this was written, about one random flight in four had a
 * station within twenty miles of its track reporting worse than either end,
 * and one in twenty two categories worse: VFR at both ends and IFR between.
 *
 * So every station near the track is read as well, at the time the aircraft
 * would be abeam it: its own TAF where one covers that time, and its own
 * METAR while it is current. Never a neighbour's, as the ends borrow: along
 * a route the neighbours are on the list in their own right, and a station
 * that has nothing to say for itself is left out rather than spoken for.
 */
import type { Airport } from '../domain/airport.js';
import { pointAlong, trackPosition } from '../domain/geo.js';
import { nm, type NauticalMiles } from '../domain/units.js';
import type { Store } from '../store/types.js';
import { latestTaf, type WaypointForecast } from './forecast.js';
import { ageOf, CURRENT_WITHIN_MS, latestMetar, type WaypointObservation } from './observation.js';
import type { Leg, Route } from './route.js';
import { resolveTaf } from './taf.js';

/**
 * How far either side of the track a station counts as on the way: the
 * distance at which a hazard advisory is called near, and the corridor a
 * standard briefing reads along a route.
 */
export const CORRIDOR_NM = 25;

/**
 * Within this, a station describes the weather on the line itself rather
 * than beside it. A TAF speaks for five statute miles around its field and
 * a METAR's vicinity reaches ten; this is that, rounded up to a number a
 * pilot would use.
 */
export const ON_TRACK_NM = 10;

export interface EnrouteStation {
  /** The station, by ICAO identifier. */
  readonly station: string;
  readonly airport: Airport;
  /** Which leg of the route it is beside: 0 for the first. */
  readonly leg: number;
  /** From the departure, along the track, to the point abeam it. */
  readonly cumulative: NauticalMiles;
  /** How far off the track it is, positive to the right of the direction of flight. */
  readonly offset: number;
  /** When the aircraft would be abeam it: the same arithmetic as every other ETA, distance over planned speed. */
  readonly eta: Date;
  /** Its own TAF, when one covers `eta`. */
  readonly forecast: WaypointForecast | null;
  /** Its own METAR, while it is current. */
  readonly metar: WaypointObservation | null;
}

/**
 * Every aerodrome within the corridor of one leg. Asked of the store as a
 * row of circles along the track, each wide enough that together they
 * cover the whole strip, then cut to the strip exactly.
 */
async function airportsAlong(store: Store, leg: Leg): Promise<Airport[]> {
  const steps = Math.max(1, Math.ceil(leg.distance / CORRIDOR_NM));
  const spacing = leg.distance / steps;
  // A circle this wide, every `spacing`, reaches each corner of the strip between its centre and the next.
  const reach = Math.hypot(CORRIDOR_NM, spacing / 2) + 1;
  const found = new Map<string, Airport>();
  for (let i = 0; i <= steps; i++) {
    const centre = pointAlong(leg.from.position, leg.to.position, spacing * i);
    for (const airport of await store.listAirportsNear(centre.lat, centre.lon, reach)) {
      if (airport.icaoId) found.set(airport.icaoId.toUpperCase(), airport);
    }
  }
  return [...found.values()];
}

async function forecastFor(store: Store, station: string, eta: Date, asOf: Date): Promise<WaypointForecast | null> {
  const found = await latestTaf(store, station, asOf);
  if (!found?.report.issuedAt) return null;
  const resolved = resolveTaf(found.taf, found.report.issuedAt, eta);
  return resolved.prevailing ? { station, source: 'own', distance: nm(0), report: found.report, taf: found.taf, resolved } : null;
}

async function observationFor(store: Store, station: string, asOf: Date): Promise<WaypointObservation | null> {
  const found = await latestMetar(store, station, asOf);
  if (!found) return null;
  const age = ageOf(found.report, asOf);
  if (age * 60_000 > CURRENT_WITHIN_MS) return null;
  return { station, source: 'own', distance: nm(0), report: found.report, decoded: found.decoded, ageMinutes: age, ownAsleep: false };
}

/** An aerodrome beside the track, and where: the part of the answer that does not change with the time you leave. */
export interface CorridorStation {
  readonly station: string;
  readonly airport: Airport;
  readonly leg: number;
  /** From the start of its leg to the point abeam it. */
  readonly alongLeg: number;
  readonly offset: number;
}

/**
 * Every aerodrome beside a route that could report: the geometry alone.
 *
 * Only what lies between the ends of a leg counts: a station behind the
 * departure, or past the destination, is not on the way. A station beside
 * two legs, at a turn, is taken where it is nearest the track. None of it
 * depends on when you leave, so the hours of the window share one answer
 * rather than each asking the store for it again.
 */
export async function corridorOf(store: Store, route: Route): Promise<CorridorStation[]> {
  const nearest = new Map<string, CorridorStation>();
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i]!;
    for (const airport of await airportsAlong(store, leg)) {
      const station = airport.icaoId!.toUpperCase();
      const { alongNm, offsetNm } = trackPosition(leg.from.position, leg.to.position, airport);
      if (alongNm <= 0 || alongNm >= leg.distance || Math.abs(offsetNm) > CORRIDOR_NM) continue;
      const seen = nearest.get(station);
      if (seen && Math.abs(seen.offset) <= Math.abs(offsetNm)) continue;
      nearest.set(station, { station, airport, leg: i, alongLeg: alongNm, offset: offsetNm });
    }
  }
  return [...nearest.values()];
}

/**
 * The stations along a route that have something to say about the time
 * the aircraft passes them, in the order it passes them.
 *
 * None already read for a field the flight names: `known` holds those, so
 * the Hamilton METAR a departure borrowed is not read a second time as
 * though it were news. `corridor`, when given, is the route's from
 * `corridorOf`, worked out once.
 */
export async function stationsAlong(
  store: Store,
  route: Route,
  tasKt: number,
  asOf: Date,
  known: ReadonlySet<string>,
  corridor?: readonly CorridorStation[],
): Promise<EnrouteStation[]> {
  const out: EnrouteStation[] = [];
  for (const c of corridor ?? (await corridorOf(store, route))) {
    if (known.has(c.station)) continue;
    const start = route.points[c.leg]!;
    const eta = new Date(start.eta.getTime() + (c.alongLeg / tasKt) * 3_600_000);
    const forecast = await forecastFor(store, c.station, eta, asOf);
    const metar = await observationFor(store, c.station, asOf);
    if (!forecast && !metar) continue;
    out.push({ station: c.station, airport: c.airport, leg: c.leg, cumulative: nm(start.cumulative + c.alongLeg), offset: c.offset, eta, forecast, metar });
  }
  return out.sort((a, b) => a.cumulative - b.cumulative || a.station.localeCompare(b.station));
}
