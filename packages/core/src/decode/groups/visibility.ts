import type { Meters, StatuteMiles } from '../../domain/units.js';
import { meters, sm } from '../../domain/units.js';
import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

export type VisibilityQualifier = 'lessThan' | 'greaterThan';

export type Visibility =
  | {
      readonly kind: 'statute';
      readonly miles: StatuteMiles;
      /** `M1/4SM` → `lessThan`; `P6SM` → `greaterThan`. */
      readonly qualifier: VisibilityQualifier | null;
    }
  | {
      readonly kind: 'meters';
      /** Literal value; `9999` conventionally means 10 km or more, `0000` less than 50 m. */
      readonly meters: Meters;
      /** Direction suffix (`2000SW`), or `NDV` (no directional variation). */
      readonly direction: string | null;
      /** A following minimum-visibility group, e.g. `4000 1500NE`. */
      readonly minimum: { readonly meters: Meters; readonly direction: string } | null;
    }
  | { readonly kind: 'cavok' }
  | { readonly kind: 'missing' };

const STATUTE_WHOLE = /^([MP])?(\d{1,3})SM$/;
const STATUTE_FRACTION = /^([MP])?(\d{1,2})\/(\d{1,2})SM$/;
const WHOLE_ONLY = /^\d{1,2}$/;
const FRACTION_ONLY = /^(\d{1,2})\/(\d{1,2})SM$/;
const METRIC = /^(\d{4})(NDV|NE|NW|SE|SW|N|E|S|W)?$/;
const METRIC_MINIMUM = /^(\d{4})(NE|NW|SE|SW|N|E|S|W)$/;

function qualifier(s: string | undefined): VisibilityQualifier | null {
  if (s === 'M') return 'lessThan';
  if (s === 'P') return 'greaterThan';
  return null;
}

/**
 * Prevailing visibility: `10SM`, `1/2SM`, `M1/4SM`, `P6SM`, `1 1/2SM` (two
 * tokens), `9999`, `0800`, `2000SW`, `CAVOK`, `////`.
 *
 * Some feeds emit `1 1/2SM` with the space dropped (`11/2SM`, `21/2SM`).
 * Fractions are only reported below 3 SM, so a fraction whose numerator is at
 * least its denominator has exactly one valid reading: leading digit is the
 * whole-mile part. That case is handled explicitly rather than guessed at.
 */
export function parseVisibility(tokens: readonly Token[], index: number): GroupMatch<Visibility> {
  const t = tokens[index];
  if (!t) return null;
  const text = t.text;

  if (text === 'CAVOK') return matched({ kind: 'cavok' });
  if (text === '////' || text === '////SM') return matched({ kind: 'missing' });

  // `1 1/2SM` — whole miles followed by a fraction token.
  if (WHOLE_ONLY.test(text)) {
    const next = tokens[index + 1];
    const f = next ? FRACTION_ONLY.exec(next.text) : null;
    if (f && Number(f[2]) > 0) {
      return matched(
        { kind: 'statute', miles: sm(Number(text) + Number(f[1]) / Number(f[2])), qualifier: null },
        2,
      );
    }
    return null;
  }

  const whole = STATUTE_WHOLE.exec(text);
  if (whole) {
    return matched({ kind: 'statute', miles: sm(Number(whole[2])), qualifier: qualifier(whole[1]) });
  }

  const frac = STATUTE_FRACTION.exec(text);
  if (frac) {
    const den = Number(frac[3]);
    if (den === 0) return null;
    let numText = frac[2]!;
    let wholePart = 0;
    if (numText.length === 2 && Number(numText) >= den) {
      wholePart = Number(numText[0]);
      numText = numText[1]!;
    }
    return matched({
      kind: 'statute',
      miles: sm(wholePart + Number(numText) / den),
      qualifier: qualifier(frac[1]),
    });
  }

  const metric = METRIC.exec(text);
  if (metric) {
    let minimum: { meters: Meters; direction: string } | null = null;
    let consumed = 1;
    const next = tokens[index + 1];
    const mm = next ? METRIC_MINIMUM.exec(next.text) : null;
    if (mm) {
      minimum = { meters: meters(Number(mm[1])), direction: mm[2]! };
      consumed = 2;
    }
    return matched(
      { kind: 'meters', meters: meters(Number(metric[1])), direction: metric[2] ?? null, minimum },
      consumed,
    );
  }

  return null;
}
