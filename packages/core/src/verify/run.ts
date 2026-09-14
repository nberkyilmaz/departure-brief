/**
 * The two halves of verification as operations: record what a briefing
 * predicted, and later pair each prediction with what arrived.
 *
 * Recording happens whenever a briefing is made, and costs one row per
 * waypoint that had a forecast. Matching is a separate pass, because the
 * answer does not exist yet at briefing time — that is the whole point.
 */
import type { AwcClient } from '../fetch/awc.js';
import { storeAndDecode } from '../store/decode.js';
import type { ResolvedFlight } from '../resolve/flight.js';
import type { Store } from '../store/types.js';
import { checksFrom, matchOutcome } from './record.js';
import type { ForecastCheck } from './types.js';

/** Record what this briefing's forecasts assert. Idempotent: the same briefing twice adds nothing. */
export async function recordForecastChecks(store: Store, flight: ResolvedFlight, now: Date = new Date()): Promise<{ recorded: number; alreadyKnown: number }> {
  let recorded = 0;
  let alreadyKnown = 0;
  for (const check of checksFrom(flight, now)) {
    const { inserted } = await store.putForecastCheck(check);
    if (inserted) recorded++;
    else alreadyKnown++;
  }
  return { recorded, alreadyKnown };
}

export interface MatchReport {
  readonly considered: number;
  readonly matched: number;
  readonly alreadyMatched: number;
  /** Moments with no observation close enough — a station that reports hourly, or has not reported yet. */
  readonly noObservation: readonly { readonly station: string; readonly validAt: string }[];
  readonly stations: readonly string[];
  readonly fetchErrors: readonly { readonly station: string; readonly error: string }[];
}

/** How far back a fetch reaches for the observations a pending check needs. */
export const MAX_BACKFILL_HOURS = 24;

/**
 * Pair every prediction whose moment has passed with the observation
 * nearest it. With an AWC client, first pulls each station's recent
 * observations so the answer is there to find; without one, works only
 * from what the store already holds.
 */
export async function matchOutstanding(
  deps: { store: Store; awc?: AwcClient | null },
  query: { station?: string | null; before?: Date; limit?: number } = {},
): Promise<MatchReport> {
  const { store } = deps;
  const before = query.before ?? new Date();
  const outstanding = await store.listUnmatchedChecks({ station: query.station ?? null, before, limit: query.limit ?? 500 });
  const stations = [...new Set(outstanding.map((c) => c.station))].sort();
  const fetchErrors: { station: string; error: string }[] = [];

  if (deps.awc && stations.length > 0) {
    for (const station of stations) {
      const oldest = Math.min(...outstanding.filter((c) => c.station === station).map((c) => c.validAt.getTime()));
      const hours = Math.min(MAX_BACKFILL_HOURS, Math.max(1, Math.ceil((before.getTime() - oldest) / 3_600_000) + 1));
      try {
        const fetched = await deps.awc.metars([station], { hours });
        await storeAndDecode(store, fetched.reports, fetched.request, new Date(), station);
      } catch (e) {
        fetchErrors.push({ station, error: (e as Error).message });
      }
    }
  }

  let matched = 0;
  let alreadyMatched = 0;
  const noObservation: { station: string; validAt: string }[] = [];
  for (const check of outstanding) {
    const outcome = await matchOutcome(store, check);
    if (!outcome) {
      noObservation.push({ station: check.station, validAt: check.validAt.toISOString() });
      continue;
    }
    const { inserted } = await store.putForecastOutcome(outcome);
    if (inserted) matched++;
    else alreadyMatched++;
  }
  return { considered: outstanding.length, matched, alreadyMatched, noObservation, stations, fetchErrors };
}

/** Predictions still waiting, oldest moment first — what a later pass will try again. */
export async function outstandingChecks(store: Store, before: Date = new Date()): Promise<ForecastCheck[]> {
  const rows = await store.listUnmatchedChecks({ before, limit: 500 });
  return [...rows].sort((a, b) => a.validAt.getTime() - b.validAt.getTime());
}
