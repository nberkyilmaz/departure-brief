import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

export interface RvrValue {
  readonly value: number;
  /** `P` → `greaterThan` (above the sensor's range); `M` → `lessThan`. */
  readonly qualifier: 'lessThan' | 'greaterThan' | null;
}

/**
 * Runway visual range: `R04/P6000FT`, `R22L/1200V2000FT`, `R04/0600N`,
 * `R22/M0200`, `R22/P1500FT/D`, `R30/////FT`.
 */
export interface RunwayVisualRange {
  /** Runway designator as reported: `04`, `22L`. */
  readonly runway: string;
  /** `null` when reported missing (`////`). */
  readonly low: RvrValue | null;
  /** Upper value of a variable range, else `null`. */
  readonly high: RvrValue | null;
  readonly unit: 'FT' | 'M';
  /** ICAO tendency: up, down, no change. */
  readonly trend: 'U' | 'D' | 'N' | null;
}

const RVR = /^R(\d{2}[LRC]?)\/([PM])?(\d{4}|\/{4})(?:V([PM])?(\d{4}))?(FT)?(?:\/?([UDN]))?$/;

function value(q: string | undefined, v: string | undefined): RvrValue | null {
  if (v === undefined || v === '////') return null;
  return { value: Number(v), qualifier: q === 'P' ? 'greaterThan' : q === 'M' ? 'lessThan' : null };
}

export function parseRvr(tokens: readonly Token[], index: number): GroupMatch<RunwayVisualRange> {
  const t = tokens[index];
  if (!t) return null;
  const m = RVR.exec(t.text);
  if (!m) return null;
  return matched({
    runway: m[1]!,
    low: value(m[2], m[3]),
    high: value(m[4], m[5]),
    unit: m[6] === 'FT' ? 'FT' : 'M',
    trend: (m[7] as 'U' | 'D' | 'N' | undefined) ?? null,
  });
}
