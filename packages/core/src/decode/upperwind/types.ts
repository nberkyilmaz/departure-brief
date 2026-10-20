import type { Sourced } from '../span.js';

/**
 * One forecast level. NAV CANADA serves upper winds already reduced to
 * numbers, so there is nothing to parse out of a coded group — but the
 * numbers still carry the span of the record they were read from, because
 * a finding that cannot be traced back to what the service said is worth
 * no more here than anywhere else.
 */
export interface UpperWindLevel {
  readonly altitudeFt: number;
  /**
   * Degrees true, or `null` for light and variable — which the service
   * sends as a null direction with zero speed, and which is the FD
   * bulletin's "9900".
   */
  readonly directionTrue: number | null;
  readonly speedKt: number;
  /** Not forecast at the lowest levels, where it would be near the surface temperature. */
  readonly tempC: number | null;
  /** The span of this level's numbers in the record. */
  readonly span: Sourced<null>['span'];
}

/**
 * An upper wind forecast for one station, from one bulletin.
 *
 * Three bulletins cover the day (FBCN31, 33, 35) and two offices issue
 * them: CWAO covers 3,000 to 18,000 ft, KWNO the levels above. A light
 * aircraft is always reading the CWAO half, which is why a briefing must
 * not assume one record holds every level.
 */
export interface DecodedUpperWind {
  /** `FBCN31` and the like — which of the day's three forecasts this is. */
  readonly bulletin: Sourced<string> | null;
  /** The issuing office: `CWAO` for the low levels, `KWNO` above them. */
  readonly issuer: Sourced<string> | null;
  readonly issuedAt: Sourced<Date> | null;
  /** The observation time the forecast was computed from. */
  readonly basedOn: Sourced<Date> | null;
  /** The instant the forecast describes. */
  readonly validAt: Sourced<Date> | null;
  /** The window it is to be used for; outside it, a different bulletin applies. */
  readonly useFrom: Sourced<Date> | null;
  readonly useTo: Sourced<Date> | null;
  /** Lowest first. The service sends them unordered. */
  readonly levels: readonly UpperWindLevel[];
  /** Parts of the record this decoder did not account for, never silently dropped. */
  readonly unparsed: readonly string[];
}
