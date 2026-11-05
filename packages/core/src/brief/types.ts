import type { FlightPlan } from '../domain/flight.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import type { NotamDocument } from '../notam/describe.js';
import type { FuelPlan } from '../navlog/fuel.js';
import type { NavLog } from '../navlog/compute.js';
import type { Briefing } from '../rules/types.js';
import type { ReportKind } from '../store/types.js';

/** A raw report the briefing was judged on, by content hash. */
export interface BriefingReportRef {
  readonly kind: ReportKind;
  readonly station: string | null;
  readonly sha256: string;
  readonly issuedAt: string | null;
}

export interface BriefingPointInputs {
  readonly waypoint: string;
  readonly eta: string;
  readonly cumulativeNm: number;
  readonly forecast: {
    readonly station: string;
    readonly source: 'own' | 'nearby';
    readonly distanceNm: number;
    readonly sha256: string;
  } | null;
  readonly metar: string | null;
  /** The upper wind forecast this point's cruise wind came from. */
  readonly wind: { readonly station: string; readonly distanceNm: number; readonly altitudeFt: number; readonly sha256: string } | null;
}

/** What one station along the way was read from, and where on the route it is. */
export interface BriefingEnrouteInputs {
  readonly station: string;
  readonly leg: number;
  readonly eta: string;
  readonly cumulativeNm: number;
  readonly offsetNm: number;
  /** Its own TAF, by hash, when one covers the time it is passed. */
  readonly forecast: string | null;
  /** Its own current METAR, by hash. */
  readonly metar: string | null;
}

/**
 * Everything a briefing was made from and everything it concluded, in one
 * self-describing document. Content-addressed: the same inputs judged by
 * the same code give the same hash, so re-briefing an unchanged situation
 * is a no-op and the diff between two briefings is a diff of two documents
 * that each know their sources.
 */
export interface BriefingDocument {
  /** 2: adds `notams` and the NOTAM decoder / prompt versions. 3: adds `fuel`. 4: adds the stations along the way. */
  readonly format: 4;
  readonly plan: FlightPlan;
  readonly profile: PilotProfile;
  readonly aircraft: AircraftLimits | null;
  /** The instant the briefing was made as of; only reports known by then were used. */
  readonly asOf: string;
  readonly versions: {
    readonly rules: number;
    readonly metarDecoder: number;
    readonly tafDecoder: number;
    readonly notamDecoder: number;
    readonly notamPrompt: number;
  };
  /** `null` when NOTAMs were not part of this briefing. */
  readonly notams: NotamDocument | null;
  readonly inputs: {
    readonly points: readonly BriefingPointInputs[];
    readonly alternate: BriefingPointInputs | null;
    readonly enroute: readonly BriefingEnrouteInputs[];
    readonly reports: readonly BriefingReportRef[];
  };
  readonly briefing: Briefing;
  /** The wind triangle, leg by leg, from the same resolved flight. */
  readonly navlog: NavLog;
  /** Trip, reserve and what is aboard, against CARs 602.88 or FAR 91.151. */
  readonly fuel: FuelPlan;
}

export interface StoredBriefing {
  /** Content hash of `document`. */
  readonly sha256: string;
  /** Hash of the flight's identity (route, time, cruise) — groups briefings of the same flight. */
  readonly flightKey: string;
  readonly asOf: Date;
  readonly createdAt: Date;
  readonly document: BriefingDocument;
}
