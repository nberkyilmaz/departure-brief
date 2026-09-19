/**
 * Fetching the reports a field might have to borrow.
 *
 * `observationAt` will stand the nearest current observation in for a field
 * that is not reporting — CYSN at two in the morning reads KIAG across the
 * river. That works on a store that already holds the neighbourhood's
 * reports, which is true of the recorded snapshot the published page
 * carries and false of a live instance, because a live instance fetches
 * only the stations named in the flight plan. Asked for a briefing at CYSN
 * it would fetch CYSN, find nothing current, look for a neighbour, and find
 * nothing at all — the feature silently absent on exactly the deployment it
 * was written for.
 *
 * So when a field has nothing current of its own, the area around it is
 * fetched: one request, returning whichever stations near there are
 * reporting. Which stations those are is not guessed from runway lengths or
 * identifiers — it is what the service answers.
 */
import type { LatLon } from '../domain/geo.js';
import type { Store } from '../store/types.js';
import { CURRENT_WITHIN_MS, OBSERVATION_RADIUS_NM } from '../resolve/observation.js';
import type { AwcClient, LatLonBox } from './awc.js';
import { recordFetchAttempt, shouldFetch } from './freshness.js';
import { storeAndDecode } from '../store/decode.js';

/**
 * How long a neighbourhood fetch counts as recent. An hour: METARs are
 * issued hourly, and the point of this is to have *something* current
 * nearby rather than to track a station minute by minute.
 */
export const NEIGHBOURHOOD_FRESHNESS_MS = 60 * 60_000;

/** Degrees of latitude in {@link OBSERVATION_RADIUS_NM}. A degree of latitude is 60 nm everywhere. */
const LAT_PAD = OBSERVATION_RADIUS_NM / 60;

export interface NeighbourhoodResult {
  /** Whether an upstream request was made. */
  readonly asked: boolean;
  /** Reports stored, new or already known. */
  readonly reports: number;
  /** The grid cell asked for, which is what the freshness window is kept against. */
  readonly scope: string;
  /** Why nothing was asked, when nothing was. */
  readonly reason: string | null;
}

/**
 * The box to ask about, and the name the asking is remembered under.
 *
 * Whole degrees, so that two briefings a few miles apart ask the same
 * question and the second one is answered from the store. The box is the
 * cell *plus* the borrowing radius on every side, which means any position
 * inside the cell has its whole radius covered — without that a flight from
 * the corner of a cell would be told there is nothing nearby when there is
 * something eight miles away in the next one.
 */
export function neighbourhoodCell(position: LatLon): { scope: string; box: LatLonBox } {
  const cellLat = Math.floor(position.lat);
  const cellLon = Math.floor(position.lon);
  const minLat = cellLat - LAT_PAD;
  const maxLat = cellLat + 1 + LAT_PAD;
  /*
   * A degree of longitude shrinks towards the poles, so the padding is
   * computed at whichever edge of the cell is nearer one — the wider box of
   * the two, so the radius is covered along the whole cell rather than only
   * at its equator-facing edge. Clamped because at 89° the scaling runs
   * away, and a box wider than the world is not a box.
   */
  const worstLat = Math.min(89, Math.max(Math.abs(minLat), Math.abs(maxLat)));
  const lonPad = Math.min(30, LAT_PAD / Math.max(0.05, Math.cos((worstLat * Math.PI) / 180)));
  return {
    scope: `BOX:${cellLat},${cellLon}`,
    box: { minLat, minLon: cellLon - lonPad, maxLat, maxLon: cellLon + 1 + lonPad },
  };
}

/** Whether this station has an observation recent enough that nothing needs to stand in for it. */
async function hasCurrentObservation(store: Store, station: string | null, asOf: Date): Promise<boolean> {
  if (station === null) return false;
  const candidates = await store.listRaw({ station, kind: 'metar', limit: 5 });
  return candidates.some((r) => {
    if (r.issuedAt === null) return false;
    const age = asOf.getTime() - r.issuedAt.getTime();
    return age >= 0 && age <= CURRENT_WITHIN_MS;
  });
}

/**
 * Fetch the reporting stations around a position, if this field has nothing
 * current of its own and the area has not been asked about recently.
 *
 * Deliberately not done for every waypoint of every briefing: most fields
 * most of the time report perfectly well, and a request that would change
 * nothing is a request somebody else's service pays for.
 */
export async function ingestNeighbourhood(
  deps: { readonly store: Store; readonly awc: AwcClient },
  position: LatLon,
  ownStation: string | null,
  asOf: Date = new Date(),
): Promise<NeighbourhoodResult> {
  const { store, awc } = deps;
  const { scope, box } = neighbourhoodCell(position);

  if (await hasCurrentObservation(store, ownStation, asOf)) {
    return { asked: false, reports: 0, scope, reason: `${ownStation} is reporting; nothing needs to stand in for it` };
  }
  if (!(await shouldFetch(store, scope, 'metar', asOf, NEIGHBOURHOOD_FRESHNESS_MS))) {
    return { asked: false, reports: 0, scope, reason: 'this area was asked about within the hour' };
  }

  const fetched = await awc.metarsInBox(box);
  // Recorded as asked whether or not anything came back, so an area with no
  // reporting stations is not re-asked on every briefing.
  await recordFetchAttempt(store, scope, 'metar', asOf, fetched.request);
  await storeAndDecode(store, fetched.reports, fetched.request, asOf, null);
  return { asked: true, reports: fetched.reports.length, scope, reason: null };
}
