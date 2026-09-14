import { decodeMetar, METAR_DECODER_VERSION } from '../decode/metar/index.js';
import { decodeTaf, TAF_DECODER_VERSION } from '../decode/taf/index.js';
import { decodeNotam, NOTAM_DECODER_VERSION } from '../notam/decode.js';
import type { RawReport, ReportKind, ReportStore } from '../store/types.js';
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

export interface IngestCounts {
  /** Reports the upstream returned. */
  readonly fetched: number;
  /** Reports whose content had not been seen before. */
  readonly rawInserted: number;
  /** Decoded rows written (a new report, or a known report under a newer decoder). */
  readonly decodedInserted: number;
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

/** The decoders this pipeline knows how to run, by report kind. */
const DECODERS: Partial<Record<ReportKind, { version: number; decode: (raw: string) => unknown }>> = {
  metar: { version: METAR_DECODER_VERSION, decode: decodeMetar },
  taf: { version: TAF_DECODER_VERSION, decode: decodeTaf },
  notam: { version: NOTAM_DECODER_VERSION, decode: decodeNotam },
};

/**
 * Store a batch of raw reports and decode each one whose decoding is not
 * already stored at the current decoder version. Decoding is deterministic,
 * so a report is decoded once per decoder version, ever.
 */
export async function storeAndDecode(
  store: ReportStore,
  reports: readonly RawReport[],
  request: string,
  now: Date,
  /** The station the fetch was for, when the reports are not each about one station (NOTAMs). */
  fetchedFor: string | null = null,
): Promise<IngestCounts> {
  let rawInserted = 0;
  let decodedInserted = 0;
  for (const report of reports) {
    const put = await store.putRaw(report, { fetchedAt: now, request, station: fetchedFor });
    if (put.inserted) rawInserted++;
    const decoder = DECODERS[report.kind];
    if (!decoder) continue;
    if (!put.inserted && (await store.getDecoded(report.sha256, decoder.version))) continue;
    const res = await store.putDecoded({
      sha256: report.sha256,
      kind: report.kind,
      decoderVersion: decoder.version,
      decoded: decoder.decode(report.body),
      decodedAt: now,
    });
    if (res.inserted) decodedInserted++;
  }
  return { fetched: reports.length, rawInserted, decodedInserted };
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
