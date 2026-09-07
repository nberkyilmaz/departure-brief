import type { HectoPascals, InchesHg } from '../../domain/units.js';
import { hPa, inHg } from '../../domain/units.js';
import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

/** Altimeter setting: `A3012` (inHg ×100), `Q1013` (hPa), `QNH2992INS`. */
export type Altimeter =
  | { readonly unit: 'inHg'; readonly value: InchesHg | null }
  | { readonly unit: 'hPa'; readonly value: HectoPascals | null };

const INHG = /^A(\d{4}|\/{4})$/;
const HPA = /^Q(\d{4}|\/{4})$/;
const QNH_INS = /^QNH(\d{4})INS$/;

export function parseAltimeter(tokens: readonly Token[], index: number): GroupMatch<Altimeter> {
  const t = tokens[index];
  if (!t) return null;
  const a = INHG.exec(t.text) ?? QNH_INS.exec(t.text);
  if (a) return matched({ unit: 'inHg', value: a[1] === '////' ? null : inHg(Number(a[1]) / 100) });
  const q = HPA.exec(t.text);
  if (q) return matched({ unit: 'hPa', value: q[1] === '////' ? null : hPa(Number(q[1])) });
  return null;
}
