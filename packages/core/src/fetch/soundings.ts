/**
 * Getting balloon soundings: NOAA's one file per station, overwritten each
 * time that station's balloon reports.
 *
 * NOAA sends no header that would let a page read them, so a page gets them
 * from the relay, which holds all of them in one answer. A server fetches
 * the few it needs itself. Either way each file becomes one report, under
 * the station's WMO number.
 *
 * The bulletin gives only a day of the month. `Last-Modified` says when NOAA
 * wrote the file, which is what dates it, and it stays right for a station
 * that has not flown for weeks and whose file has simply been left there.
 */
import { soundingStationsNear } from '../domain/soundings.js';
import type { LatLon } from '../domain/geo.js';
import { resolveDayTime } from '../domain/time.js';
import { storeAndDecode, type IngestCounts } from '../store/decode.js';
import { rawReport, type RawReport, type ReportStore } from '../store/types.js';
import { decideFetch, DEFAULT_FRESHNESS_MS, recordFetchAttempt, type FreshnessDecision, type FreshnessStore } from './freshness.js';
import { expectOk, type HttpClient } from './response.js';

export const NOAA_RAW_US_URL = 'https://tgftp.nws.noaa.gov/data/raw/us';

/** Marks a report as measured rather than forecast. */
export const SOUNDING_SOURCE = 'noaa-sounding';

/** How many stations to ask about for a route, nearest its points first. One request each. */
export const MAX_SOUNDING_SITES = 6;
/** How many of the nearest stations each point asks for, so one that did not fly has a neighbour. */
const SOUNDINGS_PER_POINT = 2;

export class SoundingError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'SoundingError';
  }
}

export interface SoundingFetch {
  readonly request: string;
  readonly reports: readonly RawReport[];
}

/** One file as the relay holds it. */
export interface HeldSounding {
  /** When NOAA wrote it; null if NOAA did not say. */
  readonly modified: string | null;
  readonly text: string;
}

/** A file as one report, or `null` when it has no sounding in it. */
export function soundingReport(text: string, modified: Date): RawReport | null {
  const body = text.trim();
  const m = /\bTTAA\s+(\d{2})(\d{2})[\d/]\s+(\d{5})\b/.exec(body);
  if (!m) return null;
  const coded = Number(m[1]);
  const issuedAt = resolveDayTime({ day: coded > 50 ? coded - 50 : coded, hour: Number(m[2]), minute: 0 }, modified);
  return rawReport({ kind: 'upperwind', source: SOUNDING_SOURCE, station: m[3]!, body, issuedAt, upstream: null });
}

export class SoundingClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = NOAA_RAW_US_URL,
  ) {}

  /** Every station at once, from the relay: `baseUrl` is the relay's route for them. */
  async relayed(now: Date = new Date()): Promise<SoundingFetch> {
    const url = this.baseUrl;
    const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'application/json' } }));
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new SoundingError('the relay did not send JSON', url);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SoundingError('the relay did not send the soundings', url);
    const reports: RawReport[] = [];
    for (const held of Object.values(parsed as Record<string, Partial<HeldSounding>>)) {
      if (typeof held?.text !== 'string') continue;
      const report = soundingReport(held.text, held.modified ? new Date(held.modified) : now);
      if (report) reports.push(report);
    }
    return { request: url, reports };
  }

  /** One station's file, straight from NOAA. */
  async file(name: string, now: Date = new Date()): Promise<SoundingFetch> {
    const url = `${this.baseUrl}/${name}.txt`;
    const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'text/plain' } }));
    const modified = res.headers['last-modified'];
    const report = soundingReport(res.body, modified ? new Date(modified) : now);
    return { request: url, reports: report ? [report] : [] };
  }
}

export interface SoundingIngest {
  readonly sites: readonly string[];
  readonly counts: IngestCounts;
  readonly skipped: readonly FreshnessDecision[];
}

/** Fetch and store the soundings a route will read, unless they were fetched recently enough. */
export async function ingestSoundings(
  deps: { store: ReportStore & FreshnessStore; soundings: SoundingClient; now?: () => Date },
  positions: readonly LatLon[],
  radiusNm: number,
  maxAgeMs: number = DEFAULT_FRESHNESS_MS.upperwind,
): Promise<SoundingIngest> {
  const now = (deps.now ?? (() => new Date()))();
  const wanted = new Map<string, string>();
  for (const position of positions) {
    for (const { station } of soundingStationsNear(position, radiusNm).slice(0, SOUNDINGS_PER_POINT)) {
      if (wanted.size < MAX_SOUNDING_SITES) wanted.set(station.id, station.file);
    }
  }
  const skipped: FreshnessDecision[] = [];
  const sites: string[] = [];
  let counts: IngestCounts = { fetched: 0, rawInserted: 0, decodedInserted: 0 };
  for (const [id, file] of wanted) {
    const decision = await decideFetch(deps.store, id, 'upperwind', now, maxAgeMs);
    if (!decision.fetched) {
      skipped.push(decision);
      continue;
    }
    const fetched = await deps.soundings.file(file, now);
    await recordFetchAttempt(deps.store, id, 'upperwind', now, fetched.request);
    const c = await storeAndDecode(deps.store, fetched.reports, fetched.request, now);
    counts = { fetched: counts.fetched + c.fetched, rawInserted: counts.rawInserted + c.rawInserted, decodedInserted: counts.decodedInserted + c.decodedInserted };
    sites.push(id);
  }
  return { sites, counts, skipped };
}
