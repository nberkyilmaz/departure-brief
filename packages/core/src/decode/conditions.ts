/**
 * Forecast conditions: the run of groups that follows a TAF change indicator
 * or a METAR trend indicator. Wind, visibility, weather, sky, low-level wind
 * shear, icing, turbulence, altimeter. Shared by the TAF decoder (every
 * period) and the METAR decoder (`TEMPO`/`BECMG` trend sections).
 */

import type { DayTime } from '../domain/time.js';
import type { Celsius, Feet, FeetAgl } from '../domain/units.js';
import { celsius, feet, ftAgl } from '../domain/units.js';
import { parseAltimeter, type Altimeter } from './groups/pressure.js';
import { parseSky, type SkyCondition } from './groups/sky.js';
import { parseVisibility, type Visibility } from './groups/visibility.js';
import { parseWeather, type WeatherGroup } from './groups/weather.js';
import { decodeWindCode, parseWind, type Wind } from './groups/wind.js';
import { joinSpans, sourced, type Sourced } from './span.js';
import type { Token } from './tokenizer.js';
import type { Section, UnparsedToken } from './unparsed.js';

/** `WS020/18040KT` — wind shear at 2,000 ft AGL with the wind above it. */
export interface LowLevelWindShear {
  readonly height: FeetAgl;
  readonly wind: Wind;
}

/** `TX35/0722Z`, `TNM03/0805Z` — forecast maximum/minimum and when. */
export interface TafTemperature {
  readonly kind: 'max' | 'min';
  readonly value: Celsius;
  readonly at: DayTime;
}

/** Military `6IhhhT`: icing type, base, and layer depth. Codes transcribed, not interpreted. */
export interface IcingGroup {
  readonly type: number;
  readonly base: FeetAgl;
  readonly depth: Feet;
}

/** Military `5BhhhT`: turbulence intensity, base, and layer depth. */
export interface TurbulenceGroup {
  readonly intensity: number;
  readonly base: FeetAgl;
  readonly depth: Feet;
}

export interface Conditions {
  readonly wind: Sourced<Wind> | null;
  readonly visibility: Sourced<Visibility> | null;
  readonly weather: readonly Sourced<WeatherGroup>[];
  /** `NSW` — significant weather ends. */
  readonly noSignificantWeather: Sourced<'NSW'> | null;
  readonly sky: readonly Sourced<SkyCondition>[];
  readonly windShear: Sourced<LowLevelWindShear> | null;
  readonly icing: readonly Sourced<IcingGroup>[];
  readonly turbulence: readonly Sourced<TurbulenceGroup>[];
  /** `QNH2992INS` at military stations. */
  readonly altimeter: Sourced<Altimeter> | null;
}

export interface ConditionsResult {
  readonly conditions: Conditions;
  /** `TX`/`TN` groups are TAF-wide, so they are returned apart from the conditions. */
  readonly temperatures: readonly Sourced<TafTemperature>[];
  readonly unparsed: readonly UnparsedToken[];
}

export const EMPTY_CONDITIONS: Conditions = {
  wind: null,
  visibility: null,
  weather: [],
  noSignificantWeather: null,
  sky: [],
  windShear: null,
  icing: [],
  turbulence: [],
  altimeter: null,
};

const ORDER = ['wind', 'visibility', 'phenomena', 'windShear', 'supplementary', 'temperature'] as const;
type State = (typeof ORDER)[number];
const REPEATABLE: ReadonlySet<State> = new Set(['phenomena', 'supplementary', 'temperature']);

const WIND_SHEAR = /^WS(\d{3})\/(\d{3}(?:\d{2,3})(?:G\d{2,3})?(?:KT|MPS|KMH))$/;
const ICING = /^6(\d)(\d{3})(\d)$/;
const TURBULENCE = /^5(\d)(\d{3})(\d)$/;
const TEMPERATURE = /^T([XN])(M?\d{2})\/(\d{2})(\d{2})Z$/;

/** `TX35/0722Z` → max 35 °C at day 7 22Z; `TNM03/0805Z` → min -3 °C. */
export function decodeTafTemperature(text: string): TafTemperature | null {
  const m = TEMPERATURE.exec(text);
  if (!m) return null;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  if (day < 1 || day > 31 || hour > 24) return null;
  const n = Number(m[2]!.replace('M', '-'));
  return { kind: m[1] === 'X' ? 'max' : 'min', value: celsius(n === 0 ? 0 : n), at: { day, hour, minute: 0 } };
}

