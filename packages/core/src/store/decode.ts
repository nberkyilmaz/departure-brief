import { decodeMetar, METAR_DECODER_VERSION } from '../decode/metar/index.js';
import { decodeTaf, TAF_DECODER_VERSION } from '../decode/taf/index.js';
import { decodeNotam, NOTAM_DECODER_VERSION } from '../notam/decode.js';
import { decodeSigmet, SIGMET_DECODER_VERSION } from '../decode/sigmet/decode.js';
import { decodeUpperWind, UPPERWIND_DECODER_VERSION } from '../decode/upperwind/decode.js';
import type { RawReport, ReportKind, ReportStore } from './types.js';

export interface IngestCounts {
  /** Reports the upstream returned. */
  readonly fetched: number;
  /** Reports whose content had not been seen before. */
  readonly rawInserted: number;
  /** Decoded rows written (a new report, or a known report under a newer decoder). */
  readonly decodedInserted: number;
}

/** The decoders this pipeline knows how to run, by report kind. */
const DECODERS: Partial<Record<ReportKind, { version: number; decode: (raw: string) => unknown }>> = {
  metar: { version: METAR_DECODER_VERSION, decode: decodeMetar },
  taf: { version: TAF_DECODER_VERSION, decode: decodeTaf },
  notam: { version: NOTAM_DECODER_VERSION, decode: decodeNotam },
  upperwind: { version: UPPERWIND_DECODER_VERSION, decode: decodeUpperWind },
  sigmet: { version: SIGMET_DECODER_VERSION, decode: decodeSigmet },
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
