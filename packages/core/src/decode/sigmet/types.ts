import type { LatLon } from '../../domain/geo.js';
import type { Sourced } from '../span.js';

/** What the advisory is about, normalised across the feeds that carry them. */
export type SigmetHazard =
  | 'thunderstorm'
  | 'turbulence'
  | 'icing'
  | 'mountain-wave'
  | 'volcanic-ash'
  | 'tropical-cyclone'
  | 'ifr'
  | 'mountain-obscuration'
  | 'low-level-wind-shear'
  | 'surface-wind';

/**
 * A hazard advisory over an area, for a stretch of time, between two
 * altitudes. An AIRMET is advice to light aircraft; a SIGMET is a warning
 * to everything in the air.
 */
export interface DecodedSigmet {
  readonly kind: 'sigmet' | 'airmet' | null;
  readonly hazard: SigmetHazard | null;
  /** The service's own code, cited, even when this decoder does not know it. */
  readonly hazardCode: Sourced<string> | null;
  /** `SEV`, `MOD`, `OCNL` and the like, when given. */
  readonly qualifier: Sourced<string> | null;
  readonly baseFt: number | null;
  readonly topFt: number | null;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
  /** The flight information region, or the office that issued it. */
  readonly region: string | null;
  readonly regionName: string | null;
  readonly series: string | null;
  /** The bulletin as a pilot would be handed it. */
  readonly bulletin: Sourced<string> | null;
  /**
   * A G-AIRMET is a forecast picture at one instant, three hours from the
   * next, and this is the instant. `validFrom` and `validTo` are the part of
   * the day it speaks for. Null for every other kind of advisory.
   */
  readonly snapshotAt?: Date | null;
  /** The ceiling and visibility behind an IFR or mountain obscuration area, as the forecaster put it. */
  readonly dueTo?: string | null;
  /** The area it covers, in order. Empty when the service gave no geometry. */
  readonly area: readonly LatLon[];
  readonly unparsed: readonly string[];
}
