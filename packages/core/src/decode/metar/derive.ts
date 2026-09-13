/**
 * Values derived from a decoded METAR. Kept apart from the decoder so the
 * transcription stays literal; everything here is a deterministic function
 * of it and carries the span it was derived from.
 */

import { resolveDayTime } from '../../domain/time.js';
import type { FeetAgl, Knots, StatuteMiles } from '../../domain/units.js';
import { kmh, kmhToKnots, kt, meters, metersToStatuteMiles, mps, mpsToKnots, sm } from '../../domain/units.js';
import type { SkyCondition } from '../groups/sky.js';
import type { Visibility } from '../groups/visibility.js';
import type { Wind } from '../groups/wind.js';
import type { Sourced } from '../span.js';
import type { DecodedMetar } from './types.js';

/**
 * The ceiling: the lowest broken or overcast layer, or vertical visibility.
 * `null` when there is none reported (which includes an unreported height).
 */
export function ceiling(m: DecodedMetar): Sourced<FeetAgl> | null {
  return ceilingOf(m.sky);
}

/**
 * The same rule over any reported sky, observed or forecast. Verification
 * compares a TAF against a METAR, and the two must be measured the same
 * way or the comparison measures the measuring.
 */
export function ceilingOf(sky: readonly Sourced<SkyCondition>[]): Sourced<FeetAgl> | null {
  let best: Sourced<FeetAgl> | null = null;
  for (const layer of sky) {
    const v = layer.value;
    let h: FeetAgl | null = null;
    if (v.kind === 'layer' && (v.amount === 'BKN' || v.amount === 'OVC')) h = v.base;
    else if (v.kind === 'verticalVisibility') h = v.height;
    if (h !== null && (best === null || h < best.value)) best = { value: h, span: layer.span };
  }
  return best;
}

/**
 * Prevailing visibility in statute miles, for comparison against minimums.
 * `CAVOK` and `9999` both mean 10 km or more and are returned as 10 km in
 * SM. Qualifiers (`M`, `P`) are dropped; callers needing them read the
 * decoded group.
 */
export function visibilityStatuteMiles(v: Visibility): StatuteMiles | null {
  switch (v.kind) {
    case 'statute':
      return v.miles;
    case 'meters':
      return metersToStatuteMiles(v.meters === 9999 ? meters(10000) : v.meters);
    case 'cavok':
      return metersToStatuteMiles(meters(10000));
    case 'missing':
      return null;
  }
}

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';

/**
 * The NWS flight category from ceiling and visibility. `null` when neither is
 * available. A missing ceiling with a reported visibility is treated as
 * unlimited, which is how the category is conventionally computed.
 */
export function flightCategory(m: DecodedMetar): FlightCategory | null {
  return flightCategoryOf(ceiling(m)?.value ?? null, m.visibility ? visibilityStatuteMiles(m.visibility.value) : null);
}

/** The category from a ceiling and visibility already in hand, forecast or observed. */
export function flightCategoryOf(c: FeetAgl | null, vis: StatuteMiles | null): FlightCategory | null {
  if (c === null && vis === null) return null;
  const cv = c ?? Number.POSITIVE_INFINITY;
  const vv = vis ?? sm(Number.POSITIVE_INFINITY);
  if (cv < 500 || vv < 1) return 'LIFR';
  if (cv < 1000 || vv < 3) return 'IFR';
  if (cv <= 3000 || vv <= 5) return 'MVFR';
  return 'VFR';
}

/** Wind speed and gust in knots regardless of the reported unit. */
export function windKnots(w: Wind): { speed: Knots | null; gust: Knots | null } {
  const conv = (n: number | null): Knots | null => {
    if (n === null) return null;
    switch (w.unit) {
      case 'KT':
        return kt(n);
      case 'MPS':
        return mpsToKnots(mps(n));
      case 'KMH':
        return kmhToKnots(kmh(n));
    }
  };
  return { speed: conv(w.speed), gust: conv(w.gust) };
}

/**
 * The observation instant, resolved against a reference instant (normally
 * the fetch time). See `resolveDayTime` for the month-selection rule.
 */
export function observationTime(m: DecodedMetar, reference: Date): Date | null {
  return m.time ? resolveDayTime(m.time.value, reference) : null;
}
