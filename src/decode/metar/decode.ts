import type { DayTime } from '../../domain/time.js';
import { EMPTY_CONDITIONS, parseConditions } from '../conditions.js';
import type { GroupMatch } from '../groups/match.js';
import { matched } from '../groups/match.js';
import { parseAltimeter, type Altimeter } from '../groups/pressure.js';
import { parseRunwayState, type RunwayState } from '../groups/runwayState.js';
import { parseRvr, type RunwayVisualRange } from '../groups/rvr.js';
import { parseSky, type SkyCondition } from '../groups/sky.js';
import { parseTemperature, type TemperatureGroup } from '../groups/temperature.js';
import { parseDayTime } from '../groups/time.js';
import { parseVisibility, type Visibility } from '../groups/visibility.js';
import { decodeWeatherCode, parseWeather, type WeatherGroup } from '../groups/weather.js';
import { parseWind, type Wind } from '../groups/wind.js';
import { joinSpans, sourced, type Sourced, type Span } from '../span.js';
import { tokenize, type Token } from '../tokenizer.js';
import type { Section, UnparsedToken } from '../unparsed.js';
import { parseRemark, type Remark } from './remarks.js';
import type {
  DecodedMetar,
  MetarTrend,
  Modifier,
  Remarks,
  ReportType,
  TrendIndicator,
  TrendTime,
  WindShear,
} from './types.js';

/**
 * Bump when decoder output changes shape or meaning for the same input.
 * Stored alongside decoded rows so re-decoding is a deliberate act.
 */
export const METAR_DECODER_VERSION = 2;

/**
 * Body group order per FMH-1 chapter 12 and ICAO Annex 3. The decoder walks
 * this list forward: at each token it tries the current state and every
 * later state, in order, and takes the first that matches. It never goes
 * back, so a group appearing out of order is preserved as unparsed rather
 * than guessed at. Weather and sky share one state because both repeat and
 * real reports interleave them. Modifiers (`AUTO`, `COR`, `NIL`) are not a
 * state: they appear before or after the time group in practice, so they are
 * accepted anywhere ahead of the wind group.
 */
const ORDER = [
  'type',
  'station',
  'time',
  'wind',
  'visibility',
  'rvr',
  'phenomena',
  'temperature',
  'altimeter',
  'supplementary',
] as const;
type BodyState = (typeof ORDER)[number];

const REPEATABLE: ReadonlySet<BodyState> = new Set(['rvr', 'phenomena', 'supplementary']);
const WIND_STATE = ORDER.indexOf('wind');

const STATION = /^[A-Z][A-Z0-9]{3}$/;
const MODIFIER = /^(AUTO|COR|NIL|RTD|CC[A-Z])$/;
const WIND_SHEAR_RUNWAY = /^(?:RWY|R)(\d{2}[LRC]?)$/;
const RECENT_WEATHER = /^RE([A-Z]{2,6})$/;
const TREND = /^(NOSIG|TEMPO|BECMG)$/;
const TREND_TIME = /^(FM|TL|AT)(\d{2})(\d{2})$/;

interface Draft {
  reportType: Sourced<ReportType> | null;
  station: Sourced<string> | null;
  time: Sourced<DayTime> | null;
  modifiers: Sourced<Modifier>[];
  wind: Sourced<Wind> | null;
  visibility: Sourced<Visibility> | null;
  rvr: Sourced<RunwayVisualRange>[];
  weather: Sourced<WeatherGroup>[];
  sky: Sourced<SkyCondition>[];
  temperature: Sourced<TemperatureGroup> | null;
  altimeter: Sourced<Altimeter> | null;
  altimeterAlternate: Sourced<Altimeter> | null;
  recentWeather: Sourced<WeatherGroup>[];
  windShear: Sourced<WindShear>[];
  runwayState: Sourced<RunwayState>[];
  trends: Sourced<MetarTrend>[];
  remarks: Remarks | null;
  unparsed: UnparsedToken[];
}

function spanOf(tokens: readonly Token[], index: number, consumed: number): Span {
  const first = tokens[index]!;
  const last = tokens[index + consumed - 1]!;
  return joinSpans(first, last);
}

function unparsed(d: Draft, t: Token, section: Section): void {
  d.unparsed.push({ text: t.text, span: { start: t.start, end: t.end }, section });
}

function parseWindShear(tokens: readonly Token[], i: number): GroupMatch<WindShear> {
  if (tokens[i]?.text !== 'WS') return null;
  const a = tokens[i + 1]?.text;
  if (a === 'ALL' && tokens[i + 2]?.text === 'RWY') return matched({ runway: 'ALL' }, 3);
  if (a === 'RWY') {
    const m = /^(\d{2}[LRC]?)$/.exec(tokens[i + 2]?.text ?? '');
    if (m) return matched({ runway: m[1]! }, 3);
  }
  const m = a === undefined ? null : WIND_SHEAR_RUNWAY.exec(a);
  return m ? matched({ runway: m[1]! }, 2) : null;
}

/**
 * Try one body state at a token. Returns how many tokens were consumed, or
 * `null` if the token is not that kind of group. Mutates `d` on success.
 */
