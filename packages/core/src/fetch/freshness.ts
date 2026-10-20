/**
 * How old a stored report may be before it is worth asking upstream again.
 *
 * On a laptop this only saves time. On a public site it is the difference
 * between courteous and abusive: without it, every visitor who briefs the
 * same flight — or one visitor who clicks twice — sends another round of
 * requests to the weather service and to NAV CANADA. The reports barely
 * change between those clicks, so the second round buys nothing and costs
 * someone else's bandwidth.
 *
 * The windows are set by how often each product is actually issued. A METAR
 * comes hourly with specials in between, so ten minutes is generous. A TAF
 * is issued four times a day, a NOTAM changes when it changes, and upper
 * winds come three times a day.
 */
import type { FetchAttempt, ReportKind } from '../store/types.js';

export const DEFAULT_FRESHNESS_MS: Readonly<Record<ReportKind, number>> = {
  metar: 10 * 60_000,
  taf: 30 * 60_000,
  notam: 30 * 60_000,
  // Three bulletins a day, so asking more than hourly buys nothing at all.
  upperwind: 60 * 60_000,
  // A hazard advisory can be issued at any moment, and is the one product
  // where being a quarter of an hour behind actually matters.
  sigmet: 15 * 60_000,
};

export interface FreshnessStore {
  /** When this station's reports of this kind were last fetched, whatever came back. */
  lastFetchAt(station: string, kind: ReportKind): Promise<Date | null>;
  /** Records the asking, so a request that came back empty still counts as recent. */
  putFetchAttempt(attempt: FetchAttempt): Promise<void>;
}

/**
 * True when upstream should be asked. A station never fetched is always
 * worth asking; one asked a moment ago is not.
 */
export async function shouldFetch(
  store: FreshnessStore,
  station: string,
  kind: ReportKind,
  now: Date = new Date(),
  maxAgeMs: number = DEFAULT_FRESHNESS_MS[kind],
): Promise<boolean> {
  if (maxAgeMs <= 0) return true;
  const last = await store.lastFetchAt(station.toUpperCase(), kind);
  return last === null || now.getTime() - last.getTime() >= maxAgeMs;
}

/** What a caller can say about why it did or did not ask upstream. */
export interface FreshnessDecision {
  readonly station: string;
  readonly kind: ReportKind;
  readonly fetched: boolean;
  readonly lastFetchAt: Date | null;
  readonly reason: string;
}

export async function decideFetch(
  store: FreshnessStore,
  station: string,
  kind: ReportKind,
  now: Date = new Date(),
  maxAgeMs: number = DEFAULT_FRESHNESS_MS[kind],
): Promise<FreshnessDecision> {
  const last = await store.lastFetchAt(station.toUpperCase(), kind);
  if (maxAgeMs <= 0) return { station, kind, fetched: true, lastFetchAt: last, reason: 'freshness checking is off' };
  if (last === null) return { station, kind, fetched: true, lastFetchAt: null, reason: `no ${kind} has ever been fetched for ${station}` };
  const ageMs = now.getTime() - last.getTime();
  if (ageMs >= maxAgeMs) return { station, kind, fetched: true, lastFetchAt: last, reason: `the last ${kind} fetch for ${station} was ${Math.round(ageMs / 60_000)} min ago` };
  return {
    station,
    kind,
    fetched: false,
    lastFetchAt: last,
    reason: `${station} ${kind} was fetched ${Math.round(ageMs / 60_000)} min ago; using what is stored`,
  };
}

/**
 * Record that an upstream was asked. Called after the request rather than
 * before it, so a client that throws before reaching the network does not
 * leave a mark saying it did.
 *
 * Without this, a product whose usual answer is "nothing in force" would be
 * asked for again on every single briefing: there would be no report to
 * hang the fetch on, and so no evidence that anybody had asked.
 */
export async function recordFetchAttempt(store: FreshnessStore, scope: string, kind: ReportKind, at: Date, request: string): Promise<void> {
  await store.putFetchAttempt({ scope: scope.trim().toUpperCase(), kind, attemptedAt: at, request });
}
