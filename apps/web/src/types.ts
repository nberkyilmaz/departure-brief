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

export type NotamRank = 'critical' | 'advisory' | 'unverified' | 'not-assessed' | 'irrelevant' | 'out-of-scope';

export interface NotamItem {
  sha256: string;
  id: string | null;
  raw: string;
  text: string | null;
  qcode: string | null;
  qcodeMeaning: { subject: string | null; condition: string | null; traffic: string | null; purpose: string | null; scope: string | null } | null;
  locations: string[];
  from: string | null;
  to: string | null;
  schedule: string | null;
  sites: string[];
  supersededBy: string | null;
  classification: { time: string; near: boolean; inScope: boolean; distanceNm: number | null; reasons: string[] };
  rank: NotamRank;
  assessment: {
    model: string;
    promptVersion: number;
    citation: 'exact' | 'whitespace' | 'none';
    result: { relevance: string; category: string; affects: string[]; plain_text: string; cited_span: string; rationale: string };
  } | null;
  assessmentError: string | null;
  rule: { relevance: string; rule: string; reason: string } | null;
}

export interface NotamDocument {
  sites: string[];
  model: string | null;
  promptVersion: number;
  counts: Record<NotamRank, number>;
  fetchErrors: { site: string; error: string }[];
  items: NotamItem[];
}

export interface FindingChange {
  kind: 'appeared' | 'resolved' | 'worsened' | 'eased' | 'restated';
  waypoint: string;
  rule: string;
  basisKind: string;
  before: Finding | null;
  after: Finding | null;
  crossesLimit: boolean;
}

export interface PointDiff {
  waypoint: string;
  verdict: { from: Verdict; to: Verdict } | null;
  changes: FindingChange[];
}

export interface BriefingDiff {
  from: { sha256: string; asOf: string; verdict: Verdict };
  to: { sha256: string; asOf: string; verdict: Verdict };
  verdict: { from: Verdict; to: Verdict } | null;
  points: PointDiff[];
  alternate: PointDiff | null;
  notams: { kind: 'new' | 'gone' | 'rank-changed'; id: string | null; sha256: string; from: string | null; to: string | null; summary: string; notable: boolean }[];
  reports: { added: { kind: string; station: string | null; sha256: string }[]; removed: { kind: string; station: string | null; sha256: string }[] };
  warnings: string[];
  quiet: boolean;
}

export interface StoredBriefing {
  sha256: string;
  flightKey: string;
  asOf: string;
  createdAt: string;
  document: {
    format: 2;
    plan: FlightPlanInput;
    asOf: string;
    notams: NotamDocument | null;
    inputs: {
      points: { waypoint: string; eta: string; cumulativeNm: number; forecast: { station: string; source: 'own' | 'nearby'; distanceNm: number; sha256: string } | null; metar: string | null }[];
      reports: { kind: string; station: string | null; sha256: string; issuedAt: string | null }[];
    };
    briefing: Briefing;
  };
}

export interface DocumentCitation {
  documentSha256: string;
  filename: string;
  page: number;
  box: { x: number; y: number; w: number; h: number } | null;
  citedText: string;
}

export interface WbFigure {
  value: number;
  source: DocumentCitation | null;
  note: string | null;
}

export interface WeightBalanceSpec {
  version: 1;
  aircraftType: string;
  source: { documentSha256: string; filename: string; pages: number[] } | null;
  stations: { id: string; label: string; kind: 'seat' | 'baggage' | 'fuel' | 'oil'; armIn: WbFigure; maxLb: WbFigure | null }[];
  envelopes: { category: 'normal' | 'utility'; maxWeightLb: WbFigure; forward: { weightLb: number; armIn: number }[]; aftArmIn: WbFigure }[];
  demonstratedCrosswindKt: WbFigure | null;
  sample: { emptyWeightLb: WbFigure; emptyMomentPer1000: WbFigure } | null;
  review: { field: string; description: string; proposed: number | { weightLb: number; armIn: number }; page: number; citedText: string; problem: string }[];
}

export interface LoadingResult {
  rows: { label: string; weightLb: number; armIn: number; momentPer1000: number }[];
  totalWeightLb: number;
  totalMomentPer1000: number;
  cgIn: number;
  category: 'normal' | 'utility';
  limits: { maxWeightLb: number; forwardArmIn: number; aftArmIn: number };
  findings: { rule: string; severity: 'ok' | 'no-go'; summary: string; citations: DocumentCitation[] }[];
  verdict: 'within-limits' | 'outside-limits';
}
