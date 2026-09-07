/**
 * Regulatory VFR weather minima as a pure function. Two tables:
 *
 * - **CARs 602.114 / 602.115** (Canada), fixed-wing, per TC AIM RAC 2.7.
 * - **FAR 91.155** (United States).
 *
 * Each row is a literal transcription of the regulation and has one test.
 * The function does not decide airspace class or day/night; callers do.
 */

import type { AirspaceClass } from '../domain/flight.js';
import type { Feet, FeetAgl, FeetMsl, StatuteMiles } from '../domain/units.js';

export type Jurisdiction = 'CA' | 'US';

export interface CloudClearance {
  readonly below: Feet;
  readonly above: Feet;
  readonly horizontal: { readonly feet: number } | { readonly statuteMiles: number };
}

export interface VfrMinima {
  readonly rule: string;
  readonly visibility: StatuteMiles;
  /** `null` means "clear of clouds". */
  readonly cloudClearance: CloudClearance | null;
  /**
   * A ceiling below which VFR is not available at all (e.g. a control zone
   * without special VFR). `null` when the regulation sets none directly.
   */
  readonly ceiling: FeetAgl | null;
}

export interface VfrMinimaQuery {
  readonly jurisdiction: Jurisdiction;
  readonly airspace: AirspaceClass;
  readonly altitudeMsl: FeetMsl;
  readonly altitudeAgl: FeetAgl;
  readonly night: boolean;
}

const ft = (n: number) => n as Feet;
const sm = (n: number) => n as StatuteMiles;
const clr = (below: number, above: number, horizontal: CloudClearance['horizontal']): CloudClearance => ({
  below: ft(below),
  above: ft(above),
  horizontal,
});

const CA_CONTROLLED: readonly AirspaceClass[] = ['control-zone', 'controlled', 'B', 'C', 'D', 'E'];

function canada(q: VfrMinimaQuery): VfrMinima {
  if (q.airspace === 'control-zone') {
    return {
      rule: 'CARs 602.114 (control zone)',
      visibility: sm(3),
      cloudClearance: clr(500, 500, { statuteMiles: 1 }),
      // 500 ft below cloud from at least 500 ft AGL: VFR in a control zone
      // needs a 1,000 ft ceiling; below that it is special VFR (602.117).
      ceiling: 1000 as FeetAgl,
    };
  }
  if (CA_CONTROLLED.includes(q.airspace)) {
    return {
      rule: 'CARs 602.114 (controlled airspace)',
      visibility: sm(3),
      cloudClearance: clr(500, 500, { statuteMiles: 1 }),
      ceiling: null,
    };
  }
  // Uncontrolled (602.115). Fixed-wing rows only.
  if (q.altitudeAgl >= 1000) {
    return q.night
      ? { rule: 'CARs 602.115 (uncontrolled, ≥1000 ft AGL, night)', visibility: sm(3), cloudClearance: clr(500, 500, { feet: 2000 }), ceiling: null }
      : { rule: 'CARs 602.115 (uncontrolled, ≥1000 ft AGL, day)', visibility: sm(1), cloudClearance: clr(500, 500, { feet: 2000 }), ceiling: null };
  }
  return q.night
    ? { rule: 'CARs 602.115 (uncontrolled, <1000 ft AGL, night)', visibility: sm(3), cloudClearance: null, ceiling: null }
    : { rule: 'CARs 602.115 (uncontrolled, <1000 ft AGL, day)', visibility: sm(2), cloudClearance: null, ceiling: null };
}

function unitedStates(q: VfrMinimaQuery): VfrMinima {
  const std = clr(500, 1000, { feet: 2000 });
  const high = clr(1000, 1000, { statuteMiles: 1 });
  switch (q.airspace) {
    case 'B':
      return { rule: 'FAR 91.155 Class B', visibility: sm(3), cloudClearance: null, ceiling: null };
    case 'C':
    case 'D':
    case 'control-zone':
    case 'controlled':
      return { rule: `FAR 91.155 Class ${q.airspace === 'C' ? 'C' : 'D'}`, visibility: sm(3), cloudClearance: std, ceiling: null };
    case 'E':
      return q.altitudeMsl < 10000
        ? { rule: 'FAR 91.155 Class E below 10,000 ft MSL', visibility: sm(3), cloudClearance: std, ceiling: null }
        : { rule: 'FAR 91.155 Class E at or above 10,000 ft MSL', visibility: sm(5), cloudClearance: high, ceiling: null };
    case 'G':
    case 'uncontrolled':
      if (q.altitudeAgl <= 1200) {
        return q.night
          ? { rule: 'FAR 91.155 Class G ≤1,200 ft AGL, night', visibility: sm(3), cloudClearance: std, ceiling: null }
          : { rule: 'FAR 91.155 Class G ≤1,200 ft AGL, day', visibility: sm(1), cloudClearance: null, ceiling: null };
      }
      if (q.altitudeMsl < 10000) {
        return q.night
          ? { rule: 'FAR 91.155 Class G >1,200 ft AGL, <10,000 ft MSL, night', visibility: sm(3), cloudClearance: std, ceiling: null }
          : { rule: 'FAR 91.155 Class G >1,200 ft AGL, <10,000 ft MSL, day', visibility: sm(1), cloudClearance: std, ceiling: null };
      }
      return { rule: 'FAR 91.155 Class G >1,200 ft AGL, ≥10,000 ft MSL', visibility: sm(5), cloudClearance: high, ceiling: null };
  }
}

export function vfrMinima(q: VfrMinimaQuery): VfrMinima {
  return q.jurisdiction === 'CA' ? canada(q) : unitedStates(q);
}

/** ISO country → jurisdiction; `null` where no table exists yet. */
export function jurisdictionOf(country: string | null): Jurisdiction | null {
  if (country === 'CA') return 'CA';
  if (country === 'US') return 'US';
  return null;
}
