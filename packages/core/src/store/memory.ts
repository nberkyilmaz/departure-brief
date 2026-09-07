import type { StoredBriefing } from '../brief/types.js';
import { airportPreference, type Airport } from '../domain/airport.js';
import { distanceNm } from '../domain/geo.js';
import type { DecodedRow, FetchEvent, ListRawQuery, RawReport, Store } from './types.js';

/**
 * In-memory store with the same semantics as Postgres. For tests, the CLI's
 * `--memory` dry run, and any code that wants the pipeline without a database.
 */
export class MemoryStore implements Store {
  private readonly raw = new Map<string, RawReport>();
  private readonly fetches: { sha256: string; event: FetchEvent }[] = [];
  private readonly decoded = new Map<string, DecodedRow>();
  private readonly airports = new Map<string, Airport>();
  private readonly briefings = new Map<string, StoredBriefing>();

  async putRaw(report: RawReport, fetch: FetchEvent): Promise<{ inserted: boolean }> {
    this.fetches.push({ sha256: report.sha256, event: fetch });
    if (this.raw.has(report.sha256)) return { inserted: false };
    this.raw.set(report.sha256, report);
    return { inserted: true };
  }

  async getRaw(sha256: string): Promise<RawReport | null> {
    return this.raw.get(sha256) ?? null;
  }

  async listRaw(query: ListRawQuery): Promise<RawReport[]> {
    const limit = query.limit ?? 20;
    return [...this.raw.values()]
      .filter((r) => r.station === query.station && r.kind === query.kind)
      .sort((a, b) => (b.issuedAt?.getTime() ?? 0) - (a.issuedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async putDecoded(row: DecodedRow): Promise<{ inserted: boolean }> {
    const key = `${row.sha256}:${row.decoderVersion}`;
    if (this.decoded.has(key)) return { inserted: false };
    this.decoded.set(key, row);
    return { inserted: true };
  }

  async getDecoded(sha256: string, decoderVersion: number): Promise<DecodedRow | null> {
    return this.decoded.get(`${sha256}:${decoderVersion}`) ?? null;
  }

  async putAirports(airports: readonly Airport[]): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const a of airports) {
      const key = `${a.source}|${a.cycle}|${a.siteNo}|${a.siteType}`;
      if (this.airports.has(key)) continue;
      this.airports.set(key, a);
      inserted++;
    }
    return { inserted };
  }

  async getAirport(id: string): Promise<Airport | null> {
    const wanted = id.trim().toUpperCase();
    let best: Airport | null = null;
    const rank = airportPreference;
    for (const a of this.airports.values()) {
      if (a.icaoId?.toUpperCase() !== wanted && a.faaId.toUpperCase() !== wanted) continue;
      if (!best || rank(a) > rank(best) || (rank(a) === rank(best) && a.cycle > best.cycle)) best = a;
    }
    return best;
  }

  async listAirportsNear(lat: number, lon: number, radiusNm: number): Promise<Airport[]> {
    const newest = new Map<string, Airport>();
    for (const a of this.airports.values()) {
      const key = `${a.source}|${a.siteNo}|${a.siteType}`;
      const cur = newest.get(key);
      if (!cur || a.cycle > cur.cycle) newest.set(key, a);
    }
    const here = { lat, lon };
    return [...newest.values()]
      .map((a) => ({ a, d: distanceNm(here, a) }))
      .filter((x) => x.d <= radiusNm)
      .sort((x, y) => x.d - y.d)
      .map((x) => x.a);
  }

  async putBriefing(briefing: StoredBriefing): Promise<{ inserted: boolean }> {
    if (this.briefings.has(briefing.sha256)) return { inserted: false };
    this.briefings.set(briefing.sha256, briefing);
    return { inserted: true };
  }

  async getBriefing(sha256: string): Promise<StoredBriefing | null> {
    return this.briefings.get(sha256) ?? null;
  }

  async listBriefings(flightKey: string, limit = 20): Promise<StoredBriefing[]> {
    return [...this.briefings.values()]
      .filter((b) => b.flightKey === flightKey)
      .sort((a, b) => b.asOf.getTime() - a.asOf.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async close(): Promise<void> {}

  /** Every fetch ever recorded, oldest first. Test and diagnostics only. */
  fetchLog(): readonly { sha256: string; event: FetchEvent }[] {
    return this.fetches;
  }
}