interface Draft {
  wind: Sourced<Wind> | null;
  visibility: Sourced<Visibility> | null;
  weather: Sourced<WeatherGroup>[];
  noSignificantWeather: Sourced<'NSW'> | null;
  sky: Sourced<SkyCondition>[];
  windShear: Sourced<LowLevelWindShear> | null;
  icing: Sourced<IcingGroup>[];
  turbulence: Sourced<TurbulenceGroup>[];
  altimeter: Sourced<Altimeter> | null;
  temperatures: Sourced<TafTemperature>[];
}

function tryState(
  state: State,
  tokens: readonly Token[],
  i: number,
  d: Draft,
  allowTemperatures: boolean,
): number | null {
  const t = tokens[i]!;
  const put = <T>(value: T, consumed: number): Sourced<T> =>
    sourced(value, joinSpans(t, tokens[i + consumed - 1]!));

  switch (state) {
    case 'wind': {
      const r = parseWind(tokens, i);
      if (!r) return null;
      d.wind = put(r.value, r.consumed);
      return r.consumed;
    }
    case 'visibility': {
      const r = parseVisibility(tokens, i);
      if (!r) return null;
      d.visibility = put(r.value, r.consumed);
      return r.consumed;
    }
    case 'phenomena': {
      if (t.text === 'NSW') {
        d.noSignificantWeather = put('NSW', 1);
        return 1;
      }
      const w = parseWeather(tokens, i);
      if (w) {
        d.weather.push(put(w.value, w.consumed));
        return w.consumed;
      }
      const s = parseSky(tokens, i);
      if (s) {
        d.sky.push(put(s.value, s.consumed));
        return s.consumed;
      }
      return null;
    }
    case 'windShear': {
      const m = WIND_SHEAR.exec(t.text);
      const wind = m ? decodeWindCode(m[2]!) : null;
      if (!m || !wind) return null;
      d.windShear = put({ height: ftAgl(Number(m[1]) * 100), wind }, 1);
      return 1;
    }
    case 'supplementary': {
      const ice = ICING.exec(t.text);
      if (ice) {
        d.icing.push(put({ type: Number(ice[1]), base: ftAgl(Number(ice[2]) * 100), depth: feet(Number(ice[3]) * 1000) }, 1));
        return 1;
      }
      const turb = TURBULENCE.exec(t.text);
      if (turb) {
        d.turbulence.push(
          put({ intensity: Number(turb[1]), base: ftAgl(Number(turb[2]) * 100), depth: feet(Number(turb[3]) * 1000) }, 1),
        );
        return 1;
      }
      const alt = parseAltimeter(tokens, i);
      if (alt && d.altimeter === null) {
        d.altimeter = put(alt.value, alt.consumed);
        return alt.consumed;
      }
      return null;
    }
    case 'temperature': {
      if (!allowTemperatures) return null;
      const temp = decodeTafTemperature(t.text);
      if (!temp) return null;
      d.temperatures.push(put(temp, 1));
      return 1;
    }
  }
}

/**
 * Parse the conditions in `tokens[start, end)`. Same forward-only state
 * machine as the METAR body: an out-of-order or unknown group is preserved
 * as unparsed. With `allowTemperatures` false (METAR trends), `TX`/`TN`
 * groups are unparsed rather than silently accepted.
 */
export function parseConditions(
  tokens: readonly Token[],
  start: number,
  end: number,
  section: Section = 'body',
  allowTemperatures = true,
): ConditionsResult {
  const d: Draft = {
    wind: null,
    visibility: null,
    weather: [],
    noSignificantWeather: null,
    sky: [],
    windShear: null,
    icing: [],
    turbulence: [],
    altimeter: null,
    temperatures: [],
  };
  const unparsed: UnparsedToken[] = [];
  let state = 0;
  let i = start;
  while (i < end) {
    let consumed: number | null = null;
    for (let s = state; s < ORDER.length; s++) {
      const st = ORDER[s]!;
      consumed = tryState(st, tokens, i, d, allowTemperatures);
      if (consumed !== null) {
        // A multi-token group must not run past the end of this range.
        if (i + consumed > end) {
          consumed = null;
          break;
        }
        state = REPEATABLE.has(st) ? s : s + 1;
        break;
      }
    }
    if (consumed === null) {
      const t = tokens[i]!;
      unparsed.push({ text: t.text, span: { start: t.start, end: t.end }, section });
      i++;
    } else {
      i += consumed;
    }
  }
  const { temperatures, ...conditions } = d;
  return { conditions, temperatures, unparsed };
}
