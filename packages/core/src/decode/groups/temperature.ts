import type { Celsius } from '../../domain/units.js';
import { celsius } from '../../domain/units.js';
import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

/** Temperature and dew point, whole degrees: `09/M04`, `M02/M05`, `09/`, `//`-parts. */
export interface TemperatureGroup {
  readonly temperature: Celsius | null;
  readonly dewpoint: Celsius | null;
}

const TEMP = /^(M?\d{2}|\/\/)?\/(M?\d{2}|\/\/)?$/;

/** `M04` → -4; `M00` → 0 (a reading between -0.5 and 0). */
export function decodeSignedWhole(s: string | undefined): Celsius | null {
  if (s === undefined || s === '//') return null;
  const n = Number(s.replace('M', '-'));
  return celsius(n === 0 ? 0 : n);
}

export function parseTemperature(tokens: readonly Token[], index: number): GroupMatch<TemperatureGroup> {
  const t = tokens[index];
  if (!t) return null;
  const m = TEMP.exec(t.text);
  if (!m) return null;
  const temperature = decodeSignedWhole(m[1]);
  const dewpoint = decodeSignedWhole(m[2]);
  // A bare `/`, `//`, `///` is not a temperature group.
  if (temperature === null && dewpoint === null) return null;
  return matched({ temperature, dewpoint });
}
