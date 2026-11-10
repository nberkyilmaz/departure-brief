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

/** Where a finding's conditions came from: the stable part of `basis`. */
export type BasisKind = 'prevailing' | 'overlay' | 'observed' | 'forecast' | 'time' | 'plan';

export interface Finding {
  rule: string;
  attention: Attention;
  summary: string;
  waypoint: string;
  basis: string;
  basisKind: BasisKind;
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

/** A reporting station near the track, at the time you would be abeam it. */
export interface EnrouteReview {
  station: string;
  /** Which leg it is beside: 0 for the first. */
  leg: number;
  /** From the departure, along the track. */
  alongNm: number;
  /** Off the track, positive to the right. */
  offsetNm: number;
  at: string;
  category: FlightCategory | null;
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
  /** The stations along the way, in the order they are passed. */
  enroute: EnrouteReview[];
}

export interface FlightPlanInput {
  departure: string;
  destination: string;
  alternate: string | null;
  route: string[];
  departureTime: string;
  /** `rpm` is the power setting the handbook's cruise table is read by; absent when not chosen. */
  cruise: { tas: number; altitude: number; rpm?: number };
  /** US gallons in the tanks at departure, as the pilot states it; null when not given. */
  fuelAboardGal?: number | null;
  airspace: Record<string, AirspaceClass> | null;
}

/** Trip, reserve and what is aboard, against CARs 602.88 or FAR 91.151. Every null has a reason in `gaps`. */
export interface FuelPlan {
  tripGal: number | null;
  /** What the trip is made of, when the handbook supplied the allowance and the climb. */
  allowanceGal: number | null;
  climbGal: number | null;
  cruiseGal: number | null;
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
  /** Added to the handbook's takeoff and landing distances, in percent. */
  runwayMarginPercent: number;
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

/** One end of the flight at one hour you might leave: what the briefing would say for it. */
export interface WindowPoint {
  waypoint: string;
  /** When you would be there. */
  at: string;
  /** From the prevailing forecast; null when there is none, or it gives neither ceiling nor visibility. */
  category: FlightCategory | null;
  covered: boolean;
  forecastStation: string | null;
  night: boolean;
  /** The limits crossed then, from the forecast and the clock; never the observation now. */
  findings: Finding[];
}

/** The stations along the way at one hour: the worst forecast among them, and every limit any crosses. */
export interface WindowAlong {
  covered: number;
  category: FlightCategory | null;
  station: string | null;
  findings: Finding[];
}

export interface DepartureSlot {
  departAt: string;
  /** The departure, then the destination. */
  points: WindowPoint[];
  along: WindowAlong;
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
  enroute: PointDiff[];
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
  /** Present when a balloon measured it: where it went up, and when. */
  measured?: { by: string; at: string };
}

/** One printed cell of the handbook's cruise table, and whether the scan bears out its speed and burn. */
export interface CruiseCellRef {
  pressureAltitudeFt: number;
  rpm: number;
  /** Degrees from standard. */
  columnC: number;
  bhp: number;
  ktas: number;
  gph: number;
  scanned: { ktas: boolean; gph: boolean };
}

/** The burn a leg is flown at: typed into the aircraft settings, or the handbook's. */
export interface LegBurn {
  gph: number;
  source: 'aircraft' | 'handbook';
  handbook: { rpm: number; deviationC: number | null; burnCell: CruiseCellRef; speedCell: CruiseCellRef; around: CruiseCellRef[] } | null;
}

export interface NavLogClimb {
  fromFt: number;
  toFt: number;
  fromRowFt: number;
  toRowFt: number;
  deviationC: number | null;
  percent: number;
  gal: number;
  nm: number;
  minutes: number;
}

/** What the handbook added before the first leg, and where it prints it. */
export interface NavLogHandbook {
  model: string;
  filename: string;
  sha256: string;
  cruiseTable: { figure: string; page: number; printedPage: string };
  climbTable: { figure: string; page: number; printedPage: string };
  pressureAltitudeFt: number;
  altimeterFrom: string | null;
  allowance: { gal: number; printed: string; scanned: boolean };
  climb: NavLogClimb | null;
  notes: string[];
}

export interface NavLogLeg {
  from: string;
  to: string;
  distanceNm: number;
  /** The part of the leg spent climbing, whose fuel is the climb's. */
  climbNm: number;
  trueCourse: number;
  /** Degrees east positive, where the leg begins; null outside the magnetic model's years. */
  variation: number | null;
  magneticCourse: number | null;
  wind: NavLogWind | null;
  windCorrectionAngle: number | null;
  trueHeading: number | null;
  magneticHeading: number | null;
  groundspeedKt: number | null;
  minutes: number | null;
  cumulativeMinutes: number | null;
  burn: LegBurn | null;
  /** The leg's cruise fuel, after the climb. */
  fuelGal: number | null;
  /** Everything used by the end of the leg, the allowance and the climb included. */
  cumulativeFuelGal: number | null;
  /** Why a number is missing, in words. */
  gaps: string[];
}

export interface NavLog {
  version: number;
  tas: number;
  altitudeFt: number;
  rpm: number | null;
  /** The highest burn of any leg: what the reserve is flown at. */
  fuelGph: number | null;
  handbook: NavLogHandbook | null;
  legs: NavLogLeg[];
  totalDistanceNm: number;
  totalMinutes: number | null;
  totalFuelGal: number | null;
  /** Why there is no fuel figure, when the reason is not a missing time. */
  fuelProblem: string | null;
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
  /** Degrees east positive, from the World Magnetic Model; null outside its years. */
  variation: number | null;
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
    format: 4;
    plan: FlightPlanInput;
    asOf: string;
    notams: NotamDocument | null;
    inputs: {
      points: PointInputs[];
      /** The alternate's inputs, kept apart from the route's. */
      alternate: PointInputs | null;
      enroute: { station: string; leg: number; eta: string; cumulativeNm: number; offsetNm: number; forecast: string | null; metar: string | null }[];
      reports: { kind: string; station: string | null; sha256: string; issuedAt: string | null }[];
    };
    briefing: Briefing;
    navlog: NavLog;
    fuel: FuelPlan;
  };
}

/** A cloud layer put on the altitude scale. */
export interface PictureLayer {
  kind: 'layer' | 'vertical-visibility';
  amount: 'FEW' | 'SCT' | 'BKN' | 'OVC' | null;
  type: 'CB' | 'TCU' | null;
  /** Null when the report gave no height, or its station has no known elevation. */
  baseMsl: number | null;
}

export interface PictureSky {
  layers: PictureLayer[];
  visibility: string | null;
  weather: string[];
}

export interface PictureReading {
  /** A forecast for the time you pass, or an observation from now. */
  from: 'forecast' | 'observed';
  station: string;
  distanceNm: number;
  issuedAt: string | null;
  /** Null for an observation too far from the time you pass to say anything about it. */
  sky: PictureSky | null;
  overlays: { label: string; from: string; to: string; sky: PictureSky }[];
}

export interface PictureStation {
  id: string;
  role: 'departure' | 'via' | 'destination' | 'along';
  lat: number;
  lon: number;
  nm: number;
  offsetNm: number;
  at: string;
  elevationFt: number | null;
  reading: PictureReading | null;
}

export interface PictureHazardBase {
  kind: 'sigmet' | 'airmet';
  what: string;
  qualifier: string | null;
  region: string | null;
  baseFt: number | null;
  topFt: number | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface PictureHazard extends PictureHazardBase {
  area: { lat: number; lon: number }[];
  /** Where a G-AIRMET has moved to in the later pictures you are still under it for. */
  laterAreas: { lat: number; lon: number }[][];
  stretches: { fromNm: number; toNm: number; fromAt: string; toAt: string; startsInside: boolean; endsInside: boolean; middle: { lat: number; lon: number } }[];
}

export interface PictureHazardMissed extends PictureHazardBase {
  why: 'over-before-you-reach-it' | 'not-begun-when-you-leave-it';
  nm: number;
  at: string;
}

export interface PictureFreezing {
  station: string;
  nm: number;
  at: string;
  distanceNm: number;
  crossingsFt: number[];
  belowFt: number | null;
  aboveFt: number | null;
  /** When a balloon measured it rather than a forecast giving it. */
  measuredAt?: string;
}

export interface PicturePirep {
  station: string | null;
  /** The report as filed. */
  text: string;
  at: string;
  lat: number;
  lon: number;
  nm: number;
  /** Off the route, positive to the right of it. */
  offsetNm: number;
  passAt: string;
  /** Made within ninety minutes of when you would pass it. */
  speaksForThen: boolean;
  altitudeFt: number | null;
  phase: 'climbing' | 'descending' | null;
  aircraft: string | null;
  urgent: boolean;
  tempC: number | null;
  clouds: { cover: string | null; baseFt: number | null; topFt: number | null }[];
  turbulence: { intensity: string | null; type: string | null; frequency: string | null; baseFt: number | null; topFt: number | null }[];
  icing: { intensity: string | null; type: string | null; baseFt: number | null; topFt: number | null }[];
}

/** The flight laid out along the route for drawing. Beside the briefing, not part of its hash. */
export interface RoutePicture {
  line: { lat: number; lon: number }[];
  /** One outline per leg: the strip searched for stations either side of the track. */
  corridor: { lat: number; lon: number }[][];
  totalNm: number;
  cruiseFt: number;
  tasKt: number;
  stations: PictureStation[];
  hazards: PictureHazard[];
  hazardsMissed: PictureHazardMissed[];
  hazardsUntestable: number;
  freezing: PictureFreezing[];
  pireps: PicturePirep[];
  /** How many reports were held for anywhere. None means there are none to go by, not that the sky is empty. */
  pirepsHeld: number;
  /** How much of the line is over the United States, which is as far as the FAA's airspace shapes speak for. */
  overUS: 'all' | 'part' | 'none';
}

/** Spot heights along the centre line, from an elevation model. */
export interface RouteTerrain {
  readonly spacingNm: number;
  readonly samples: readonly { readonly nm: number; readonly ft: number }[];
  readonly highest: { readonly nm: number; readonly ft: number };
}

export type AirspaceKind = 'class-b' | 'class-c' | 'class-d' | 'prohibited' | 'restricted' | 'warning' | 'danger' | 'moa' | 'alert';

export interface AirspaceLimit {
  readonly ft: number | null;
  readonly reference: 'surface' | 'msl' | 'agl' | 'fl' | 'none';
  readonly excluded: boolean;
}

/** One published shape the route goes through. */
export interface AirspaceArea {
  readonly kind: AirspaceKind;
  readonly name: string;
  readonly floor: AirspaceLimit;
  readonly ceiling: AirspaceLimit;
  readonly hours: string | null;
  readonly excludes: string | null;
  readonly rings: readonly (readonly { readonly lat: number; readonly lon: number }[])[];
  readonly stretches: readonly { readonly fromNm: number; readonly toNm: number }[];
}

export interface RouteAirspace {
  readonly areas: readonly AirspaceArea[];
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
