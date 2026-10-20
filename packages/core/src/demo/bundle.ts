/**
 * The inputs a briefing is made from, packaged so they can be carried
 * somewhere with no database and no network.
 *
 * The published site is not a picture of a briefing: it holds the same
 * reports the pipeline would have fetched, and builds the briefing itself.
 * That is only possible if what a store holds can travel as JSON, which is
 * what this is — reports verbatim, the aerodromes they concern, and the
 * model's recorded answers about the NOTAMs.
 *
 * Nothing here is a summary of anything. A report's bytes are its bytes,
 * and the hash is recomputed on arrival to prove it.
 */
import type { Airport } from '../domain/airport.js';
import type { AssessmentRow } from '../notam/assess.js';
import { storeAndDecode } from '../store/decode.js';
import type { MemoryStore } from '../store/memory.js';
import { rawReport, type RawReport, type ReportKind } from '../store/types.js';

/** One report, with the sites it was fetched for — a FIR-wide NOTAM has several. */
export interface BundledReport {
  readonly sha256: string;
  readonly kind: ReportKind;
  readonly source: string;
  readonly station: string | null;
  readonly body: string;
  readonly issuedAt: string | null;
  /**
   * The service's own metadata record. Omitted from a published bundle: it
   * decides nothing, the page never shows it, and a report is named by the
   * hash of its body — so leaving it out changes no identity, only half a
   * megabyte of what a visitor downloads.
   */
  readonly upstream?: unknown;
  readonly fetchedFor: readonly string[];
  readonly request: string;
}

export interface DemoBundle {
  /** When these reports were recorded from the upstreams. */
  readonly recordedAt: string;
  /** The briefing instant: only what was known by then is used. */
  readonly asOf: string;
  /** Which model ranked the NOTAMs when this was recorded, if any. */
  readonly model: string | null;
  readonly promptVersion: number;
  readonly plan: unknown;
  readonly profile: unknown;
  readonly aircraft: unknown;
  readonly airports: readonly Airport[];
  readonly reports: readonly BundledReport[];
  readonly assessments: readonly AssessmentRow[];
}

export class BundleIntegrityError extends Error {
  constructor(report: BundledReport, actual: string) {
    super(`bundled ${report.kind} ${report.station ?? ''} says ${report.sha256.slice(0, 12)} but its bytes hash to ${actual.slice(0, 12)}`);
    this.name = 'BundleIntegrityError';
  }
}

/** Dates and the upstream record back out of JSON, unchanged. */
function reportOf(b: BundledReport): RawReport {
  return rawReport({
    kind: b.kind,
    source: b.source,
    station: b.station,
    body: b.body,
    issuedAt: b.issuedAt === null ? null : new Date(b.issuedAt),
    upstream: b.upstream ?? null,
  });
}

/**
 * Fill a store from a bundle, exactly as a fetch would have. Decoding runs
 * here too, so what comes out is a store the pipeline cannot tell from one
 * that fetched the same reports itself.
 *
 * Throws if a report's bytes do not hash to the name it arrived under: a
 * briefing built on reports that changed in transit is worth nothing.
 */
export async function loadBundle(store: MemoryStore, bundle: DemoBundle): Promise<{ reports: number; assessments: number }> {
  const recordedAt = new Date(bundle.recordedAt);
  await store.putAirports([...bundle.airports]);
  for (const b of bundle.reports) {
    const report = reportOf(b);
    if (report.sha256 !== b.sha256) throw new BundleIntegrityError(b, report.sha256);
    // One fetch event per site it was fetched for, which is how a FIR-wide
    // NOTAM ends up listed under every aerodrome it was returned for.
    for (const site of b.fetchedFor.length > 0 ? b.fetchedFor : [null]) {
      await storeAndDecode(store, [report], b.request, recordedAt, site);
    }
  }
  for (const row of bundle.assessments) {
    await store.putAssessment({ ...row, createdAt: new Date(row.createdAt) });
  }
  return { reports: bundle.reports.length, assessments: bundle.assessments.length };
}
