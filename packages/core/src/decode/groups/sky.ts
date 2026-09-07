import type { FeetAgl } from '../../domain/units.js';
import { ftAgl } from '../../domain/units.js';
import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

export type CloudAmount = 'FEW' | 'SCT' | 'BKN' | 'OVC';
export type CloudType = 'CB' | 'TCU';

export type SkyCondition =
  /** `CLR` (no clouds below 12,000 ft, automated), `SKC`, `NSC`, `NCD`. */
  | { readonly kind: 'clear'; readonly code: 'CLR' | 'SKC' | 'NSC' | 'NCD' }
  | {
      readonly kind: 'layer';
      /** `null` when reported `///` (automated station could not determine amount, e.g. `///TCU`). */
      readonly amount: CloudAmount | null;
      /** Base in feet AGL; `null` when reported `///`. */
      readonly base: FeetAgl | null;
      readonly type: CloudType | null;
    }
  /** Vertical visibility into an obscuration; `null` height when `///`. */
  | { readonly kind: 'verticalVisibility'; readonly height: FeetAgl | null }
  /** `//////` or `/////////` — sky information not available. */
  | { readonly kind: 'missing' };

const LAYER = /^(FEW|SCT|BKN|OVC|\/{3})(\d{3}|\/{3})?(CB|TCU|\/{3})?$/;
const VV = /^VV(\d{3}|\/{3})$/;
const CLEAR = /^(CLR|SKC|NSC|NCD)$/;

function height(s: string): FeetAgl | null {
  return s === '///' ? null : ftAgl(Number(s) * 100);
}

export function parseSky(tokens: readonly Token[], index: number): GroupMatch<SkyCondition> {
  const t = tokens[index];
  if (!t) return null;
  const text = t.text;

  const clear = CLEAR.exec(text);
  if (clear) return matched({ kind: 'clear', code: clear[1] as 'CLR' | 'SKC' | 'NSC' | 'NCD' });

  const vv = VV.exec(text);
  if (vv) return matched({ kind: 'verticalVisibility', height: height(vv[1]!) });

  const layer = LAYER.exec(text);
  if (layer) {
    const amount = layer[1] === '///' ? null : (layer[1] as CloudAmount);
    const base = layer[2] === undefined ? null : height(layer[2]);
    const type = layer[3] === 'CB' || layer[3] === 'TCU' ? layer[3] : null;
    // A real amount needs a base group; `///` may stand alone before a type.
    if (amount !== null && layer[2] === undefined) return null;
    if (amount === null && base === null) {
      // `///` alone is not a group; `//////` and `/////////` mean sky not available.
      if (type === null) return layer[2] === undefined ? null : matched({ kind: 'missing' });
    }
    return matched({ kind: 'layer', amount, base, type });
  }
  return null;
}
