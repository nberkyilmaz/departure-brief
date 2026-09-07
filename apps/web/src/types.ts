/**
 * The API's JSON shapes as the browser sees them. Mirrors
 * `@holdshort/core` (`rules/types.ts`, `brief/types.ts`, `domain/flight.ts`)
 * — kept as a local copy so the browser bundle never pulls in the Node
 * side of the core package.
 */

export type Verdict = 'go' | 'marginal' | 'no-go';
export type Severity = 'ok' | 'advisory' | 'marginal' | 'no-go';
export type AirspaceClass = 'control-zone' | 'controlled' | 'uncontrolled' | 'B' | 'C' | 'D' | 'E' | 'G';

export interface Citation {
  kind: 'taf' | 'metar' | 'airport' | 'profile' | 'aircraft' | 'plan';
  station: string | null;
  raw: string | null;
  span: { start: number; end: number } | null;
  text: string | null;
  sha256: string | null;
}

export interface Finding {
  rule: string;
  severity: Severity;
  summary: string;
  waypoint: string;
  basis: string;
  at: string;
  values: Record<string, unknown>;
  citations: Citation[];
}

export interface PointVerdict {
  waypoint: string;
  at: string;
  verdict: Verdict;
  night: boolean;
  findings: Finding[];
}

export interface Briefing {
  rulesVersion: number;
  profile: { name: string; version: number };
  aircraft: string | null;
  asOf: string;
  verdict: Verdict;
  points: PointVerdict[];
  alternate: PointVerdict | null;
}

export interface FlightPlanInput {
  departure: string;
  destination: string;
  alternate: string | null;
  route: string[];
  departureTime: string;
  cruise: { tas: number; altitude: number };
  airspace: Record<string, AirspaceClass> | null;
}

export interface ProfileInput {
  name: string;
  version: number;
  ceilingAglFt: number;
  visibilitySm: number;
  crosswindKt: number;
  crosswindIncludesGust: boolean;
  nightAllowed: boolean;
}

export interface AircraftInput {
  type: string;
  demonstratedCrosswindKt: number | null;
}

export interface StoredBriefing {
  sha256: string;
  flightKey: string;
  asOf: string;
  createdAt: string;
  document: {
    format: 1;
    plan: FlightPlanInput;
    asOf: string;
    inputs: {
      points: { waypoint: string; eta: string; cumulativeNm: number; forecast: { station: string; source: 'own' | 'nearby'; distanceNm: number; sha256: string } | null; metar: string | null }[];
      reports: { kind: string; station: string | null; sha256: string; issuedAt: string | null }[];
    };
    briefing: Briefing;
  };
}
