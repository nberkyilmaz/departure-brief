import { decodeMetar, METAR_DECODER_VERSION } from '../decode/metar/index.js';
import { decodeTaf, TAF_DECODER_VERSION } from '../decode/taf/index.js';
import { decodeNotam, NOTAM_DECODER_VERSION } from '../notam/decode.js';
import type { RawReport, ReportKind, ReportStore } from '../store/types.js';
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
export async function ingestStation(deps: IngestDeps, station: string): Promise<IngestResult> {
  const now = (deps.now ?? (() => new Date()))();
  const metars = await deps.awc.metars([station]);
  const metar = await storeAndDecode(deps.store, metars.reports, metars.request, now);
  const tafs = await deps.awc.tafs([station]);
  const taf = await storeAndDecode(deps.store, tafs.reports, tafs.request, now);
  let notam: IngestCounts | null = null;
  if (deps.notam) {
    const fetched = await deps.notam.byLocation(station);
    notam = await storeAndDecode(deps.store, fetched.reports, fetched.requests.join(' '), now);
  }
  return { station: station.toUpperCase(), metar, taf, notam };
}
