/**
 * What a season of verified forecasts says about a station.
 *
 * The number that matters to a pilot is not "how often was the TAF right",
 * which is unanswerable without a tolerance nobody agrees on. It is which
 * way the TAF is wrong when it is wrong: a forecast that promises a better
 * ceiling than arrives is the one that gets people airborne into weather
 * they did not plan for. So every pair is scored for direction, and the
 * summary leads with how often the forecast was **optimistic**.
 */
import type { FlightCategory } from '../decode/metar/derive.js';
import type { VerificationPair } from './types.js';

/** A ceiling difference smaller than this is scanner noise, not a miss. */
export const CEILING_TOLERANCE_FT = 200;
/** Likewise for visibility. */
export const VISIBILITY_TOLERANCE_SM = 0.5;

const RANK: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

export type Direction = 'optimistic' | 'pessimistic' | 'close';

export interface ScoredPair {
  readonly station: string;
  readonly validAt: string;
  readonly leadHours: number | null;
  readonly forecast: { readonly ceilingFt: number | null; readonly visibilitySm: number | null; readonly category: FlightCategory | null };
  readonly observed: { readonly ceilingFt: number | null; readonly visibilitySm: number | null; readonly category: FlightCategory | null };
  /** Observed minus forecast. Negative means it turned out lower than promised. */
  readonly ceilingErrorFt: number | null;
  /** Null when the forecast was an open-ended "at least" that the observation met: there is no error to measure. */
  readonly visibilityErrorSm: number | null;
  readonly ceiling: Direction | null;
  readonly visibility: Direction | null;
  readonly categoryMatched: boolean | null;
  /** The prevailing forecast missed the category, but an overlay in the TAF allowed for it. */
  readonly overlayCovered: boolean;
  readonly offsetMinutes: number;
}

function direction(error: number | null, tolerance: number): Direction | null {
  if (error === null) return null;
  if (Math.abs(error) <= tolerance) return 'close';
  // Observed below forecast: the forecast promised better than arrived.
  return error < 0 ? 'optimistic' : 'pessimistic';
}

export function scorePair(p: VerificationPair): ScoredPair {
  const { check: c, outcome: o } = p;
  const ceilingErrorFt = c.ceilingFt !== null && o.ceilingFt !== null ? o.ceilingFt - c.ceilingFt : null;
  /*
   * A forecast of "at least six miles" is satisfied by anything at or above
   * six, so only a shortfall is a miss. Without this every `P6SM` against an
   * observed `10SM` would score as pessimistic, and the visibility column
   * would measure the phrasing of TAFs rather than their accuracy.
   *
   * A satisfied bound also has no error to report: the forecast said six or
   * better and got fifteen, which is not nine miles of being wrong. The two
   * figures are both in the pair for a reader who wants them.
   */
  const rawVisibilityError = c.visibilitySm !== null && o.visibilitySm !== null ? Math.round((o.visibilitySm - c.visibilitySm) * 100) / 100 : null;
  const boundSatisfied = c.visibilityAtLeast && rawVisibilityError !== null && rawVisibilityError >= 0;
  const visibilityErrorSm = boundSatisfied ? null : rawVisibilityError;
  const visibilityDirection = boundSatisfied ? ('close' as Direction) : direction(rawVisibilityError, VISIBILITY_TOLERANCE_SM);
  /*
   * A forecast of "no ceiling" that turns into one is a miss the arithmetic
   * above cannot see, since there is no forecast number to subtract from.
   * The category comparison catches it, so it is not lost.
   */
  const categoryMatched = c.category !== null && o.category !== null ? c.category === o.category : null;
  const overlayCovered =
    categoryMatched === false && o.category !== null && c.overlayWorstCategory !== null && RANK[c.overlayWorstCategory] >= RANK[o.category];
  return {
    station: c.station,
    validAt: c.validAt.toISOString(),
    leadHours: c.leadHours,
    forecast: { ceilingFt: c.ceilingFt, visibilitySm: c.visibilitySm, category: c.category },
    observed: { ceilingFt: o.ceilingFt, visibilitySm: o.visibilitySm, category: o.category },
    ceilingErrorFt,
    visibilityErrorSm,
    ceiling: direction(ceilingErrorFt, CEILING_TOLERANCE_FT),
    visibility: visibilityDirection,
    categoryMatched,
    overlayCovered,
    offsetMinutes: o.offsetMinutes,
  };
}

export interface FieldReliability {
  readonly compared: number;
  readonly optimistic: number;
  readonly pessimistic: number;
  readonly close: number;
  /** Median signed error, observed minus forecast; the typical direction and size of the miss. */
  readonly medianError: number | null;
  readonly worstOptimistic: number | null;
}

export interface StationReliability {
  readonly station: string;
  readonly pairs: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly ceiling: FieldReliability;
  readonly visibility: FieldReliability;
  readonly categoryAgreement: number | null;
  /** Of the category misses, how many the TAF had allowed for in a TEMPO or PROB. */
  readonly overlayCovered: number;
  /** Forecasts that turned out worse than promised, by category — the ones that matter. */
  readonly categoryOptimistic: number;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 100) / 100;
}

