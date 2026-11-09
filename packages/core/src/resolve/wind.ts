/**
 * The wind at a waypoint, at the altitude being flown, at the time the
 * aircraft will be there.
 *
 * Upper wind sites are sparse — a handful across a province, not one per
 * aerodrome — so unlike a TAF, borrowing from a neighbour is the normal
 * case rather than the exception. The distance is always reported, because
 * a wind forecast carried 140 nm is worth knowing about as such.
 *
 * Canada has a forecast to read. The United States stopped issuing one when
 * NOAA discontinued its winds aloft bulletin on 3 November 2026, so what an
 * American field gets is the nearest balloon: not a forecast at all, but
 * what was measured, and it says so, with whose it was and when it flew.
 */
import { decodeUpperWind, UPPERWIND_DECODER_VERSION } from '../decode/upperwind/decode.js';
import type { DecodedUpperWind } from '../decode/upperwind/types.js';
import { windAtAltitude, type WindAloft } from '../decode/upperwind/interpolate.js';
import { distanceNm, type LatLon } from '../domain/geo.js';
import { soundingStationsNear } from '../domain/soundings.js';
import { nm, type NauticalMiles } from '../domain/units.js';
import { reviveUpperWind } from '../store/revive.js';
import type { RawReport, Store } from '../store/types.js';

/**
 * How far to look for an upper wind forecast. Wider than the TAF radius
 * because the product is issued for far fewer places: in southern Ontario
 * the nearest site to most aerodromes is Toronto.
 */
export const UPPERWIND_RADIUS_NM = 150;

/**
 * How far to look for a balloon. There are fewer of them than forecast
 * sites, and this is what reaches all but a handful of the fields in the
 * lower 48, even on a run when a few of them did not report.
 */
export const SOUNDING_RADIUS_NM = 200;

export interface WaypointWind {
  /** The site the forecast is for, or the balloon's WMO number. */
  readonly station: string;
  readonly source: 'own' | 'nearby';
  readonly distance: NauticalMiles;
  readonly report: RawReport;
  readonly forecast: DecodedUpperWind;
  /** Interpolated to the altitude asked for; carries the levels it came from. */
  readonly wind: WindAloft;
  /** Present when a balloon measured this: where it went up, and when. */
  readonly measured?: { readonly by: string; readonly at: Date };
}

function decodedOf(report: RawReport, stored: unknown): DecodedUpperWind {
  // Revived, not cast: a stored record's dates crossed JSON on the way in
  // and come back as strings, and the use-window comparison below calls
  // getTime on them.
  return stored ? reviveUpperWind(stored) : decodeUpperWind(report.body, report.issuedAt);
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
  // A balloon's significant levels can arrive after its mandatory ones, which leaves two reports of one flight. The fuller one is the one wanted.
  candidates.sort((a, b) => (b.report.issuedAt?.getTime() ?? 0) - (a.report.issuedAt?.getTime() ?? 0) || b.forecast.levels.length - a.forecast.levels.length);

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

  const wind = windAtAltitude(chosen.forecast.levels, altitudeFt, chosen.forecast.temperatures);
  return wind ? { report: chosen.report, forecast: chosen.forecast, wind } : null;
}

async function forecastWindAt(store: Store, position: LatLon, ownStation: string | null, altitudeFt: number, t: Date, asOf: Date): Promise<WaypointWind | null> {
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

/** The nearest balloon in reach with a sounding usable at `t`: one that did not fly passes to the next. */
export async function balloonWindAt(store: Store, position: LatLon, altitudeFt: number, t: Date, asOf: Date): Promise<WaypointWind | null> {
  for (const { station, distanceNm: away } of soundingStationsNear(position, SOUNDING_RADIUS_NM)) {
    const found = await upperWindFor(store, station.id, altitudeFt, t, asOf);
    if (!found?.forecast.validAt) continue;
    return { station: station.id, source: 'nearby', distance: nm(away), measured: { by: station.name, at: found.forecast.validAt.value }, ...found };
  }
  return null;
}

/** Whether a position is in the country that has balloons and no forecast: the named field's, or the nearest one's. */
export async function isAmerican(store: Store, position: LatLon, ownStation: string | null): Promise<boolean> {
  const own = ownStation ? await store.getAirport(ownStation) : null;
  const airport = own ?? (await store.listAirportsNear(position.lat, position.lon, UPPERWIND_RADIUS_NM))[0];
  return airport?.country === 'US';
}

/**
 * The wind at a position and altitude at instant `t`. In Canada, the
 * position's own forecast site if it is one, otherwise the nearest within
 * `UPPERWIND_RADIUS_NM`; in the United States, the nearest balloon. Each
 * falls back on the other. `null` when nothing is in reach — which the
 * caller must say plainly rather than fill in with a guess.
 */
export async function windAt(
  store: Store,
  position: LatLon,
  ownStation: string | null,
  altitudeFt: number,
  t: Date,
  asOf: Date,
): Promise<WaypointWind | null> {
  const forecast = () => forecastWindAt(store, position, ownStation, altitudeFt, t, asOf);
  const balloon = () => balloonWindAt(store, position, altitudeFt, t, asOf);
  return (await isAmerican(store, position, ownStation)) ? ((await balloon()) ?? (await forecast())) : ((await forecast()) ?? (await balloon()));
}
