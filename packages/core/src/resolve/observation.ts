/**
 * The observation that describes a place — which is not always the
 * observation *at* that place.
 *
 * Most aerodromes do not report at all, and many that do report only part
 * of the day: CYSN closes overnight, and its last METAR sits there getting
 * older while twelve miles away KIAG reports every hour, all night. A
 * briefing that answered "no observation" for CYSN at two in the morning
 * would be technically right and useless.
 *
 * So: the field's own observation while it is current, and otherwise the
 * nearest one that is — always labelled with whose it is, how far away, and
 * how old. The pilot decides what a reading from twelve miles away is worth;
 * this makes sure they know that is what they are looking at.
 */
import { decodeMetar, METAR_DECODER_VERSION, type DecodedMetar } from '../decode/metar/index.js';
import { distanceNm, type LatLon } from '../domain/geo.js';
import { nm, type NauticalMiles } from '../domain/units.js';
import type { RawReport, Store } from '../store/types.js';

/**
 * How far to look for a substitute. The same radius the forecast borrows
 * across, because the argument is the same one: near enough that the
 * weather is usually the same weather, far enough to find a station in a
 * country this empty.
 */
export const OBSERVATION_RADIUS_NM = 60;

/**
 * Past this, a field's own observation stops being "the current weather"
 * and becomes "the last thing it said". A METAR is issued hourly, so an
 * hour and a half allows for a late one without letting yesterday evening
 * stand in for tonight.
 */
export const CURRENT_WITHIN_MS = 90 * 60_000;

export interface WaypointObservation {
  /** The station the observation is from. */
  readonly station: string;
  /** `own` — this aerodrome's; `nearby` — the nearest reporting one. */
  readonly source: 'own' | 'nearby';
  readonly distance: NauticalMiles;
  readonly report: RawReport;
  readonly decoded: DecodedMetar;
  /** How old it was at the briefing instant. Always shown; never used to hide it. */
  readonly ageMinutes: number;
  /**
   * Set when this field reports but was not reporting at the briefing
   * instant — a part-time station asleep, rather than one that has no
   * equipment. The distinction matters to a pilot planning a night arrival.
   */
  readonly ownAsleep: boolean;
}

async function latestFor(store: Store, station: string, asOf: Date): Promise<{ report: RawReport; decoded: DecodedMetar } | null> {
  /*
   * Filtered by when the report was *issued*, not by when this store first
   * saw it. A briefing fetches for itself and then reads what it fetched, so
   * a "first seen by asOf" filter would discard the very observations the
   * request just went and got. The same reasoning the forecast lookup uses.
   */
  const candidates = await store.listRaw({ station, kind: 'metar', limit: 20 });
  const report = candidates.find((r) => r.issuedAt !== null && r.issuedAt.getTime() <= asOf.getTime());
  if (!report) return null;
  const stored = await store.getDecoded(report.sha256, METAR_DECODER_VERSION);
  return { report, decoded: stored ? (stored.decoded as DecodedMetar) : decodeMetar(report.body) };
}

const ageOf = (report: RawReport, asOf: Date): number => Math.round((asOf.getTime() - (report.issuedAt?.getTime() ?? asOf.getTime())) / 60_000);

/**
 * The observation for a position at the briefing instant.
 *
 * The field's own is preferred whenever it is current. When it is stale —
 * or the field never reports — the nearest current one within
 * `OBSERVATION_RADIUS_NM` stands in. When neither exists, a stale own
 * observation is still returned rather than nothing, because "this is what
 * it said four hours ago" is information and a blank is not.
 */
export async function observationAt(store: Store, position: LatLon, ownStation: string | null, asOf: Date): Promise<WaypointObservation | null> {
  const own = ownStation ? await latestFor(store, ownStation, asOf) : null;
  const ownAge = own ? ageOf(own.report, asOf) : null;
  const ownIsCurrent = ownAge !== null && ownAge * 60_000 <= CURRENT_WITHIN_MS;

  if (own && ownIsCurrent) {
    return { station: ownStation!, source: 'own', distance: nm(0), report: own.report, decoded: own.decoded, ageMinutes: ownAge!, ownAsleep: false };
  }

  for (const airport of await store.listAirportsNear(position.lat, position.lon, OBSERVATION_RADIUS_NM)) {
    const id = airport.icaoId;
    if (!id || id === ownStation) continue;
    const found = await latestFor(store, id, asOf);
    if (!found) continue;
    const age = ageOf(found.report, asOf);
    if (age * 60_000 > CURRENT_WITHIN_MS) continue;
    return {
      station: id,
      source: 'nearby',
      distance: distanceNm(position, airport),
      report: found.report,
      decoded: found.decoded,
      ageMinutes: age,
      // It has an observation of its own, just not a current one.
      ownAsleep: own !== null,
    };
  }

  // Nothing current anywhere in reach. The field's own stale reading is
  // better than silence, and its age says exactly how much to trust it.
  if (own) return { station: ownStation!, source: 'own', distance: nm(0), report: own.report, decoded: own.decoded, ageMinutes: ownAge!, ownAsleep: false };
  return null;
}
