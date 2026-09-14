/**
 * The forecast wind at a waypoint, at the altitude being flown, at the time
 * the aircraft will be there.
 *
 * Upper wind sites are sparse — a handful across a province, not one per
 * aerodrome — so unlike a TAF, borrowing from a neighbour is the normal
 * case rather than the exception. The distance is always reported, because
 * a wind forecast carried 140 nm is worth knowing about as such.
 */
import { decodeUpperWind, UPPERWIND_DECODER_VERSION } from '../decode/upperwind/decode.js';
import type { DecodedUpperWind } from '../decode/upperwind/types.js';
import { windAtAltitude, type WindAloft } from '../decode/upperwind/interpolate.js';
import { distanceNm, type LatLon } from '../domain/geo.js';
import { nm, type NauticalMiles } from '../domain/units.js';
import type { RawReport, Store } from '../store/types.js';

/**
 * How far to look for an upper wind forecast. Wider than the TAF radius
 * because the product is issued for far fewer places: in southern Ontario
 * the nearest site to most aerodromes is Toronto.
 */
export const UPPERWIND_RADIUS_NM = 150;

export interface WaypointWind {
  /** The site the forecast is for. */
  readonly station: string;
  readonly source: 'own' | 'nearby';
  readonly distance: NauticalMiles;
  readonly report: RawReport;
  readonly forecast: DecodedUpperWind;
  /** Interpolated to the altitude asked for; carries the levels it came from. */
  readonly wind: WindAloft;
}

function decodedOf(report: RawReport, stored: unknown): DecodedUpperWind {
  return stored ? (stored as DecodedUpperWind) : decodeUpperWind(report.body);
}

/**
 * The upper wind forecast for one station that applies at instant `t`, out
 * of everything known by `asOf`.
 *
 * Six records cover a day: three bulletins, each issued for the low levels
 * by Canada's office and the high levels by the American one. The record
 * wanted is the one whose use window contains `t` *and* whose levels reach
 * the altitude being flown — asking for 3,500 ft and being handed the
 * bulletin that starts at 24,000 would be worse than being handed nothing.
 */
export async function upperWindFor(
  store: Store,
  station: string,
  altitudeFt: number,
  t: Date,
  asOf: Date,
): Promise<{ report: RawReport; forecast: DecodedUpperWind; wind: WindAloft } | null> {
  const reports = await store.listRaw({ station, kind: 'upperwind', limit: 50, knownBy: asOf });
  const candidates: { report: RawReport; forecast: DecodedUpperWind }[] = [];
  for (const report of reports) {
    const stored = await store.getDecoded(report.sha256, UPPERWIND_DECODER_VERSION);
    const forecast = decodedOf(report, stored?.decoded);
    if (forecast.levels.length === 0) continue;
    const from = forecast.useFrom?.value.getTime();
    const to = forecast.useTo?.value.getTime();
    if (from === undefined || to === undefined || t.getTime() < from || t.getTime() >= to) continue;
    candidates.push({ report, forecast });
  }
  if (candidates.length === 0) return null;

  // The bulletin whose levels actually bracket the altitude, if there is one.
  const covering = candidates.find(
    (c) => altitudeFt >= c.forecast.levels[0]!.altitudeFt && altitudeFt <= c.forecast.levels[c.forecast.levels.length - 1]!.altitudeFt,
  );
  // Otherwise the one whose lowest level is nearest, so that a light
  // aircraft below 3,000 ft gets the low-level bulletin rather than the one
  // that starts in the flight levels.
  const chosen =
    covering ??
    [...candidates].sort((a, b) => Math.abs(a.forecast.levels[0]!.altitudeFt - altitudeFt) - Math.abs(b.forecast.levels[0]!.altitudeFt - altitudeFt))[0]!;

  const wind = windAtAltitude(chosen.forecast.levels, altitudeFt);
  return wind ? { report: chosen.report, forecast: chosen.forecast, wind } : null;
}

/**
 * The wind at a position and altitude at instant `t`: the position's own
 * site if it is one, otherwise the nearest within `UPPERWIND_RADIUS_NM`.
 * `null` when nothing is in reach — which the caller must say plainly
 * rather than fill in with a guess.
 */
export async function windAt(
  store: Store,
  position: LatLon,
  ownStation: string | null,
  altitudeFt: number,
  t: Date,
  asOf: Date,
): Promise<WaypointWind | null> {
  if (ownStation) {
    const own = await upperWindFor(store, ownStation, altitudeFt, t, asOf);
    if (own) return { station: ownStation, source: 'own', distance: nm(0), ...own };
  }
  const nearby = await store.listAirportsNear(position.lat, position.lon, UPPERWIND_RADIUS_NM);
  for (const airport of nearby) {
    const id = airport.icaoId;
    if (!id || id === ownStation) continue;
    const found = await upperWindFor(store, id, altitudeFt, t, asOf);
    if (!found) continue;
    return { station: id, source: 'nearby', distance: distanceNm(position, airport), ...found };
  }
  return null;
}
