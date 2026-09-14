import { sha256Hex } from '../hash/sha256.js';
import type { StoredBriefing } from '../brief/types.js';
import type { Airport } from '../domain/airport.js';
import type { AssessmentStore } from '../notam/assess.js';

export type { AssessmentStore };

export type ReportKind = 'metar' | 'taf' | 'notam';

/**
 * One upstream report, stored verbatim. Content-addressed: `sha256` is the
 * hash of `body`'s UTF-8 bytes, so the same report fetched twice is one row,
 * and a row can never be changed without changing its key.
 */
export interface RawReport {
  readonly sha256: string;
  readonly kind: ReportKind;
  /** Which upstream it came from: `awc`, `faa-notam`. */
  readonly source: string;
  /** ICAO identifier when the report is about one station. */
  readonly station: string | null;
  /** The report text exactly as the upstream gave it. */
  readonly body: string;
  /** When the upstream says it was issued/observed. Zulu. */
  readonly issuedAt: Date | null;
  /** The upstream's own metadata record, verbatim; never used for decisions. */
  readonly upstream: unknown;
}

/** One occasion on which a report was fetched. Recorded even when the content was already known. */
export interface FetchEvent {
  readonly fetchedAt: Date;
  /** The request that produced it, normally the URL. */
  readonly request: string;
  /**
   * The station the fetch was *for*, when a report is not about one station
   * of its own — a FIR-wide NOTAM returned for CYKF is listed under CYKF
   * through this, whichever site first stored it. `null` for reports that
   * carry their own station.
   */
  readonly station: string | null;
}

export interface DecodedRow {
  readonly sha256: string;
  readonly kind: ReportKind;
  readonly decoderVersion: number;
  readonly decoded: unknown;
  readonly decodedAt: Date;
}

export interface ListRawQuery {
  /** Matches the report's own station, or any fetch that was for this station. */
  readonly station: string;
  readonly kind: ReportKind;
  /** Newest issued first; defaults to 20. */
  readonly limit?: number;
  /** Only reports first fetched at or before this instant — "what was known then". */
  readonly knownBy?: Date;
}

/**
 * Append-only storage for raw and decoded reports. Implementations never
 * update or delete; `put*` return whether a new row was written.
 */
import type { ForecastStore } from '../verify/types.js';

export interface ReportStore {
  putRaw(report: RawReport, fetch: FetchEvent): Promise<{ inserted: boolean }>;
  getRaw(sha256: string): Promise<RawReport | null>;
  listRaw(query: ListRawQuery): Promise<RawReport[]>;
  putDecoded(row: DecodedRow): Promise<{ inserted: boolean }>;
  getDecoded(sha256: string, decoderVersion: number): Promise<DecodedRow | null>;
  /**
   * When this station's reports of this kind were last asked for upstream,
   * whether or not anything new came back. Serving strangers, this is what
   * keeps a second visitor — or one impatient one — from sending another
   * round of requests for reports that have not changed.
   */
  lastFetchAt(station: string, kind: ReportKind): Promise<Date | null>;
  close(): Promise<void>;
}

/**
 * NASR airports by cycle. Loading a cycle already present is a no-op; a
 * lookup returns the airport from the newest loaded cycle.
 */
export interface AirportStore {
  putAirports(airports: readonly Airport[], loadedAt: Date): Promise<{ inserted: number }>;
  /** By ICAO id (`KJFK`) or FAA id (`JFK`, `N07`), case-insensitive. */
  getAirport(id: string): Promise<Airport | null>;
  /** Airports (newest cycle each) within a great-circle radius, nearest first. */
  listAirportsNear(lat: number, lon: number, radiusNm: number): Promise<Airport[]>;
}

/** Briefings are immutable and content-addressed; `put` of a known hash is a no-op. */
export interface BriefingStore {
  putBriefing(briefing: StoredBriefing): Promise<{ inserted: boolean }>;
  getBriefing(sha256: string): Promise<StoredBriefing | null>;
  /** Briefings of one flight, newest `asOf` first. */
  listBriefings(flightKey: string, limit?: number): Promise<StoredBriefing[]>;
}

export type Store = ReportStore & AirportStore & BriefingStore & AssessmentStore & ForecastStore;

/** Re-exported so the identity of a report and of a briefing are the same function. */
export { sha256Hex };

export function rawReport(fields: Omit<RawReport, 'sha256'>): RawReport {
  return { ...fields, sha256: sha256Hex(fields.body) };
}
