/**
 * Forecast verification: did the TAF that a briefing relied on turn out to
 * be right?
 *
 * A briefing records what the forecast said would be true at a waypoint at
 * its ETA. That moment later passes, an observation for it arrives, and the
 * pair can be scored. Accumulated over a season, per station, it answers a
 * question no consumer product asks: does this aerodrome's TAF tend to
 * forecast the ceiling better or worse than it turns out?
 *
 * Both halves are immutable and append-only, like every other record here.
 * A check is written once, when the briefing is made; an outcome is written
 * once, when an observation is matched to it. Re-running never rewrites.
 */

/** What the forecast said would be true at one place and time. */
export interface ForecastCheck {
  /** Content hash of (station, validAt, tafSha256, decoderVersion) — the identity of this prediction. */
  readonly key: string;
  /** The station the TAF is for, which may not be the waypoint (a borrowed forecast). */
  readonly station: string;
  /** The moment forecast for: a waypoint's ETA. */
  readonly validAt: Date;
  readonly tafSha256: string;
  readonly tafIssuedAt: Date | null;
  readonly tafDecoderVersion: number;
  /** How far ahead the forecast was looking, in hours; a six-hour forecast is a different animal from a twenty-four hour one. */
  readonly leadHours: number | null;
  readonly ceilingFt: number | null;
  readonly visibilitySm: number | null;
  /** The visibility is a floor, not a measurement: `P6SM`, `CAVOK`, `9999`. */
  readonly visibilityAtLeast: boolean;
  readonly windDirTrue: number | null;
  readonly windKt: number | null;
  readonly gustKt: number | null;
  readonly category: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null;
  /**
   * The worst category any in-window overlay (TEMPO, PROB, INTER) allowed
   * for. The prevailing forecast is what the TAF asserts, but a TAF that
   * said "TEMPO IFR" and got IFR was not blind to it.
   */
  readonly overlayWorstCategory: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null;
  readonly createdAt: Date;
}

/** What was actually observed at that place and time. */
export interface ForecastOutcome {
  readonly checkKey: string;
  readonly metarSha256: string;
  readonly observedAt: Date;
  /** Minutes between the observation and the moment forecast for; signed, observation minus forecast. */
  readonly offsetMinutes: number;
  readonly ceilingFt: number | null;
  readonly visibilitySm: number | null;
  readonly visibilityAtLeast: boolean;
  readonly windDirTrue: number | null;
  readonly windKt: number | null;
  readonly gustKt: number | null;
  readonly category: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null;
  readonly matchedAt: Date;
}

export interface VerificationPair {
  readonly check: ForecastCheck;
  readonly outcome: ForecastOutcome;
}

export interface ForecastStore {
  /** Insert a prediction. Returns false when this exact prediction was already recorded. */
  putForecastCheck(check: ForecastCheck): Promise<{ inserted: boolean }>;
  /** Predictions with no outcome yet whose moment has passed. */
  listUnmatchedChecks(query: { station?: string | null; before: Date; limit?: number }): Promise<ForecastCheck[]>;
  /** Record what was observed. Returns false when this pairing was already recorded. */
  putForecastOutcome(outcome: ForecastOutcome): Promise<{ inserted: boolean }>;
  /** Scored pairs, newest moment first. */
  listVerificationPairs(query: { station?: string | null; since?: Date | null; limit?: number }): Promise<VerificationPair[]>;
}
