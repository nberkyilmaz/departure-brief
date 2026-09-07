import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

export type WeatherIntensity = 'light' | 'moderate' | 'heavy';

export const DESCRIPTORS = ['MI', 'BC', 'PR', 'DR', 'BL', 'SH', 'TS', 'FZ'] as const;
export type WeatherDescriptor = (typeof DESCRIPTORS)[number];

export const PHENOMENA = [
  // precipitation
  'DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP',
  // obscuration
  'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY',
  // other
  'PO', 'SQ', 'FC', 'SS', 'DS',
] as const;
export type WeatherPhenomenon = (typeof PHENOMENA)[number];

/**
 * A present-weather group: `[intensity or VC] [descriptor] phenomena+`,
 * e.g. `-RA`, `+TSRA`, `VCSH`, `FZFG`, `-SHRASN`, `TS`, `+FC`.
 *
 * `moderate` is the default when no `-` or `+` is present, as the codes
 * define it; `vicinity` and intensity are mutually exclusive in practice but
 * both are transcribed if both appear.
 */
export interface WeatherGroup {
  readonly intensity: WeatherIntensity;
  readonly vicinity: boolean;
  readonly descriptor: WeatherDescriptor | null;
  readonly phenomena: readonly WeatherPhenomenon[];
}

const DESCRIPTOR_SET: ReadonlySet<string> = new Set(DESCRIPTORS);
const PHENOMENA_SET: ReadonlySet<string> = new Set(PHENOMENA);

/** `TS` stands alone; `SH` stands alone only in the vicinity form (`VCSH`). */
function standalone(descriptor: WeatherDescriptor, vicinity: boolean): boolean {
  return descriptor === 'TS' || (descriptor === 'SH' && vicinity);
}

/**
 * Decode a bare weather code with no token context. Shared with remarks
 * (`RAB05E30`) and recent-weather (`RERA`) parsing.
 */
export function decodeWeatherCode(code: string): WeatherGroup | null {
  let rest = code;
  let intensity: WeatherIntensity = 'moderate';
  let vicinity = false;
  if (rest.startsWith('-')) {
    intensity = 'light';
    rest = rest.slice(1);
  } else if (rest.startsWith('+')) {
    intensity = 'heavy';
    rest = rest.slice(1);
  }
  if (rest.startsWith('VC')) {
    vicinity = true;
    rest = rest.slice(2);
  }
  if (rest.length === 0 || rest.length % 2 !== 0) return null;

  let descriptor: WeatherDescriptor | null = null;
  const phenomena: WeatherPhenomenon[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const code2 = rest.slice(i, i + 2);
    if (i === 0 && DESCRIPTOR_SET.has(code2)) {
      descriptor = code2 as WeatherDescriptor;
    } else if (PHENOMENA_SET.has(code2)) {
      phenomena.push(code2 as WeatherPhenomenon);
    } else {
      return null;
    }
  }
  if (phenomena.length === 0 && !(descriptor && standalone(descriptor, vicinity))) {
    return null;
  }
  return { intensity, vicinity, descriptor, phenomena };
}

export function parseWeather(tokens: readonly Token[], index: number): GroupMatch<WeatherGroup> {
  const t = tokens[index];
  if (!t) return null;
  const w = decodeWeatherCode(t.text);
  return w ? matched(w) : null;
}
