import { decodeTaf, TAF_DECODER_VERSION, type DecodedTaf } from '../decode/taf/index.js';
import { distanceNm, type LatLon } from '../domain/geo.js';
import type { NauticalMiles } from '../domain/units.js';
import { nm } from '../domain/units.js';
import type { RawReport, Store } from '../store/types.js';
import { resolveTaf, type ResolvedForecast } from './taf.js';

/** How far to look for a TAF when a field has none of its own. */
export const NEARBY_RADIUS_NM = 60;

export interface WaypointForecast {
  /** The station whose TAF this is. */
  readonly station: string;
  /** `own` — the waypoint's own TAF; `nearby` — borrowed from `station` at `distance`. */
  readonly source: 'own' | 'nearby';
  readonly distance: NauticalMiles;
  readonly report: RawReport;
  readonly taf: DecodedTaf;
  readonly resolved: ResolvedForecast;
}

/** The newest TAF for a station issued at or before `asOf`, decoded. */
export async function latestTaf(store: Store, station: string, asOf: Date): Promise<{ report: RawReport; taf: DecodedTaf } | null> {
  const candidates = await store.listRaw({ station, kind: 'taf', limit: 10 });
  const report = candidates.find((r) => r.issuedAt !== null && r.issuedAt.getTime() <= asOf.getTime());
  if (!report) return null;
  const stored = await store.getDecoded(report.sha256, TAF_DECODER_VERSION);
  const taf = stored ? (stored.decoded as DecodedTaf) : decodeTaf(report.body);
  return { report, taf };
}

/**
 * The forecast that governs a position at instant `t`, as known at `asOf`:
 * the position's own TAF if it is an airport that has one, otherwise the
 * nearest TAF within `NEARBY_RADIUS_NM`, labelled as such. `null` when
 * nothing is within reach — the caller must say so, not guess.
 */
export async function forecastAt(
  store: Store,
  position: LatLon,
  ownStation: string | null,
  t: Date,
  asOf: Date,
): Promise<WaypointForecast | null> {
  if (ownStation) {
    const own = await latestTaf(store, ownStation, asOf);
    if (own && own.report.issuedAt) {
      return {
        station: ownStation,
        source: 'own',
        distance: nm(0),
        report: own.report,
        taf: own.taf,
        resolved: resolveTaf(own.taf, own.report.issuedAt, t),
      };
    }
  }
  const nearby = await store.listAirportsNear(position.lat, position.lon, NEARBY_RADIUS_NM);
  for (const airport of nearby) {
    if (!airport.icaoId || airport.icaoId === ownStation) continue;
    const found = await latestTaf(store, airport.icaoId, asOf);
    if (!found || !found.report.issuedAt) continue;
    return {
      station: airport.icaoId,
      source: 'nearby',
      distance: distanceNm(position, airport),
      report: found.report,
      taf: found.taf,
      resolved: resolveTaf(found.taf, found.report.issuedAt, t),
    };
  }
  return null;
}
