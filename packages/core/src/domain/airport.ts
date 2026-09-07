import type { DegreesMagnetic, DegreesTrue, Feet } from './units.js';

/**
 * An airport as the FAA NASR describes it, for one 28-day cycle. Runway
 * headings are **true**; convert with the airport's magnetic variation before
 * comparing with anything magnetic (ATIS, tower winds). METAR winds are true.
 */
/**
 * Where an airport record came from. `nasr` is the FAA's authoritative US
 * data; `ourairports` covers everywhere else. NASR also lists some foreign
 * border-area fields, incompletely (no runway alignments), so preference is
 * by country, not by source alone — see `airportPreference`.
 */
export type AirportSource = 'nasr' | 'ourairports';

/**
 * Higher wins when several records describe the same field: NASR for US
 * fields, OurAirports elsewhere, then anything else. Ties break on cycle.
 */
export function airportPreference(a: Pick<Airport, 'source' | 'country'>): number {
  if (a.source === 'nasr' && a.country === 'US') return 2;
  if (a.source === 'ourairports') return 1;
  return 0;
}

export interface Airport {
  readonly source: AirportSource;
  /** NASR cycle effective date or OurAirports snapshot date, `YYYY-MM-DD`. */
  readonly cycle: string;
  /**
   * NASR site number (`15793.`). Together with `siteType` it is the stable
   * key across files: one site number can be both an airport and a heliport.
   */
  readonly siteNo: string;
  /** `A` airport, `H` heliport, `S` seaplane base, `G` gliderport, `U` ultralight, `B` balloonport, `C` STOLport. */
  readonly siteType: string;
  /** FAA location identifier (`JFK`, `N07`). */
  readonly faaId: string;
  /** ICAO identifier when assigned (`KJFK`); most small fields have none. */
  readonly icaoId: string | null;
  readonly name: string;
  readonly city: string;
  readonly state: string;
  readonly country: string;
  readonly lat: number;
  readonly lon: number;
  readonly elevation: Feet | null;
  /** Degrees, east positive (`13W` → -13). `null` when the source gives none (OurAirports never does). */
  readonly magneticVariation: number | null;
  readonly magneticVariationYear: number | null;
  /** Traffic pattern altitude, feet MSL... as NASR gives it (AGL by convention). */
  readonly patternAltitude: Feet | null;
  readonly runways: readonly Runway[];
}

export interface Runway {
  /** `04L/22R` */
  readonly id: string;
  readonly length: Feet | null;
  readonly width: Feet | null;
  readonly surface: string | null;
  readonly condition: string | null;
  readonly lighting: string | null;
  readonly ends: readonly RunwayEnd[];
}

export interface RunwayEnd {
  /** `04L` */
  readonly id: string;
  /** True heading of the runway from this end, from NASR `TRUE_ALIGNMENT`. */
  readonly trueHeading: DegreesTrue | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly elevation: Feet | null;
  readonly displacedThreshold: Feet | null;
  readonly rightHandPattern: boolean;
  readonly ils: string | null;
  /** Declared distances, when published. */
  readonly tora: Feet | null;
  readonly toda: Feet | null;
  readonly asda: Feet | null;
  readonly lda: Feet | null;
}

/** "East is least": magnetic = true − variation(east positive). */
export function toMagnetic(trueHeading: DegreesTrue, variationEast: number): DegreesMagnetic {
  return ((((trueHeading - variationEast) % 360) + 360) % 360) as DegreesMagnetic;
}

export function toTrue(magneticHeading: DegreesMagnetic, variationEast: number): DegreesTrue {
  return ((((magneticHeading + variationEast) % 360) + 360) % 360) as DegreesTrue;
}
