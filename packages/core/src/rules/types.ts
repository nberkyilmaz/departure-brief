import type { FlightCategory } from '../decode/metar/derive.js';
import type { Span } from '../decode/span.js';

/** Bump when a rule's meaning or a finding's shape changes. */
export const RULES_VERSION = 6;

/**
 * How much attention a line deserves — an ordering, not a decision.
 *
 * This tool does not tell a pilot whether to fly. It reports what the
 * products say, compares it against the limits that pilot set, and puts the
 * things that deserve a second look at the top. The words are deliberately
 * about reading rather than about going:
 *
 * `routine` — measured, and within the limit you set.
 * `note`    — worth knowing: a forecast borrowed from a neighbour, night,
 *             the wind at cruise.
 * `caution` — a limit crossed in a temporary or probabilistic period, or a
 *             hazard near but not on the route.
 * `alert`   — a limit crossed in the prevailing conditions or the
 *             observation, or a hazard reported where you are going.
 *
 * An `alert` is not "do not go". It is "you asked to be told about this, and
 * here it is, with the report it came from".
 */
export type Attention = 'routine' | 'note' | 'caution' | 'alert';

/** Where a finding's inputs came from. The raw text and span are the grounding. */
export interface Citation {
  readonly kind: 'taf' | 'metar' | 'upperwind' | 'sigmet' | 'airport' | 'profile' | 'aircraft' | 'plan';
  readonly station: string | null;
  /** The whole report (or record) the span indexes into. */
  readonly raw: string | null;
  readonly span: Span | null;
  /** The cited text, sliced out for convenience; equals `raw.slice(span)` when both exist. */
  readonly text: string | null;
  readonly sha256: string | null;
}

/**
 * What kind of evidence a finding rests on. `basis` carries the readable
 * detail (`observed 1151Z`, `TEMPO 15:00Z–17:00Z`), which changes between
 * briefings even when nothing material does; `basisKind` is the stable part,
 * so the diff can tell "the same check on the same evidence" from a new one.
 */
export type BasisKind = 'prevailing' | 'overlay' | 'observed' | 'forecast' | 'time' | 'plan';

export interface Finding {
  /** Stable rule identifier, e.g. `personal.ceiling`, `crosswind.personal`, `vfr.visibility`. */
  readonly rule: string;
  readonly attention: Attention;
  /** One line a pilot can read; numbers and sources included. */
  readonly summary: string;
  readonly waypoint: string;
  /** Which forecast state produced it: prevailing, a named overlay, or the observation. */
  readonly basis: string;
  readonly basisKind: BasisKind;
  /** ISO instant the finding applies to. */
  readonly at: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly citations: readonly Citation[];
}

/**
 * Everything known about one point on the route at the time the aircraft
 * will be there. No verdict: the flight category is an objective
 * classification of ceiling and visibility, the same one every weather
 * service publishes, and the findings are what a pilot reads.
 */
export interface PointReview {
  readonly waypoint: string;
  readonly at: string;
  /** VFR, MVFR, IFR or LIFR from ceiling and visibility; `null` when neither is reported. */
  readonly category: FlightCategory | null;
  /** The same for the prevailing forecast, when this point has one. */
  readonly forecastCategory: FlightCategory | null;
  readonly night: boolean;
  readonly findings: readonly Finding[];
}

export interface Briefing {
  readonly rulesVersion: number;
  readonly profile: { readonly name: string; readonly version: number };
  readonly aircraft: string | null;
  readonly asOf: string;
  readonly points: readonly PointReview[];
  readonly alternate: PointReview | null;
}

/** Most wanting of attention first. Used for ordering, never for deciding. */
export const ATTENTION_ORDER: readonly Attention[] = ['alert', 'caution', 'note', 'routine'];

/** The most attention any of these findings asks for, or `null` when there are none. */
export function mostAttention(findings: readonly Finding[]): Attention | null {
  for (const level of ATTENTION_ORDER) if (findings.some((f) => f.attention === level)) return level;
  return null;
}