function tryState(state: BodyState, tokens: readonly Token[], i: number, d: Draft): number | null {
  const t = tokens[i]!;
  const put = <T>(value: T, consumed: number): Sourced<T> => sourced(value, spanOf(tokens, i, consumed));

  switch (state) {
    case 'type': {
      if (t.text !== 'METAR' && t.text !== 'SPECI') return null;
      d.reportType = put(t.text, 1);
      return 1;
    }
    case 'station': {
      if (!STATION.test(t.text)) return null;
      d.station = put(t.text, 1);
      return 1;
    }
    case 'time': {
      const r = parseDayTime(tokens, i);
      if (!r) return null;
      d.time = put(r.value, r.consumed);
      return r.consumed;
    }
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
    case 'rvr': {
      const r = parseRvr(tokens, i);
      if (!r) return null;
      d.rvr.push(put(r.value, r.consumed));
      return r.consumed;
    }
    case 'phenomena': {
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
    case 'temperature': {
      const r = parseTemperature(tokens, i);
      if (!r) return null;
      d.temperature = put(r.value, r.consumed);
      return r.consumed;
    }
    case 'altimeter': {
      const r = parseAltimeter(tokens, i);
      if (!r) return null;
      d.altimeter = put(r.value, r.consumed);
      return r.consumed;
    }
    case 'supplementary': {
      const ws = parseWindShear(tokens, i);
      if (ws) {
        d.windShear.push(put(ws.value, ws.consumed));
        return ws.consumed;
      }
      const re = RECENT_WEATHER.exec(t.text);
      const recent = re ? decodeWeatherCode(re[1]!) : null;
      if (recent) {
        d.recentWeather.push(put(recent, 1));
        return 1;
      }
      const rs = parseRunwayState(tokens, i);
      if (rs) {
        d.runwayState.push(put(rs.value, rs.consumed));
        return rs.consumed;
      }
      // A second altimeter in the other unit (`Q1010 A2983`).
      const alt = parseAltimeter(tokens, i);
      if (alt && d.altimeter && d.altimeterAlternate === null && alt.value.unit !== d.altimeter.value.unit) {
        d.altimeterAlternate = put(alt.value, alt.consumed);
        return alt.consumed;
      }
      return null;
    }
  }
}

/**
 * Parse one trend section starting at the indicator token `start`, running
 * to `end` (exclusive): optional `FM`/`TL`/`AT` bounds, then conditions.
 */
function parseTrend(tokens: readonly Token[], start: number, end: number, d: Draft): void {
  const indicator = tokens[start]!.text as TrendIndicator;
  let from: Sourced<TrendTime> | null = null;
  let until: Sourced<TrendTime> | null = null;
  let at: Sourced<TrendTime> | null = null;
  let i = start + 1;
  for (; i < end; i++) {
    const m = TREND_TIME.exec(tokens[i]!.text);
    if (!m) break;
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 24 || minute > 59) break;
    const s = sourced({ hour, minute }, { start: tokens[i]!.start, end: tokens[i]!.end });
    if (m[1] === 'FM') from = s;
    else if (m[1] === 'TL') until = s;
    else at = s;
  }
  const result = indicator === 'NOSIG' && i >= end
    ? { conditions: EMPTY_CONDITIONS, unparsed: [] as UnparsedToken[] }
    : parseConditions(tokens, i, end, 'trend', false);
  d.unparsed.push(...result.unparsed);
  d.trends.push(
    sourced({ indicator, from, until, at, conditions: result.conditions }, joinSpans(tokens[start]!, tokens[end - 1]!)),
  );
}

function parseRemarks(tokens: readonly Token[], rmkIndex: number, d: Draft): void {
  const items: Sourced<Remark>[] = [];
  const last = tokens[tokens.length - 1]!;
  let i = rmkIndex + 1;
  while (i < tokens.length) {
    const r = parseRemark(tokens, i);
    if (r) {
      items.push(sourced(r.value, spanOf(tokens, i, r.consumed)));
      i += r.consumed;
    } else {
      unparsed(d, tokens[i]!, 'remarks');
      i++;
    }
  }
  d.remarks = { span: joinSpans(tokens[rmkIndex]!, last), items };
}

/**
 * Decode one METAR or SPECI. Total: never throws on any input string, and
 * every token of the input is accounted for in exactly one output field or
 * in `unparsed`. Deterministic: the same input always yields the same output.
 */
export function decodeMetar(raw: string): DecodedMetar {
  const tokens = tokenize(raw);
  const d: Draft = {
    reportType: null,
    station: null,
    time: null,
    modifiers: [],
    wind: null,
    visibility: null,
    rvr: [],
    weather: [],
    sky: [],
    temperature: null,
    altimeter: null,
    altimeterAlternate: null,
    recentWeather: [],
    windShear: [],
    runwayState: [],
    trends: [],
    remarks: null,
    unparsed: [],
  };

  let state = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.text === 'RMK') {
      parseRemarks(tokens, i, d);
      break;
    }
    if (TREND.test(t.text)) {
      let end = i + 1;
      while (end < tokens.length && !TREND.test(tokens[end]!.text) && tokens[end]!.text !== 'RMK') end++;
      parseTrend(tokens, i, end, d);
      state = ORDER.length - 1;
      i = end;
      continue;
    }
    const modifier = state <= WIND_STATE ? MODIFIER.exec(t.text) : null;
    if (modifier) {
      const mod: Modifier = modifier[1]!.startsWith('CC') ? 'COR' : (modifier[1] as Modifier);
      d.modifiers.push(sourced(mod, { start: t.start, end: t.end }));
      i++;
      continue;
    }
    let consumed: number | null = null;
    for (let s = state; s < ORDER.length; s++) {
      const st = ORDER[s]!;
      consumed = tryState(st, tokens, i, d);
      if (consumed !== null) {
        state = REPEATABLE.has(st) ? s : s + 1;
        break;
      }
    }
    if (consumed === null) {
      unparsed(d, t, 'body');
      i++;
    } else {
      i += consumed;
    }
  }

  return { raw, ...d };
}
