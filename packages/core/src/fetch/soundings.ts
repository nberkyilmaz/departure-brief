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
 *
 * Alaska's stations have no files, so theirs come from the NWS product API:
 * the same bulletin, as JSON, with the time it was issued.
 *
 * The same API holds every station's significant levels, which go into the
 * same report, after the mandatory ones and only when they are from the same
 * flight.
 */
import { soundingLocation, soundingStationsNear, type SoundingStation } from '../domain/soundings.js';
import type { LatLon } from '../domain/geo.js';
import { resolveDayTime } from '../domain/time.js';
import { storeAndDecode, type IngestCounts } from '../store/decode.js';
import { rawReport, type RawReport, type ReportStore } from '../store/types.js';
import { decideFetch, DEFAULT_FRESHNESS_MS, recordFetchAttempt, type FreshnessDecision, type FreshnessStore } from './freshness.js';
import { expectOk, type HttpClient } from './response.js';

export const NOAA_RAW_US_URL = 'https://tgftp.nws.noaa.gov/data/raw/us';
export const NWS_API_URL = 'https://api.weather.gov';

/** Marks a report as measured rather than forecast. */
export const SOUNDING_SOURCE = 'noaa-sounding';

/** How many stations to ask about for a route, nearest its points first. Two requests each, for its two bulletins. */
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
  /** The same balloon's significant levels, once the relay has asked for them. */
  readonly significant?: { readonly text: string };
}

/**
 * A file as one report, or `null` when it has no sounding in it. Until a
 * flight's significant levels arrive, the ones to hand are twelve hours
 * older than it, so they go in only if they say they are the same flight.
 */
export function soundingReport(text: string, modified: Date, significant?: string | null): RawReport | null {
  const mandatory = text.trim();
  const m = /\bTTAA\s+(\d{2})(\d{2})[\d/]\s+(\d{5})\b/.exec(mandatory);
  if (!m) return null;
  const coded = Number(m[1]);
  const issuedAt = resolveDayTime({ day: coded > 50 ? coded - 50 : coded, hour: Number(m[2]), minute: 0 }, modified);
  const sameFlight = significant && new RegExp(`\\bTTBB\\s+${m[1]}${m[2]}[\\d/]\\s+${m[3]}\\b`).test(significant);
  const body = sameFlight ? `${mandatory}\n\n${significant.trim()}` : mandatory;
  return rawReport({ kind: 'upperwind', source: SOUNDING_SOURCE, station: m[3]!, body, issuedAt, upstream: null });
}

export class SoundingClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = NOAA_RAW_US_URL,
    private readonly nwsUrl = NWS_API_URL,
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
      const report = soundingReport(held.text, held.modified ? new Date(held.modified) : now, held.significant?.text);
      if (report) reports.push(report);
    }
    return { request: url, reports };
  }

  /** One station's file, straight from NOAA. */
  async file(name: string, now: Date = new Date(), significant?: string | null): Promise<SoundingFetch> {
    const url = `${this.baseUrl}/${name}.txt`;
    const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'text/plain' } }));
    const modified = res.headers['last-modified'];
    const report = soundingReport(res.body, modified ? new Date(modified) : now, significant);
    return { request: url, reports: report ? [report] : [] };
  }

  /** One Alaskan station's latest bulletin, from the NWS product API. */
  async latestProduct(location: string, now: Date = new Date(), significant?: string | null): Promise<SoundingFetch> {
    const url = `${this.nwsUrl}/products/types/MAN/locations/${location}/latest`;
    const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'application/ld+json' } }));
    let product: { productText?: unknown; issuanceTime?: unknown };
    try {
      product = JSON.parse(res.body) as typeof product;
    } catch {
      throw new SoundingError('the NWS API did not send JSON', url);
    }
    if (typeof product.productText !== 'string') throw new SoundingError('the NWS API sent no bulletin', url);
    const report = soundingReport(product.productText, typeof product.issuanceTime === 'string' ? new Date(product.issuanceTime) : now, significant);
    return { request: url, reports: report ? [report] : [] };
  }

  /** One station's significant levels, or `null`: a sounding is still a sounding without them. */
  async significantLevels(location: string): Promise<string | null> {
    const url = `${this.nwsUrl}/products/types/SGL/locations/${location}/latest`;
    try {
      const res = await this.http.get(url, { headers: { Accept: 'application/ld+json' } });
      if (res.status !== 200) return null;
      const { productText } = JSON.parse(res.body) as { productText?: unknown };
      return typeof productText === 'string' ? productText : null;
    } catch {
      return null;
    }
  }

  /** A station's sounding from wherever NOAA publishes it, with its significant levels if they are there yet. */
  async station(station: SoundingStation, now: Date = new Date()): Promise<SoundingFetch> {
    const significant = await this.significantLevels(soundingLocation(station));
    return station.file ? this.file(station.file, now, significant) : this.latestProduct(station.nwsLocation!, now, significant);
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
  const wanted = new Map<string, SoundingStation>();
  for (const position of positions) {
    for (const { station } of soundingStationsNear(position, radiusNm).slice(0, SOUNDINGS_PER_POINT)) {
      if (wanted.size < MAX_SOUNDING_SITES) wanted.set(station.id, station);
    }
  }
  const skipped: FreshnessDecision[] = [];
  const sites: string[] = [];
  let counts: IngestCounts = { fetched: 0, rawInserted: 0, decodedInserted: 0 };
  for (const [id, station] of wanted) {
    const decision = await decideFetch(deps.store, id, 'upperwind', now, maxAgeMs);
    if (!decision.fetched) {
      skipped.push(decision);
      continue;
    }
    const fetched = await deps.soundings.station(station, now);
    await recordFetchAttempt(deps.store, id, 'upperwind', now, fetched.request);
    const c = await storeAndDecode(deps.store, fetched.reports, fetched.request, now);
    counts = { fetched: counts.fetched + c.fetched, rawInserted: counts.rawInserted + c.rawInserted, decodedInserted: counts.decodedInserted + c.decodedInserted };
    sites.push(id);
  }
  return { sites, counts, skipped };
}
