import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

/**
 * ICAO runway state group (Annex 3 pre-GRF form, still issued by many
 * states): `R24/000062`, `R24/CLRD70`, `R88/SNOCLO`, `R/SNOCLO`.
 *
 * `runway` is the designator as written; `88` means all runways and `99`
 * means a repeat of the previous report. Codes are transcribed, not
 * interpreted: deposit 0–9, extent 1/2/5/9, depth in mm (or coded above 90),
 * friction coefficient ×100 or braking-action codes 91–99.
 */
export interface RunwayState {
  readonly runway: string | null;
  /** `SNOCLO` — aerodrome closed due to snow. */
  readonly closed: boolean;
  /** `CLRD` — contamination has been cleared. */
  readonly cleared: boolean;
  readonly deposit: number | null;
  readonly extent: number | null;
  readonly depth: number | null;
  readonly friction: number | null;
}

const STATE = /^R(\d{2}[LRC]?)?\/(?:(SNOCLO)|(CLRD)(\d{2}|\/\/)|([\d/])([\d/])(\d{2}|\/\/)(\d{2}|\/\/))$/;

const num = (s: string | undefined): number | null => (s === undefined || s.includes('/') ? null : Number(s));

export function parseRunwayState(tokens: readonly Token[], index: number): GroupMatch<RunwayState> {
  const t = tokens[index];
  if (!t) return null;
  const m = STATE.exec(t.text);
  if (!m) return null;
  return matched({
    runway: m[1] ?? null,
    closed: m[2] === 'SNOCLO',
    cleared: m[3] === 'CLRD',
    deposit: num(m[5]),
    extent: num(m[6]),
    depth: num(m[7]),
    friction: num(m[3] ? m[4] : m[8]),
  });
}
