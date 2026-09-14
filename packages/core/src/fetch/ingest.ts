import { storeAndDecode, type IngestCounts } from '../store/decode.js';
import type { ReportKind, ReportStore } from '../store/types.js';
import { decideFetch, DEFAULT_FRESHNESS_MS, type FreshnessDecision } from './freshness.js';
import type { AwcClient } from './awc.js';
import type { FaaNotamClient } from './notam.js';

export interface IngestDeps {
  readonly store: ReportStore;
  readonly awc: AwcClient;
  /** Optional until credentials exist. */
  readonly notam?: FaaNotamClient | null;
  readonly now?: () => Date;
}

export interface IngestResult {
  readonly station: string;
  readonly metar: IngestCounts;
  readonly taf: IngestCounts;
  readonly notam: IngestCounts | null;
  /** Kinds not asked for upstream because what is stored is recent enough, each with why. */
  readonly skipped: readonly FreshnessDecision[];
}

export interface IngestOptions {
  /** Override how old a stored report may be before it is refetched. Zero forces a fetch. */
  readonly maxAge?: Partial<Record<ReportKind, number>>;
}

/** Fetch, store and decode everything we can about one station. */
/**
 * Fetch a station's reports, unless they were fetched recently enough that
 * asking again would only cost someone else bandwidth. Pass `maxAge` to
 * change the windows, or zero for a kind to force it.
 */
export async function ingestStation(deps: IngestDeps, station: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const now = (deps.now ?? (() => new Date()))();
  const age = (kind: ReportKind) => opts.maxAge?.[kind] ?? DEFAULT_FRESHNESS_MS[kind];
  const skipped: FreshnessDecision[] = [];
  const nothing: IngestCounts = { fetched: 0, rawInserted: 0, decodedInserted: 0 };

  const metarDecision = await decideFetch(deps.store, station, 'metar', now, age('metar'));
  let metar = nothing;
  if (metarDecision.fetched) {
    const metars = await deps.awc.metars([station]);
    metar = await storeAndDecode(deps.store, metars.reports, metars.request, now);
  } else skipped.push(metarDecision);

  const tafDecision = await decideFetch(deps.store, station, 'taf', now, age('taf'));
  let taf = nothing;
  if (tafDecision.fetched) {
    const tafs = await deps.awc.tafs([station]);
    taf = await storeAndDecode(deps.store, tafs.reports, tafs.request, now);
  } else skipped.push(tafDecision);

  let notam: IngestCounts | null = null;
  if (deps.notam) {
    const d = await decideFetch(deps.store, station, 'notam', now, age('notam'));
    if (d.fetched) {
      const fetched = await deps.notam.byLocation(station);
      notam = await storeAndDecode(deps.store, fetched.reports, fetched.requests.join(' '), now);
    } else {
      notam = nothing;
      skipped.push(d);
    }
  }
  return { station: station.toUpperCase(), metar, taf, notam, skipped };
}
