import type { StoredBriefing } from '../brief/types.js';
import { airportPreference, type Airport } from '../domain/airport.js';
import { distanceNm } from '../domain/geo.js';
import type { AssessmentRow } from '../notam/assess.js';
import type { ForecastCheck, ForecastOutcome, VerificationPair } from '../verify/types.js';
import type { DecodedRow, FetchAttempt, FetchEvent, ListRawQuery, RawReport, ReportKind, Store } from './types.js';

/**
 * In-memory store with the same semantics as Postgres. For tests, the CLI's
 * `--memory` dry run, and any code that wants the pipeline without a database.
 */
export class MemoryStore implements Store {
  private readonly raw = new Map<string, RawReport>();
  private readonly fetches: { sha256: string; event: FetchEvent }[] = [];
  private readonly attempts: FetchAttempt[] = [];
  private readonly decoded = new Map<string, DecodedRow>();
  private readonly airports = new Map<string, Airport>();
  private readonly briefings = new Map<string, StoredBriefing>();
  private readonly firstSeen = new Map<string, Date>();
  private readonly assessments = new Map<string, AssessmentRow>();

  private readonly fetchedFor = new Map<string, Map<string, Date>>();

  async putRaw(report: RawReport, fetch: FetchEvent): Promise<{ inserted: boolean }> {
    this.fetches.push({ sha256: report.sha256, event: fetch });
    if (fetch.station) {
      const m = this.fetchedFor.get(report.sha256) ?? new Map<string, Date>();
      if (!m.has(fetch.station)) m.set(fetch.station, fetch.fetchedAt);
      this.fetchedFor.set(report.sha256, m);
    }
    if (this.raw.has(report.sha256)) return { inserted: false };
    this.raw.set(report.sha256, report);
    this.firstSeen.set(report.sha256, fetch.fetchedAt);
    return { inserted: true };
  }

  async getRaw(sha256: string): Promise<RawReport | null> {
    return this.raw.get(sha256) ?? null;
  }

  async listRaw(query: ListRawQuery): Promise<RawReport[]> {
    const limit = query.limit ?? 20;
    const knownBy = query.knownBy?.getTime() ?? Number.POSITIVE_INFINITY;
    const station = query.station ?? null;
    const seenBy = (sha: string) => (this.firstSeen.get(sha)?.getTime() ?? 0) <= knownBy;
    const fetchedForStation = (sha: string) => {
      if (station === null) return false;
      const at = this.fetchedFor.get(sha)?.get(station);
      return at !== undefined && at.getTime() <= knownBy;
    };
    return [...this.raw.values()]
      .filter((r) => r.kind === query.kind)
      // No station asked for means every report of this kind: a SIGMET
      // belongs to an area, not to an aerodrome.
      .filter((r) => (station === null ? seenBy(r.sha256) : (r.station === station && seenBy(r.sha256)) || fetchedForStation(r.sha256)))
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

  async countAirports(): Promise<number> {
    return this.airports.size;
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

  private readonly checks = new Map<string, ForecastCheck>();
  private readonly outcomes: ForecastOutcome[] = [];

  async putAssessment(row: AssessmentRow): Promise<{ inserted: boolean }> {
    const key = `${row.notamSha256}|${row.contextHash}|${row.promptVersion}|${row.model}`;
    if (this.assessments.has(key)) return { inserted: false };
    this.assessments.set(key, row);
    return { inserted: true };
  }

  async getAssessment(notamSha256: string, contextHash: string, promptVersion: number, model: string): Promise<AssessmentRow | null> {
    return this.assessments.get(`${notamSha256}|${contextHash}|${promptVersion}|${model}`) ?? null;
  }

  async putFetchAttempt(attempt: FetchAttempt): Promise<void> {
    this.attempts.push(attempt);
  }

  async lastFetchAt(station: string, kind: ReportKind): Promise<Date | null> {
    let latest: Date | null = null;
    for (const a of this.attempts) {
      if (a.kind !== kind || a.scope.toUpperCase() !== station) continue;
      if (latest === null || a.attemptedAt > latest) latest = a.attemptedAt;
    }
    for (const f of this.fetches) {
      const report = this.raw.get(f.sha256);
      if (!report || report.kind !== kind) continue;
      // The fetch counts for the station it was made for, and for the station it turned out to be about.
      if (f.event.station?.toUpperCase() !== station && report.station?.toUpperCase() !== station) continue;
      if (latest === null || f.event.fetchedAt > latest) latest = f.event.fetchedAt;
    }
    return latest;
  }

  async putForecastCheck(check: ForecastCheck): Promise<{ inserted: boolean }> {
    if (this.checks.has(check.key)) return { inserted: false };
    this.checks.set(check.key, check);
    return { inserted: true };
  }

  async listUnmatchedChecks(query: { station?: string | null; before: Date; limit?: number }): Promise<ForecastCheck[]> {
    const matched = new Set(this.outcomes.map((o) => o.checkKey));
    return [...this.checks.values()]
      .filter((c) => !matched.has(c.key) && c.validAt.getTime() <= query.before.getTime() && (!query.station || c.station === query.station))
      .sort((a, b) => b.validAt.getTime() - a.validAt.getTime())
      .slice(0, query.limit ?? 500);
  }

  async putForecastOutcome(outcome: ForecastOutcome): Promise<{ inserted: boolean }> {
    if (this.outcomes.some((o) => o.checkKey === outcome.checkKey && o.metarSha256 === outcome.metarSha256)) return { inserted: false };
    this.outcomes.push(outcome);
    return { inserted: true };
  }

  async listVerificationPairs(query: { station?: string | null; since?: Date | null; limit?: number }): Promise<VerificationPair[]> {
    const pairs: VerificationPair[] = [];
    for (const o of this.outcomes) {
      const check = this.checks.get(o.checkKey);
      if (!check) continue;
      if (query.station && check.station !== query.station) continue;
      if (query.since && check.validAt.getTime() < query.since.getTime()) continue;
      pairs.push({ check, outcome: o });
    }
    return pairs.sort((a, b) => b.check.validAt.getTime() - a.check.validAt.getTime()).slice(0, query.limit ?? 500);
  }

  async close(): Promise<void> {}

  /** Every fetch ever recorded, oldest first. Test and diagnostics only. */
  fetchLog(): readonly { sha256: string; event: FetchEvent }[] {
    return this.fetches;
  }
}
