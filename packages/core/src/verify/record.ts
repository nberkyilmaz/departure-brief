/**
 * Turning a resolved flight into predictions worth checking later, and
 * matching an observation to one once its moment has passed.
 */
import { contentHash } from '../brief/canonical.js';
import type { Conditions } from '../decode/conditions.js';
import { ceilingOf, flightCategoryOf, visibilityStatuteMiles, windKnots, type FlightCategory } from '../decode/metar/derive.js';
import { decodeMetar, METAR_DECODER_VERSION, type DecodedMetar } from '../decode/metar/index.js';
import { TAF_DECODER_VERSION } from '../decode/taf/index.js';
import type { FeetAgl, StatuteMiles } from '../domain/units.js';
import type { ResolvedFlight, ResolvedPoint } from '../resolve/flight.js';
import type { Store } from '../store/types.js';
import type { ForecastCheck, ForecastOutcome } from './types.js';

/**
 * Is this visibility an open-ended bound rather than a measurement?
 * `P6SM`, `CAVOK` and `9999` all say "at least this", and a TAF in good
 * weather says almost nothing else. Scoring `P6SM` as exactly six against
 * an observed ten would call every such forecast pessimistic, which would
 * be an artefact of the arithmetic rather than anything about the weather.
 */
export function visibilityIsAtLeast(v: Conditions['visibility']): boolean {
  if (!v) return false;
  const x = v.value;
  if (x.kind === 'cavok') return true;
  if (x.kind === 'meters') return x.meters >= 9999;
  return x.kind === 'statute' && x.qualifier === 'greaterThan';
}

/** Ceiling, visibility, wind and category from any set of conditions, forecast or observed. */
export function measure(c: Conditions): Pick<ForecastCheck, 'ceilingFt' | 'visibilitySm' | 'visibilityAtLeast' | 'windDirTrue' | 'windKt' | 'gustKt' | 'category'> {
  const ceiling = ceilingOf(c.sky)?.value ?? null;
  const vis = c.visibility ? visibilityStatuteMiles(c.visibility.value) : null;
  const wind = c.wind ? windKnots(c.wind.value) : null;
  // A variable or unreported direction is not a number, and recording it as one would make a bias out of nothing.
  const d = c.wind?.value.direction ?? null;
  const direction = typeof d === 'number' ? d : null;
  return {
    ceilingFt: ceiling === null ? null : Math.round(ceiling),
    visibilitySm: vis === null ? null : Math.round(vis * 100) / 100,
    visibilityAtLeast: visibilityIsAtLeast(c.visibility),
    windDirTrue: direction,
    windKt: wind?.speed ?? null,
    gustKt: wind?.gust ?? null,
    category: flightCategoryOf(ceiling as FeetAgl | null, vis as StatuteMiles | null),
  };
}

const WORSE: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

/** The worse of two categories, treating the unknown as no information. */
export function worseCategory(a: FlightCategory | null, b: FlightCategory | null): FlightCategory | null {
  if (a === null) return b;
  if (b === null) return a;
  return WORSE[a] >= WORSE[b] ? a : b;
}

export function checkKeyOf(station: string, validAt: Date, tafSha256: string, decoderVersion: number): string {
  return contentHash({ station, validAt: validAt.toISOString(), tafSha256, decoderVersion });
}

/**
 * One prediction per waypoint that had a forecast, recording what the
 * prevailing forecast asserted for that waypoint's ETA. Overlays are noted
 * but not scored as the forecast: a TAF asserts its prevailing conditions
 * and offers overlays as possibilities.
 */
export function checksFrom(flight: ResolvedFlight, createdAt: Date = new Date()): ForecastCheck[] {
  const points: ResolvedPoint[] = [...flight.points, ...(flight.alternate ? [flight.alternate] : [])];
  const out = new Map<string, ForecastCheck>();
  for (const p of points) {
    const f = p.forecast;
    if (!f || !f.resolved.prevailing) continue;
    const validAt = p.point.eta;
    const key = checkKeyOf(f.station, validAt, f.report.sha256, TAF_DECODER_VERSION);
    if (out.has(key)) continue;
    const issued = f.report.issuedAt ?? f.resolved.issued ?? null;
    let overlayWorst: FlightCategory | null = null;
    for (const o of f.resolved.overlays) overlayWorst = worseCategory(overlayWorst, measure(o.conditions).category);
    out.set(key, {
      key,
      station: f.station,
      validAt,
      tafSha256: f.report.sha256,
      tafIssuedAt: issued,
      tafDecoderVersion: TAF_DECODER_VERSION,
      leadHours: issued ? Math.round(((validAt.getTime() - issued.getTime()) / 3_600_000) * 10) / 10 : null,
      ...measure(f.resolved.prevailing.conditions),
      overlayWorstCategory: overlayWorst,
      createdAt,
    });
  }
  return [...out.values()];
}

/** How far from the forecast moment an observation may sit and still be its outcome. */
export const MATCH_WINDOW_MINUTES = 35;

/**
 * The observation closest to a check's moment, from what the store already
 * holds. Returns null when nothing lands close enough — which is the normal
 * case for a station that reports hourly and a moment just after the hour,
 * and for one that has not reported yet.
 */
export async function matchOutcome(store: Store, check: ForecastCheck, matchedAt: Date = new Date()): Promise<ForecastOutcome | null> {
  const reports = await store.listRaw({ station: check.station, kind: 'metar', limit: 200 });
  let best: { report: (typeof reports)[number]; minutes: number } | null = null;
  for (const r of reports) {
    if (r.issuedAt === null) continue;
    const minutes = Math.round((r.issuedAt.getTime() - check.validAt.getTime()) / 60_000);
    if (Math.abs(minutes) > MATCH_WINDOW_MINUTES) continue;
    if (best === null || Math.abs(minutes) < Math.abs(best.minutes)) best = { report: r, minutes };
  }
  if (!best) return null;
  const stored = await store.getDecoded(best.report.sha256, METAR_DECODER_VERSION);
  const decoded = stored ? (stored.decoded as DecodedMetar) : decodeMetar(best.report.body);
  return {
    checkKey: check.key,
    metarSha256: best.report.sha256,
    observedAt: best.report.issuedAt!,
    offsetMinutes: best.minutes,
    ...measure({ ...EMPTY, wind: decoded.wind, visibility: decoded.visibility, sky: decoded.sky }),
    matchedAt,
  };
}

/** The conditions shape, with only the fields a measurement reads filled in by the caller. */
const EMPTY = {
  wind: null,
  visibility: null,
  weather: [],
  noSignificantWeather: null,
  sky: [],
  windShear: null,
  icing: [],
  turbulence: [],
  altimeter: null,
} satisfies Conditions;
