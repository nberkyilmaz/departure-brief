/**
 * What the handbook tells the rules engine.
 *
 * The demonstrated crosswind is a limitation, not a weight-and-balance
 * figure, but it is printed in the same handbook and read by the same
 * pipeline — so once it has been verified against the page, the crosswind
 * check can use it and cite the line it came from, instead of the pilot
 * typing it in and hoping.
 */
import type { Knots } from '../domain/units.js';
import type { AircraftLimits } from '../domain/profile.js';
import type { WeightBalanceSpec } from './types.js';

/**
 * Fill in what the aircraft file does not state from what the handbook
 * does. A figure typed into `aircraft/<type>.json` always wins: it is the
 * owner speaking about their own aeroplane, which may carry a placard the
 * handbook does not.
 */
export function withHandbookLimits(limits: AircraftLimits, spec: WeightBalanceSpec | null): AircraftLimits {
  if (!spec || limits.demonstratedCrosswind !== null) return limits;
  const x = spec.demonstratedCrosswindKt;
  if (!x || !(x.value > 0)) return limits;
  return {
    ...limits,
    demonstratedCrosswind: x.value as Knots,
    demonstratedCrosswindSource: x.source
      ? { filename: x.source.filename, page: x.source.page, citedText: x.source.citedText, sha256: x.source.documentSha256 }
      : { filename: spec.source?.filename ?? 'the handbook', page: 0, citedText: x.note ?? 'entered by hand', sha256: null },
  };
}
