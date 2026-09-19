/**
 * Everything known about one aerodrome at one instant.
 *
 * A field's page and a briefing that includes that field must never
 * disagree, so this is assembled from exactly the functions the flight path
 * uses — `observationAt`, `forecastAt`, `flightCategoryOf`,
 * `analyseCrosswind`, `solarEvents`, and the same checks. Nothing here
 * computes anything of its own; it arranges what the pipeline already
 * produces around a place rather than around a route.
 *
 * It needs no flight plan. Most of the time a pilot looking at a field is
 * not briefing a flight yet — they are deciding whether to.
 */
import { flightCategory, flightCategoryOf, visibilityStatuteMiles, ceilingOf } from '../decode/metar/index.js';
import type { FlightCategory } from '../decode/metar/derive.js';
import type { Airport } from '../domain/airport.js';
import { distanceNm, initialCourse } from '../domain/geo.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import { isNight, solarEvents, type SolarEvents } from '../domain/sun.js';
import { checkConditions } from '../rules/checks.js';
import { checkDaylight } from '../rules/daylight.js';
import { checkObservation } from '../rules/observation.js';
import { metarConditions } from '../rules/evaluate.js';
import type { Finding } from '../rules/types.js';
import type { Store } from '../store/types.js';
import { forecastAt, type WaypointForecast } from '../resolve/forecast.js';
import { observationAt, OBSERVATION_RADIUS_NM, type WaypointObservation } from '../resolve/observation.js';

/** A neighbouring field, for "where else could I look". */
export interface NearbyField {
  readonly id: string;
  readonly name: string;
  readonly distanceNm: number;
  readonly bearingTrue: number;
  /** How old that field's newest observation is, or null when it has none. */
  readonly ageMinutes: number | null;
}

export interface AerodromeReport {
  readonly airport: Airport;
  readonly at: string;
  /** The observation describing this field — its own, or the nearest current one. */
  readonly observation: WaypointObservation | null;
  readonly forecast: WaypointForecast | null;
  /** From the observation, whosever it is. */
  readonly category: FlightCategory | null;
  /** From the prevailing forecast at this instant. */
  readonly forecastCategory: FlightCategory | null;
  readonly night: boolean;
  readonly daylight: SolarEvents;
  /** The same lines a briefing of this field would produce, in the same order. */
  readonly findings: readonly Finding[];
  readonly nearby: readonly NearbyField[];
}

/** How many neighbours to offer. Enough to find a reporting one, few enough to read. */
export const NEARBY_FIELDS = 6;

/**
 * Assemble the report. `profile` and `aircraft` are what the comparisons
 * are made against — the same ones a briefing would use — because a field
 * page that ignored the pilot's own limits would be a worse version of
 * every other weather site.
 */
export async function aerodromeReport(store: Store, id: string, at: Date, profile: PilotProfile, aircraft: AircraftLimits | null): Promise<AerodromeReport | null> {
  const airport = await store.getAirport(id);
  if (!airport) return null;
  const position = { lat: airport.lat, lon: airport.lon };
  const station = airport.icaoId;

  const observation = await observationAt(store, position, station, at);
  const forecast = await forecastAt(store, position, station, at, at);
  const prevailing = forecast?.resolved.prevailing ?? null;

  const findings: Finding[] = [...checkObservation({ waypoint: airport.icaoId ?? airport.faaId, at }, observation)];
  const night = isNight(position, at);
  const base = {
    waypoint: airport.icaoId ?? airport.faaId,
    at,
    profile,
    aircraft,
    airport,
    airspace: null,
    // A field page is not a flight, so there is no cruise altitude to clear
    // cloud against. The regulatory checks that need one say so themselves.
    cruiseAltitude: 0 as never,
    night,
  };

  if (prevailing) {
    findings.push(
      ...checkConditions(
        { ...base, basis: 'prevailing', basisKind: 'prevailing', violation: 'alert', source: { kind: 'taf', station: forecast!.station, raw: forecast!.resolved.raw, sha256: forecast!.report.sha256 } },
        prevailing.conditions,
      ),
    );
  }
  if (observation) {
    findings.push(
      ...checkConditions(
        {
          ...base,
          basis: `observed${observation.source === 'nearby' ? ` at ${observation.station}` : ''}`,
          basisKind: 'observed',
          violation: 'alert',
          source: { kind: 'metar', station: observation.station, raw: observation.report.body, sha256: observation.report.sha256 },
        },
        metarConditions(observation.decoded),
      ),
    );
  }
  findings.push(...checkDaylight({ waypoint: airport.icaoId ?? airport.faaId, position, at, nightAllowed: profile.nightAllowed }));

  /*
   * Where else to look. The age of each neighbour's newest observation is
   * the useful part: at four in the morning it is how a pilot finds the one
   * field in the region that is awake.
   */
  const nearby: NearbyField[] = [];
  for (const other of await store.listAirportsNear(position.lat, position.lon, OBSERVATION_RADIUS_NM)) {
    if (other.icaoId === station || (other.icaoId ?? other.faaId) === (airport.icaoId ?? airport.faaId)) continue;
    const theirs = other.icaoId ? await store.listRaw({ station: other.icaoId, kind: 'metar', limit: 1 }) : [];
    const issued = theirs[0]?.issuedAt ?? null;
    nearby.push({
      id: other.icaoId ?? other.faaId,
      name: other.name,
      distanceNm: Math.round(distanceNm(position, other) * 10) / 10,
      bearingTrue: Math.round(initialCourse(position, other)),
      ageMinutes: issued ? Math.round((at.getTime() - issued.getTime()) / 60_000) : null,
    });
    if (nearby.length >= NEARBY_FIELDS) break;
  }

  return {
    airport,
    at: at.toISOString(),
    observation,
    forecast,
    category: observation ? flightCategory(observation.decoded) : null,
    forecastCategory: prevailing ? flightCategoryOf(ceilingOf(prevailing.conditions.sky)?.value ?? null, prevailing.conditions.visibility ? visibilityStatuteMiles(prevailing.conditions.visibility.value) : null) : null,
    night,
    daylight: solarEvents(position, at),
    findings,
    nearby,
  };
}
