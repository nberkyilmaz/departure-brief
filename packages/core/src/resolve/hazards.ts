/**
 * The hazard advisories in force, out of everything the store holds.
 *
 * Unlike a forecast, these are not looked up by station: a SIGMET belongs
 * to an area, and which flights it concerns is a question of geometry. So
 * everything known by the briefing instant is gathered here, and the rules
 * decide what is about this flight.
 */
import { decodeSigmet, SIGMET_DECODER_VERSION } from '../decode/sigmet/decode.js';
import type { DecodedSigmet } from '../decode/sigmet/types.js';
import type { RawReport, Store } from '../store/types.js';

/** How many to consider. The world carries a few hundred at once. */
export const MAX_ADVISORIES = 500;

export interface HazardAdvisory {
  readonly report: RawReport;
  readonly decoded: DecodedSigmet;
}

/**
 * Every advisory known by `asOf`, decoded. Ones whose validity has clearly
 * passed are dropped here rather than carried into every point's checks —
 * the store keeps them, because it keeps everything, but a briefing has no
 * use for last week's turbulence.
 */
export async function hazardsKnownBy(store: Store, asOf: Date, until: Date): Promise<HazardAdvisory[]> {
  const reports = await store.listRaw({ kind: 'sigmet', limit: MAX_ADVISORIES, knownBy: asOf });
  const out: HazardAdvisory[] = [];
  for (const report of reports) {
    const stored = await store.getDecoded(report.sha256, SIGMET_DECODER_VERSION);
    const decoded = stored ? (stored.decoded as DecodedSigmet) : decodeSigmet(report.body);
    if (decoded.validTo && decoded.validTo.getTime() < asOf.getTime() && decoded.validTo.getTime() < until.getTime()) continue;
    out.push({ report, decoded });
  }
  return out;
}
