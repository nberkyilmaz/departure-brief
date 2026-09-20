/**
 * The API's JSON shapes as the browser sees them. Mirrors
 * `@depbrief/core` (`rules/types.ts`, `brief/types.ts`, `domain/flight.ts`)
 * — kept as a local copy so the browser bundle never pulls in the Node
 * side of the core package.
 */

/**
 * How much attention a line deserves — an ordering, not a decision. The tool
 * reports; the pilot decides.
 */
export type Attention = 'routine' | 'note' | 'caution' | 'alert';

/** How old an observation is, in bands. Old data is not wrong; it is old. */
export type ObservationAge = 'current' | 'recent' | 'stale' | 'old';

/** The standard classification of ceiling and visibility. A fact, not an opinion. */
export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
export type AirspaceClass = 'control-zone' | 'controlled' | 'uncontrolled' | 'B' | 'C' | 'D' | 'E' | 'G';

export interface Citation {
  kind: 'taf' | 'metar' | 'upperwind' | 'sigmet' | 'airport' | 'profile' | 'aircraft' | 'plan';
  station: string | null;
  raw: string | null;
  span: { start: number; end: number } | null;
  text: string | null;
  sha256: string | null;
}

export interface Finding {
  rule: string;
  attention: Attention;
  summary: string;
  waypoint: string;
  basis: string;
  at: string;
  values: Record<string, unknown>;
  citations: Citation[];
}

export interface PointReview {
  waypoint: string;
  at: string;
  /** From the observation at the field, when it has one. */
  category: FlightCategory | null;
  /** From the prevailing forecast governing this point at its ETA. */
  forecastCategory: FlightCategory | null;
  night: boolean;
  findings: Finding[];
}

export interface Briefing {
  rulesVersion: number;
  profile: { name: string; version: number };
  aircraft: string | null;
  asOf: string;
  points: PointReview[];
  alternate: PointReview | null;
}

export interface FlightPlanInput {
  departure: string;
  destination: string;
  alternate: string | null;
  route: string[];
  departureTime: string;
  cruise: { tas: number; altitude: number };
  /** US gallons in the tanks at departure, as the pilot states it; null when not given. */
  fuelAboardGal?: number | null;
  airspace: Record<string, AirspaceClass> | null;
}

/** Trip, reserve and what is aboard, against CARs 602.88. Every null has a reason in `gaps`. */
export interface FuelPlan {
  tripGal: number | null;
  alternateGal: number | null;
  reserve: { minutes: 30 | 45; basis: 'day' | 'night'; rule: string; gal: number | null };
  requiredGal: number | null;
  withAlternateGal: number | null;
  aboardGal: number | null;
  marginGal: number | null;
  marginMinutes: number | null;
  gaps: string[];
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
  /** Cruise burn, US gallons an hour. Null until somebody supplies it. */
  cruiseFuelGph: number | null;
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
  /** Null when the flight category did not move. */
  category: { from: FlightCategory | null; to: FlightCategory | null } | null;
  changes: FindingChange[];
}

export interface BriefingDiff {
  from: { sha256: string; asOf: string };
  to: { sha256: string; asOf: string };
  points: PointDiff[];
  alternate: PointDiff | null;
  notams: { kind: 'new' | 'gone' | 'rank-changed'; id: string | null; sha256: string; from: string | null; to: string | null; summary: string; notable: boolean }[];
  reports: { added: { kind: string; station: string | null; sha256: string }[]; removed: { kind: string; station: string | null; sha256: string }[] };
  warnings: string[];
  quiet: boolean;
}

/** What one point was resolved from: the reports, and how far they travelled. */
export interface PointInputs {
  waypoint: string;
  eta: string;
  cumulativeNm: number;
  forecast: { station: string; source: 'own' | 'nearby'; distanceNm: number; sha256: string } | null;
  metar: string | null;
  wind: { station: string; distanceNm: number; altitudeFt: number; sha256: string } | null;
}

export interface NavLogWind {
  directionTrue: number;
  speedKt: number;
  station: string;
  distanceNm: number;
  altitudeFt: number;
  sha256: string;
}

export interface NavLogLeg {
  from: string;
  to: string;
  distanceNm: number;
  trueCourse: number;
  magneticCourse: number | null;
  wind: NavLogWind | null;
  windCorrectionAngle: number | null;
  trueHeading: number | null;
  magneticHeading: number | null;
  groundspeedKt: number | null;
  minutes: number | null;
  cumulativeMinutes: number | null;
  fuelGal: number | null;
  cumulativeFuelGal: number | null;
  /** Why a number is missing, in words. */
  gaps: string[];
}

export interface NavLog {
  version: number;
  tas: number;
  altitudeFt: number;
  fuelGph: number | null;
  legs: NavLogLeg[];
  totalDistanceNm: number;
  totalMinutes: number | null;
  totalFuelGal: number | null;
  alternate: NavLogLeg | null;
}

/** A runway as the airport data carries it. */
export interface Runway {
  id: string;
  length: number | null;
  width: number | null;
  surface: string | null;
  ends: { id: string; trueHeading: number | null }[];
}

export interface Airport {
  icaoId: string | null;
  faaId: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  lat: number;
  lon: number;
  elevation: number | null;
  runways: Runway[];
}

/** Everything the pipeline knows about one field at one instant. */
export interface AerodromeReport {
  airport: Airport;
  at: string;
  observation: {
    station: string;
    source: 'own' | 'nearby';
    distance: number;
    ageMinutes: number;
    ownAsleep: boolean;
    report: { body: string; sha256: string; issuedAt: string | null };
  } | null;
  forecast: { station: string; source: 'own' | 'nearby'; distance: number; resolved: { raw: string } } | null;
  category: FlightCategory | null;
  forecastCategory: FlightCategory | null;
  night: boolean;
  daylight: { sunrise: string | null; sunset: string | null; civilDawn: string | null; civilDusk: string | null; allDay: boolean; allNight: boolean };
  /** Wind on every runway end, best first. Null when nothing reported a wind. */
  crosswind: {
    speed: number;
    gust: number | null;
    /** VRB: every runway carries the full speed, because any of them might. */
    variable: boolean;
    calm: boolean;
    runways: { runway: string; end: string; heading: number; crosswind: number; headwind: number; crosswindGust: number; headwindGust: number }[];
    unknownHeading: string[];
  } | null;
  /** The observation in words, each line pointing into the raw report. */
  explained: { label: string; text: string; span: { start: number; end: number } | null; indeterminate: boolean }[];
  findings: Finding[];
  nearby: { id: string; name: string; distanceNm: number; bearingTrue: number; ageMinutes: number | null }[];
}

export interface StoredBriefing {
  sha256: string;
  flightKey: string;
  asOf: string;
  createdAt: string;
  document: {
    format: 3;
    plan: FlightPlanInput;
    asOf: string;
    notams: NotamDocument | null;
    inputs: {
      points: PointInputs[];
      /** The alternate's inputs, kept apart from the route's. */
      alternate: PointInputs | null;
      reports: { kind: string; station: string | null; sha256: string; issuedAt: string | null }[];
    };
    briefing: Briefing;
    navlog: NavLog;
    fuel: FuelPlan;
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
  findings: { rule: string; severity: 'routine' | 'alert'; summary: string; citations: DocumentCitation[] }[];
  verdict: 'within-limits' | 'outside-limits';
}
