import type { Span } from '../decode/span.js';

/** Bump when a rule's meaning or a finding's shape changes. */
export const RULES_VERSION = 2;

export type Verdict = 'go' | 'marginal' | 'no-go';

/**
 * `ok` — the check passed; `advisory` — worth knowing, no verdict impact;
 * `marginal` — a violation in an overlay (`TEMPO`, `PROB`, in-window
 * `BECMG`) or a soft limit; `no-go` — a violation in the prevailing forecast
 * or the observation.
 */
export type Severity = 'ok' | 'advisory' | 'marginal' | 'no-go';

/** Where a finding's inputs came from. The raw text and span are the grounding. */
export interface Citation {
  readonly kind: 'taf' | 'metar' | 'airport' | 'profile' | 'aircraft' | 'plan';
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
export type BasisKind = 'prevailing' | 'overlay' | 'observed' | 'forecast' | 'time';

export interface Finding {
  /** Stable rule identifier, e.g. `personal.ceiling`, `crosswind.personal`, `vfr.visibility`. */
  readonly rule: string;
  readonly severity: Severity;
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

export interface PointVerdict {
  readonly waypoint: string;
  readonly at: string;
  readonly verdict: Verdict;
  readonly night: boolean;
  readonly findings: readonly Finding[];
}

export interface Briefing {
  readonly rulesVersion: number;
  readonly profile: { readonly name: string; readonly version: number };
  readonly aircraft: string | null;
  readonly asOf: string;
  readonly verdict: Verdict;
  readonly points: readonly PointVerdict[];
  readonly alternate: PointVerdict | null;
}

export function worst(...verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes('no-go')) return 'no-go';
  if (verdicts.includes('marginal')) return 'marginal';
  return 'go';
}

export function verdictOf(findings: readonly Finding[]): Verdict {
  return worst(...findings.map((f) => (f.severity === 'no-go' ? 'no-go' : f.severity === 'marginal' ? 'marginal' : 'go')));
}
