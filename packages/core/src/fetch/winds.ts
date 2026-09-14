/**
 * Getting upper winds for a flight, which is not the same as getting them
 * for its aerodromes.
 *
 * Upper winds are published for a few dozen places across the country, and
 * a small aerodrome is almost never one of them: asking CYSN returns
 * nothing at all. What a flight from CYSN needs is Toronto's column, and
 * the way to find it is to ask about the big fields near the route.
 *
 * Long runways are the proxy used here. The sites that publish upper winds
 * are the major ones, and runway length is the one measure of "major" the
 * airport data already carries — no separate list to fall out of date, and
 * a wrong guess costs nothing but an empty answer.
 */
import type { Airport } from '../domain/airport.js';
import type { LatLon } from '../domain/geo.js';
import { UPPERWIND_RADIUS_NM } from '../resolve/wind.js';
import { storeAndDecode, type IngestCounts } from '../store/decode.js';
import type { AirportStore, ReportStore } from '../store/types.js';
import { decideFetch, DEFAULT_FRESHNESS_MS, type FreshnessDecision, type FreshnessStore } from './freshness.js';
import type { NavCanadaClient } from './navcanada.js';

/** How many candidate sites to ask about. They go in one request, so this is not a request count. */
export const MAX_UPPERWIND_SITES = 6;

/** Below this, a field is not going to be an upper wind site. */
const MAJOR_RUNWAY_FT = 5000;

const longestRunwayFt = (a: Airport): number => Math.max(0, ...a.runways.map((r) => r.length ?? 0));

/**
 * The aerodromes worth asking about for a route: the major fields within
 * reach of any of its points, biggest first, deduplicated.
 */
export async function upperWindCandidates(store: AirportStore, positions: readonly LatLon[], radiusNm = UPPERWIND_RADIUS_NM): Promise<string[]> {
  const seen = new Map<string, Airport>();
  for (const position of positions) {
    for (const airport of await store.listAirportsNear(position.lat, position.lon, radiusNm)) {
      if (airport.icaoId && longestRunwayFt(airport) >= MAJOR_RUNWAY_FT) seen.set(airport.icaoId, airport);
    }
  }
  return [...seen.values()]
    .sort((a, b) => longestRunwayFt(b) - longestRunwayFt(a))
    .slice(0, MAX_UPPERWIND_SITES)
    .map((a) => a.icaoId!);
}

export interface UpperWindIngest {
  readonly sites: readonly string[];
  readonly counts: IngestCounts;
  /** Sites not asked about because what is stored is recent enough. */
  readonly skipped: readonly FreshnessDecision[];
}

/**
 * Fetch and store upper winds for a route, unless they were fetched
 * recently enough. One request covers every candidate site; the service
 * answers for whichever of them it publishes, and a site it does not
 * publish costs nothing.
 */
export async function ingestUpperWinds(
  deps: { store: ReportStore & AirportStore & FreshnessStore; navcanada: NavCanadaClient; now?: () => Date },
  positions: readonly LatLon[],
  maxAgeMs: number = DEFAULT_FRESHNESS_MS.upperwind,
): Promise<UpperWindIngest> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await upperWindCandidates(deps.store, positions);
  const skipped: FreshnessDecision[] = [];
  const wanted: string[] = [];
  for (const site of candidates) {
    const decision = await decideFetch(deps.store, site, 'upperwind', now, maxAgeMs);
    if (decision.fetched) wanted.push(site);
    else skipped.push(decision);
  }
  if (wanted.length === 0) return { sites: [], counts: { fetched: 0, rawInserted: 0, decodedInserted: 0 }, skipped };

  const fetched = await deps.navcanada.upperWinds(wanted);
  /*
   * Each record is stored against the site it belongs to. A site that
   * published nothing leaves no trace, so it counts as never fetched and
   * will be asked about again — but since every candidate travels in one
   * request, that costs nothing beyond the request already being made.
   */
  let counts: IngestCounts = { fetched: fetched.reports.length, rawInserted: 0, decodedInserted: 0 };
  for (const site of wanted) {
    const mine = fetched.reports.filter((r) => r.station === site);
    const c = await storeAndDecode(deps.store, mine, fetched.request, now, site);
    counts = { fetched: counts.fetched, rawInserted: counts.rawInserted + c.rawInserted, decodedInserted: counts.decodedInserted + c.decodedInserted };
  }
  return { sites: wanted, counts, skipped };
}
