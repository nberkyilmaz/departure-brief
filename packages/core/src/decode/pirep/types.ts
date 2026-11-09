import type { LatLon } from '../../domain/geo.js';
import type { Sourced } from '../span.js';

export interface PirepCloud {
  readonly cover: string | null;
  readonly baseFt: number | null;
  readonly topFt: number | null;
}

export interface PirepTurbulence {
  /** `LGT`, `MOD`, `NEG`, `LGT-MOD`, as the service has it. */
  readonly intensity: string | null;
  /** `CHOP`, `CAT`, `LLWS`. */
  readonly type: string | null;
  readonly frequency: string | null;
  readonly baseFt: number | null;
  readonly topFt: number | null;
}

export interface PirepIcing {
  readonly intensity: string | null;
  /** `RIME`, `CLEAR`, `MX`. */
  readonly type: string | null;
  readonly baseFt: number | null;
  readonly topFt: number | null;
}

/** What a pilot found, where and at what height. */
export interface DecodedPirep {
  /** The report as it was filed. */
  readonly text: Sourced<string> | null;
  readonly position: LatLon | null;
  /** Null when the report does not give a usable one. */
  readonly altitudeFt: number | null;
  /** Said instead of a height: `/FLDURC`, `/FLDURD`. */
  readonly phase: 'climbing' | 'descending' | null;
  readonly aircraft: string | null;
  readonly urgent: boolean;
  readonly tempC: number | null;
  readonly clouds: readonly PirepCloud[];
  readonly turbulence: readonly PirepTurbulence[];
  readonly icing: readonly PirepIcing[];
  readonly unparsed: readonly string[];
}