function field(scored: readonly ScoredPair[], pick: (p: ScoredPair) => { dir: Direction | null; error: number | null }): FieldReliability {
  const seen = scored.map(pick).filter((x) => x.dir !== null);
  const errors = seen.map((x) => x.error).filter((e): e is number => e !== null);
  const optimisticErrors = seen.filter((x) => x.dir === 'optimistic').map((x) => x.error!);
  return {
    compared: seen.length,
    optimistic: seen.filter((x) => x.dir === 'optimistic').length,
    pessimistic: seen.filter((x) => x.dir === 'pessimistic').length,
    close: seen.filter((x) => x.dir === 'close').length,
    medianError: median(errors),
    worstOptimistic: optimisticErrors.length ? Math.min(...optimisticErrors) : null,
  };
}

export function reliabilityOf(station: string, pairs: readonly VerificationPair[]): StationReliability {
  const scored = pairs.map(scorePair);
  const times = scored.map((s) => s.validAt).sort();
  const categoryPairs = scored.filter((s) => s.categoryMatched !== null);
  return {
    station,
    pairs: scored.length,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    ceiling: field(scored, (p) => ({ dir: p.ceiling, error: p.ceilingErrorFt })),
    visibility: field(scored, (p) => ({ dir: p.visibility, error: p.visibilityErrorSm })),
    categoryAgreement: categoryPairs.length ? categoryPairs.filter((s) => s.categoryMatched).length / categoryPairs.length : null,
    overlayCovered: scored.filter((s) => s.overlayCovered).length,
    categoryOptimistic: scored.filter((s) => s.forecast.category !== null && s.observed.category !== null && RANK[s.observed.category] > RANK[s.forecast.category]).length,
  };
}

const pct = (n: number, of: number) => (of === 0 ? '—' : `${Math.round((n / of) * 100)}%`);

/**
 * The one or two sentences a pilot would want on a briefing. Says nothing
 * at all below a handful of pairs, because a claim about a station drawn
 * from three observations is worse than silence.
 */
export function reliabilityNote(r: StationReliability, minimumPairs = 8): string | null {
  if (r.pairs < minimumPairs) return null;
  const parts: string[] = [];
  if (r.ceiling.compared >= minimumPairs && r.ceiling.optimistic > 0) {
    const share = r.ceiling.optimistic / r.ceiling.compared;
    if (share >= 0.25) {
      parts.push(
        `${r.station} TAFs forecast the ceiling higher than it turned out in ${pct(r.ceiling.optimistic, r.ceiling.compared)} of the last ${r.ceiling.compared} checks${r.ceiling.worstOptimistic !== null ? `, by as much as ${Math.abs(r.ceiling.worstOptimistic)} ft` : ''}.`,
      );
    }
  }
  if (r.visibility.compared >= minimumPairs && r.visibility.optimistic / r.visibility.compared >= 0.25) {
    parts.push(`Visibility came in below forecast in ${pct(r.visibility.optimistic, r.visibility.compared)} of ${r.visibility.compared}.`);
  }
  if (parts.length === 0 && r.categoryAgreement !== null) {
    parts.push(`${r.station} TAFs matched the observed flight category in ${pct(Math.round(r.categoryAgreement * r.pairs), r.pairs)} of the last ${r.pairs} checks.`);
  }
  return parts.join(' ');
}

export function reliabilityText(r: StationReliability): string {
  const lines = [
    `${r.station}: ${r.pairs} forecast${r.pairs === 1 ? '' : 's'} checked against what arrived${r.from ? `, ${r.from.slice(0, 10)} to ${r.to!.slice(0, 10)}` : ''}`,
  ];
  const row = (name: string, f: FieldReliability, unit: string) =>
    `  ${name.padEnd(11)} ${String(f.compared).padStart(3)} compared   optimistic ${pct(f.optimistic, f.compared).padStart(4)}   close ${pct(f.close, f.compared).padStart(4)}   pessimistic ${pct(f.pessimistic, f.compared).padStart(4)}   median ${f.medianError === null ? '—' : `${f.medianError > 0 ? '+' : ''}${f.medianError} ${unit}`}`;
  lines.push(row('ceiling', r.ceiling, 'ft'));
  lines.push(row('visibility', r.visibility, 'SM'));
  if (r.categoryAgreement !== null) lines.push(`  category    ${pct(Math.round(r.categoryAgreement * r.pairs), r.pairs)} agreement, ${r.categoryOptimistic} turned out worse than forecast, ${r.overlayCovered} of those allowed for in a TEMPO or PROB`);
  lines.push('', '  "optimistic" means the forecast promised better than arrived — the direction that matters.');
  const note = reliabilityNote(r);
  if (note) lines.push(`  ${note}`);
  return lines.join('\n');
}
