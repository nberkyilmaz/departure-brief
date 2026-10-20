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
 * The forecast that governs a position at instant `t`, as known at `asOf`.
 *
 * The position's own TAF when it has one that covers `t`; otherwise the
 * nearest one within `NEARBY_RADIUS_NM` that does, labelled as borrowed.
 *
 * The order matters, and it took real data to get right. Part-time
 * stations — CYSN among them — publish a TAF that expires overnight, and a
 * briefing that stopped at "the field has a TAF" would answer "no forecast
 * covers your departure" while a valid one sat thirty-six miles away at
 * Hamilton. A pilot would use Hamilton's. So does this, and it says so.
 *
 * When nothing covers `t`, the field's own expired TAF is returned anyway,
 * so the briefing can show what it had and why it was not enough. `null`
 * only when there is no forecast within reach at all.
 */
export async function forecastAt(
  store: Store,
  position: LatLon,
  ownStation: string | null,
  t: Date,
  asOf: Date,
): Promise<WaypointForecast | null> {
  let own: WaypointForecast | null = null;
  if (ownStation) {
    const found = await latestTaf(store, ownStation, asOf);
    if (found && found.report.issuedAt) {
      own = {
        station: ownStation,
        source: 'own',
        distance: nm(0),
        report: found.report,
        taf: found.taf,
        resolved: resolveTaf(found.taf, found.report.issuedAt, t),
      };
      if (own.resolved.prevailing) return own;
    }
  }

  const nearby = await store.listAirportsNear(position.lat, position.lon, NEARBY_RADIUS_NM);
  let expired: WaypointForecast | null = null;
  for (const airport of nearby) {
    if (!airport.icaoId || airport.icaoId === ownStation) continue;
    const found = await latestTaf(store, airport.icaoId, asOf);
    if (!found || !found.report.issuedAt) continue;
    const candidate: WaypointForecast = {
      station: airport.icaoId,
      source: 'nearby',
      distance: distanceNm(position, airport),
      report: found.report,
      taf: found.taf,
      resolved: resolveTaf(found.taf, found.report.issuedAt, t),
    };
    if (candidate.resolved.prevailing) return candidate;
    // Nearest first, so the first one that does not cover `t` is the best
    // of a bad set — kept only in case nothing better turns up.
    expired ??= candidate;
  }

  return own ?? expired;
}
