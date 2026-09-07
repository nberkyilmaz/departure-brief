import type { DegreesTrue } from '../../domain/units.js';
import { degTrue } from '../../domain/units.js';
import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

export type WindUnit = 'KT' | 'MPS' | 'KMH';

/**
 * A surface wind group, e.g. `28016G24KT`, `VRB03KT`, `00000KT`, `12010MPS`,
 * optionally followed by a variable-direction range `280V350`.
 *
 * Speeds are in `unit` as reported. METAR winds are referenced to true north.
 */
export interface Wind {
  /** Degrees true; `'VRB'` for variable; `null` when reported missing (`///`). */
  readonly direction: DegreesTrue | 'VRB' | null;
  /** In `unit`. `null` when reported missing (`//`). */
  readonly speed: number | null;
  readonly gust: number | null;
  readonly unit: WindUnit;
  /** From a following `dddVddd` group; both present or both `null`. */
  readonly variableFrom: DegreesTrue | null;
  readonly variableTo: DegreesTrue | null;
}

const WIND = /^(\d{3}|VRB|\/\/\/)(\d{2,3}|\/\/)(?:G(\d{2,3}|\/\/))?(KT|KTS|MPS|KMH)$/;
const VARIATION = /^(\d{3})V(\d{3})$/;

function direction(s: string): DegreesTrue | 'VRB' | null | undefined {
  if (s === 'VRB') return 'VRB';
  if (s === '///') return null;
  const n = Number(s);
  return n <= 360 ? degTrue(n) : undefined;
}

/** Decode a bare wind code with no variation group. Shared with TAF wind-shear groups. */
export function decodeWindCode(text: string): Wind | null {
  const m = WIND.exec(text);
  if (!m) return null;
  const dir = direction(m[1]!);
  if (dir === undefined) return null;
  const speed = m[2] === '//' ? null : Number(m[2]);
  const gust = m[3] === undefined || m[3] === '//' ? null : Number(m[3]);
  const unit: WindUnit = m[4] === 'KTS' ? 'KT' : (m[4] as WindUnit);
  return { direction: dir, speed, gust, unit, variableFrom: null, variableTo: null };
}

export function parseWind(tokens: readonly Token[], index: number): GroupMatch<Wind> {
  const t = tokens[index];
  if (!t) return null;
  const wind = decodeWindCode(t.text);
  if (!wind) return null;

  const next = tokens[index + 1];
  const v = next ? VARIATION.exec(next.text) : null;
  if (v && Number(v[1]) <= 360 && Number(v[2]) <= 360) {
    return matched(
      { ...wind, variableFrom: degTrue(Number(v[1])), variableTo: degTrue(Number(v[2])) },
      2,
    );
  }
  return matched(wind, 1);
}
