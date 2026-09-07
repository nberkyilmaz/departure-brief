import type {
  Celsius,
  DegreesTrue,
  Feet,
  FeetAgl,
  HectoPascals,
  Inches,
  Knots,
  StatuteMiles,
} from '../../domain/units.js';
import { celsius, degTrue, feet, ftAgl, hPa, inches, kt, sm } from '../../domain/units.js';
import type { GroupMatch, GroupParser } from '../groups/match.js';
import { matched } from '../groups/match.js';
import { parseAltimeter, type Altimeter } from '../groups/pressure.js';
import type { CloudAmount } from '../groups/sky.js';
import { decodeSignedWhole } from '../groups/temperature.js';
import { decodeWeatherCode, type WeatherGroup } from '../groups/weather.js';
import type { Token } from '../tokenizer.js';

/** Hour is `null` when the remark gives minutes only (`WSHFT 30`, `PK WND 28032/45`). */
export interface RemarkTime {
  readonly hour: number | null;
  readonly minute: number;
}

export type LightningType = 'IC' | 'CC' | 'CG' | 'CA';

export type SensorName = 'TSNO' | 'PNO' | 'RVRNO' | 'FZRANO' | 'PWINO' | 'CHINO' | 'VISNO';

/**
 * The remarks the decoder understands. Anything else after `RMK` is kept as
 * an unparsed token with its span. This set is grown from the corpus by
 * frequency of unparsed tokens; see `scripts/metar-corpus-report.ts`.
 */
export type Remark =
  /** `AO1` / `AO2` (`AO2A` when augmented by an observer). */
  | { readonly kind: 'automatedStationType'; readonly type: 'AO1' | 'AO2'; readonly augmented: boolean }
  /** `SLP198` → 1019.8 hPa; `SLPNO` → `null`. */
  | { readonly kind: 'seaLevelPressure'; readonly pressure: HectoPascals | null }
  /** `A2976` / `Q1013` given in remarks (common outside the US). */
  | { readonly kind: 'altimeter'; readonly altimeter: Altimeter }
  /** `ALSTG ESTMD`. */
  | { readonly kind: 'altimeterEstimated' }
  /** `T00941044` → 9.4 / -4.4 °C, tenths. */
  | { readonly kind: 'preciseTemperature'; readonly temperature: Celsius; readonly dewpoint: Celsius | null }
  /** `PK WND 28032/1845`. */
  | { readonly kind: 'peakWind'; readonly direction: DegreesTrue; readonly speed: Knots; readonly time: RemarkTime }
  /** `WSHFT 1830`, `WSHFT 30 FROPA`. */
  | { readonly kind: 'windShift'; readonly time: RemarkTime; readonly frontalPassage: boolean }
  /** `TWR VIS 1 1/2`, `SFC VIS 3/4`. */
  | { readonly kind: 'towerVisibility'; readonly miles: StatuteMiles }
  | { readonly kind: 'surfaceVisibility'; readonly miles: StatuteMiles }
  /** `VIS 1/2V2`, `VIS M1/4V2`. */
  | {
      readonly kind: 'variableVisibility';
      readonly low: StatuteMiles;
      readonly lowQualifier: 'lessThan' | null;
      readonly high: StatuteMiles;
    }
  /** `CIG 005V010`. */
  | { readonly kind: 'variableCeiling'; readonly low: FeetAgl; readonly high: FeetAgl }
  /** `CIG 021 RWY16` — ceiling at a second sensor site; `CIG 004` alone. */
  | { readonly kind: 'secondSiteCeiling'; readonly height: FeetAgl; readonly location: string | null }
  /** `BKN009 V SCT` — a layer varying between two amounts. */
  | {
      readonly kind: 'variableSky';
      readonly from: CloudAmount;
      readonly base: FeetAgl | null;
      readonly to: CloudAmount;
    }
  /** `FG FEW000` — a surface-based obscuration and how much sky it hides. */
  | {
      readonly kind: 'obscuration';
      readonly weather: WeatherGroup;
      readonly amount: CloudAmount;
      readonly base: FeetAgl;
    }
  /**
   * `P0003` (hourly), `60012` / `6////` (3- or 6-hourly), `70012` (24-hourly).
   * A reported `0000` denotes a trace. `null` inches when indeterminate (`////`).
   */
  | {
      readonly kind: 'precipitation';
      readonly period: 'hourly' | 'threeOrSixHourly' | 'twentyFourHourly';
      readonly inches: Inches | null;
      readonly trace: boolean;
    }
  /** `10094` (6-h max), `20061` (6-h min), `401120084` (24-h max/min). */
  | {
      readonly kind: 'temperatureExtreme';
      readonly period: 'sixHourly' | 'twentyFourHourly';
      readonly max: Celsius | null;
      readonly min: Celsius | null;
    }
  /** `52012` → characteristic 2, +1.2 hPa over 3 h. Characteristics 5–8 are falling. */
  | { readonly kind: 'pressureTendency'; readonly characteristic: number; readonly change: HectoPascals }
  /** `PRESRR` / `PRESFR`. */
  | { readonly kind: 'pressureChangeRapid'; readonly direction: 'rising' | 'falling' }
  /** `RAB05E30SNB30`. */
  | {
      readonly kind: 'weatherTiming';
      readonly events: readonly {
        readonly weather: WeatherGroup;
        readonly event: 'began' | 'ended';
        readonly time: RemarkTime;
      }[];
    }
  /** `OCNL LTG ICCG DSNT NE-SE`. `locations` are the compass/`OHD`/`ALQDS` words as written. */
  | {
      readonly kind: 'lightning';
      readonly frequency: 'OCNL' | 'FRQ' | 'CONS' | null;
      readonly types: readonly LightningType[];
      readonly distant: boolean;
      readonly locations: readonly string[];
      readonly movement: string | null;
    }
  /** `CB DSNT SW MOV NE`, `TS SE MOV NE`, `VIRGA SW`, `ACSL DSNT NE-SE`. */
  | {
      readonly kind: 'phenomenonLocation';
      readonly phenomenon: string;
      readonly distant: boolean;
      readonly locations: readonly string[];
      readonly movement: string | null;
    }
  /** `TSNO`, `PNO`, `CHINO RWY22`… — a sensor is inoperative. */
  | { readonly kind: 'sensorStatus'; readonly sensor: SensorName; readonly location: string | null }
  /** `WND MISG`, `VIS MISG`, `CLD MISG` (Canadian automated stations). */
  | { readonly kind: 'elementMissing'; readonly element: string }
  /** `$` — station needs maintenance. */
  | { readonly kind: 'maintenanceNeeded' }
  | { readonly kind: 'reportSequence'; readonly which: 'FIRST' | 'LAST' }
  /** `4/012` → 12 in. */
  | { readonly kind: 'snowDepth'; readonly inches: Inches }
  /** `SNINCR 2/10` → 2 in in the last hour, 10 in on the ground. */
  | { readonly kind: 'snowIncreasing'; readonly lastHour: Inches; readonly depth: Inches }
  /** `98060` → 60 minutes of sunshine. */
  | { readonly kind: 'sunshine'; readonly minutes: number }
  /** `933036` → 3.6 in water equivalent of snow on the ground. */
  | { readonly kind: 'waterEquivalent'; readonly inches: Inches }
  /** `DENSITY ALT 4300FT` (Canadian stations). */
  | { readonly kind: 'densityAltitude'; readonly altitude: Feet }
  /** `8/530` — low/middle/high cloud type codes; `/` when not observed. */
  | {
      readonly kind: 'cloudTypes';
      readonly low: number | null;
      readonly middle: number | null;
      readonly high: number | null;
    };

type RemarkParser = GroupParser<Remark>;

function text(tokens: readonly Token[], i: number): string | undefined {
  return tokens[i]?.text;
}

function remarkTime(s: string): RemarkTime | null {
  if (s.length === 4) {
    const hour = Number(s.slice(0, 2));
    const minute = Number(s.slice(2));
    return hour <= 24 && minute <= 59 ? { hour, minute } : null;
  }
  const minute = Number(s);
  return minute <= 59 ? { hour: null, minute } : null;
}

/** Negate without producing `-0`, which JSON cannot represent. */
function negate(n: number): number {
  return n === 0 ? 0 : -n;
}

/** `1044` after a sign digit → -4.4. */
function tenths(sign: string, digits: string): Celsius {
  const n = Number(digits) / 10;
  return celsius(sign === '1' ? negate(n) : n);
}

/**
 * Read a statute-mile value from up to two tokens: `2`, `3/4`, `1 1/2`, or
 * the bare `1/2`. Used by the visibility remarks.
 */
function readMiles(tokens: readonly Token[], i: number): { miles: number; consumed: number } | null {
  const a = text(tokens, i);
  if (a === undefined) return null;
  const whole = /^\d{1,2}$/.exec(a);
  const frac = /^(\d{1,2})\/(\d{1,2})$/.exec(a);
  if (whole) {
    const b = text(tokens, i + 1);
    const f = b ? /^(\d{1,2})\/(\d{1,2})$/.exec(b) : null;
    if (f && Number(f[2]) > 0) return { miles: Number(a) + Number(f[1]) / Number(f[2]), consumed: 2 };
    return { miles: Number(a), consumed: 1 };
  }
  if (frac && Number(frac[2]) > 0) return { miles: Number(frac[1]) / Number(frac[2]), consumed: 1 };
  return null;
}

function fraction(s: string): number | null {
  const m = /^(\d{1,2})(?:\/(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  if (m[2] === undefined) return Number(m[1]);
  return Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
}

const COMPASS = 'N|NE|E|SE|S|SW|W|NW';
const LOCATION_WORD = new RegExp(`^(?:${COMPASS})(?:-(?:${COMPASS}))?$|^(?:ALQDS|ALQS|OHD|VC)$`);
const MOVEMENT_WORD = new RegExp(`^(?:${COMPASS})$|^(?:STNRY)$`);

interface Locations {
  readonly distant: boolean;
  readonly locations: string[];
  readonly movement: string | null;
  readonly consumed: number;
}

/**
 * Read a run of location words: `DSNT`, compass points and ranges joined by
 * `AND`/`THRU`, `OHD`, `ALQDS`, then an optional `MOV <dir>`. Stops at the
 * first token that is none of these.
 */
function readLocations(tokens: readonly Token[], start: number): Locations {
  let j = start;
  let distant = false;
  const locations: string[] = [];
  let movement: string | null = null;
  for (;;) {
    const w = text(tokens, j);
    if (w === undefined) break;
    if (w === 'DSNT') distant = true;
    else if (LOCATION_WORD.test(w)) locations.push(w);
    else if ((w === 'AND' || w === 'THRU') && locations.length > 0 && LOCATION_WORD.test(text(tokens, j + 1) ?? '')) {
      // separator between locations
    } else if ((w === 'MOV' || w === 'MOVG') && MOVEMENT_WORD.test(text(tokens, j + 1) ?? '')) {
      movement = text(tokens, j + 1)!;
      j += 2;
      break;
    } else break;
    j++;
  }
  return { distant, locations, movement, consumed: j - start };
}

const automatedStation: RemarkParser = (tokens, i) => {
  const m = /^A[O0]([12])(A)?$/.exec(text(tokens, i) ?? '');
  if (!m) return null;
  return matched({ kind: 'automatedStationType', type: m[1] === '1' ? 'AO1' : 'AO2', augmented: m[2] === 'A' });
};

const seaLevelPressure: RemarkParser = (tokens, i) => {
  const t = text(tokens, i) ?? '';
  if (t === 'SLPNO') return matched({ kind: 'seaLevelPressure', pressure: null });
  const m = /^SLP(\d{3})$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]) / 10;
  return matched({ kind: 'seaLevelPressure', pressure: hPa(v >= 50 ? 900 + v : 1000 + v) });
};

const altimeter: RemarkParser = (tokens, i) => {
  const r = parseAltimeter(tokens, i);
  return r && r.value.value !== null ? matched({ kind: 'altimeter', altimeter: r.value }) : null;
};

const altimeterEstimated: RemarkParser = (tokens, i) =>
  text(tokens, i) === 'ALSTG' && text(tokens, i + 1) === 'ESTMD' ? matched({ kind: 'altimeterEstimated' }, 2) : null;

const preciseTemperature: RemarkParser = (tokens, i) => {
  const m = /^T([01])(\d{3})(?:([01])(\d{3})|\/{4})?$/.exec(text(tokens, i) ?? '');
  if (!m) return null;
  return matched({
    kind: 'preciseTemperature',
    temperature: tenths(m[1]!, m[2]!),
    dewpoint: m[3] !== undefined && m[4] !== undefined ? tenths(m[3], m[4]) : null,
  });
};

const peakWind: RemarkParser = (tokens, i) => {
  if (text(tokens, i) !== 'PK' || text(tokens, i + 1) !== 'WND') return null;
  const m = /^(\d{3})(\d{2,3})\/(\d{4}|\d{2})$/.exec(text(tokens, i + 2) ?? '');
  if (!m || Number(m[1]) > 360) return null;
  const time = remarkTime(m[3]!);
  if (!time) return null;
  return matched(
    { kind: 'peakWind', direction: degTrue(Number(m[1])), speed: kt(Number(m[2])), time },
    3,
  );
};

const windShift: RemarkParser = (tokens, i) => {
  if (text(tokens, i) !== 'WSHFT') return null;
  const m = /^(\d{4}|\d{2})$/.exec(text(tokens, i + 1) ?? '');
  if (!m) return null;
  const time = remarkTime(m[1]!);
  if (!time) return null;
  const fropa = text(tokens, i + 2) === 'FROPA';
  return matched({ kind: 'windShift', time, frontalPassage: fropa }, fropa ? 3 : 2);
};

const locationVisibility: RemarkParser = (tokens, i) => {
  const where = text(tokens, i);
  if ((where !== 'TWR' && where !== 'SFC') || text(tokens, i + 1) !== 'VIS') return null;
  const v = readMiles(tokens, i + 2);
  if (!v) return null;
  return matched(
    { kind: where === 'TWR' ? 'towerVisibility' : 'surfaceVisibility', miles: sm(v.miles) },
    2 + v.consumed,
  );
};

const variableVisibility: RemarkParser = (tokens, i) => {
  if (text(tokens, i) !== 'VIS') return null;
  let j = i + 1;
  let lowWhole = 0;
  // `VIS 2 1/2V4` — a whole-mile token before the V group.
  const lead = text(tokens, j);
  if (lead !== undefined && /^\d{1,2}$/.test(lead) && (text(tokens, j + 1) ?? '').includes('V')) {
    lowWhole = Number(lead);
    j++;
  }
  const m = /^(M?)(\d{1,2}(?:\/\d{1,2})?)V(\d{1,2}(?:\/\d{1,2})?)$/.exec(text(tokens, j) ?? '');
  if (!m) return null;
  const lowFrac = fraction(m[2]!);
  let high = fraction(m[3]!);
  if (lowFrac === null || high === null) return null;
  j++;
  // `VIS 3/4V1 1/2` — a trailing fraction token completing the high value.
  const tail = text(tokens, j);
  if (tail !== undefined && !m[3]!.includes('/') && /^\d{1,2}\/\d{1,2}$/.test(tail)) {
    const f = fraction(tail);
    if (f !== null) {
      high += f;
      j++;
    }
  }
  return matched(
    {
      kind: 'variableVisibility',
      low: sm(lowWhole + lowFrac),
      lowQualifier: m[1] === 'M' ? 'lessThan' : null,
      high: sm(high),
    },
    j - i,
  );
};

const CEILING_LOCATION = /^(?:RWY|RY)\d{2}[LRC]?$|^(?:N|NE|E|SE|S|SW|W|NW)$/;

const ceilingRemark: RemarkParser = (tokens, i) => {
  if (text(tokens, i) !== 'CIG') return null;
  const next = text(tokens, i + 1) ?? '';
  const variable = /^(\d{3})V(\d{3})$/.exec(next);
  if (variable) {
    return matched(
      { kind: 'variableCeiling', low: ftAgl(Number(variable[1]) * 100), high: ftAgl(Number(variable[2]) * 100) },
      2,
    );
  }
  const fixed = /^(\d{3})$/.exec(next);
  if (!fixed) return null;
  const loc = text(tokens, i + 2);
  const hasLocation = loc !== undefined && CEILING_LOCATION.test(loc);
  return matched(
    { kind: 'secondSiteCeiling', height: ftAgl(Number(fixed[1]) * 100), location: hasLocation ? loc : null },
    hasLocation ? 3 : 2,
  );
};

const AMOUNT = /^(FEW|SCT|BKN|OVC)$/;

const variableSky: RemarkParser = (tokens, i) => {
  const from = /^(FEW|SCT|BKN|OVC)(\d{3})?$/.exec(text(tokens, i) ?? '');
  if (!from || text(tokens, i + 1) !== 'V') return null;
  const to = AMOUNT.exec(text(tokens, i + 2) ?? '');
  if (!to) return null;
  return matched(
    {
      kind: 'variableSky',
      from: from[1] as CloudAmount,
      base: from[2] === undefined ? null : ftAgl(Number(from[2]) * 100),
      to: to[1] as CloudAmount,
    },
    3,
  );
};

const OBSCURATION_LAYER = /^(FEW|SCT|BKN|OVC)(\d{3})$/;

const obscuration: RemarkParser = (tokens, i) => {
  const weather = decodeWeatherCode(text(tokens, i) ?? '');
  if (!weather || weather.phenomena.length === 0) return null;
  const layer = OBSCURATION_LAYER.exec(text(tokens, i + 1) ?? '');
  if (!layer) return null;
  return matched(
    { kind: 'obscuration', weather, amount: layer[1] as CloudAmount, base: ftAgl(Number(layer[2]) * 100) },
    2,
  );
};

const precipitation: RemarkParser = (tokens, i) => {
  const m = /^([P67])(\d{4}|\/{4})$/.exec(text(tokens, i) ?? '');
  if (!m) return null;
  const period =
    m[1] === 'P' ? 'hourly' : m[1] === '6' ? 'threeOrSixHourly' : 'twentyFourHourly';
  const raw = m[2] === '////' ? null : Number(m[2]);
  return matched({
    kind: 'precipitation',
    period,
    inches: raw === null ? null : inches(raw / 100),
    trace: raw === 0,
  });
};

const temperatureExtreme: RemarkParser = (tokens, i) => {
  const t = text(tokens, i) ?? '';
  const six = /^([12])([01])(\d{3})$/.exec(t);
  if (six) {
    const v = tenths(six[2]!, six[3]!);
    return matched({
      kind: 'temperatureExtreme',
      period: 'sixHourly',
      max: six[1] === '1' ? v : null,
      min: six[1] === '2' ? v : null,
    });
  }
  const day = /^4([01])(\d{3})([01])(\d{3})$/.exec(t);
  if (day) {
    return matched({
      kind: 'temperatureExtreme',
      period: 'twentyFourHourly',
      max: tenths(day[1]!, day[2]!),
      min: tenths(day[3]!, day[4]!),
    });
  }
  return null;
};

const pressureTendency: RemarkParser = (tokens, i) => {
  const m = /^5([0-8])(\d{3})$/.exec(text(tokens, i) ?? '');
  if (!m) return null;
  const characteristic = Number(m[1]);
  const magnitude = Number(m[2]) / 10;
  return matched({
    kind: 'pressureTendency',
    characteristic,
    change: hPa(characteristic >= 5 ? negate(magnitude) : magnitude),
  });
};

const pressureChangeRapid: RemarkParser = (tokens, i) => {
  const t = text(tokens, i);
  if (t === 'PRESRR') return matched({ kind: 'pressureChangeRapid', direction: 'rising' });
  if (t === 'PRESFR') return matched({ kind: 'pressureChangeRapid', direction: 'falling' });
  return null;
};

/**
 * `RAB05E30SNB30`: one or more weather codes, each followed by one or more
 * `B`/`E` + `mm` or `hhmm` events. Any failure to consume the whole token
 * means it is not a timing group.
 */
export function decodeWeatherTiming(
  token: string,
): { weather: WeatherGroup; event: 'began' | 'ended'; time: RemarkTime }[] | null {
  const events: { weather: WeatherGroup; event: 'began' | 'ended'; time: RemarkTime }[] = [];
  let current: WeatherGroup | null = null;
  let rest = token;
  while (rest.length > 0) {
    const ev = current ? /^([BE])(\d{4}|\d{2})/.exec(rest) : null;
    if (ev) {
      const time = remarkTime(ev[2]!);
      if (!time) return null;
      events.push({ weather: current!, event: ev[1] === 'B' ? 'began' : 'ended', time });
      rest = rest.slice(ev[0].length);
      continue;
    }
    const ph = /^([A-Z+-]+?)(?=[BE]\d{2})/.exec(rest);
    if (!ph) return null;
    current = decodeWeatherCode(ph[1]!);
    if (!current) return null;
    rest = rest.slice(ph[1]!.length);
  }
  return events.length > 0 ? events : null;
}

const weatherTiming: RemarkParser = (tokens, i) => {
  const t = text(tokens, i) ?? '';
  if (!/[BE]\d{2}/.test(t)) return null;
  const events = decodeWeatherTiming(t);
  return events ? matched({ kind: 'weatherTiming', events }) : null;
};

const LIGHTNING_TYPES = /^((?:IC|CC|CG|CA)+)$/;

function splitLightningTypes(s: string): LightningType[] {
  return (s.match(/IC|CC|CG|CA/g) ?? []) as LightningType[];
}

const lightning: RemarkParser = (tokens, i) => {
  let j = i;
  let frequency: 'OCNL' | 'FRQ' | 'CONS' | null = null;
  const first = text(tokens, j);
  if (first === 'OCNL' || first === 'FRQ' || first === 'CONS') {
    frequency = first;
    j++;
  }
  const ltg = /^LTG((?:IC|CC|CG|CA)+)?$/.exec(text(tokens, j) ?? '');
  if (!ltg) return null;
  j++;
  const types: LightningType[] = ltg[1] ? splitLightningTypes(ltg[1]) : [];
  const t = text(tokens, j);
  if (types.length === 0 && t !== undefined && LIGHTNING_TYPES.test(t)) {
    types.push(...splitLightningTypes(t));
    j++;
  }
  const loc = readLocations(tokens, j);
  j += loc.consumed;
  return matched(
    { kind: 'lightning', frequency, types, distant: loc.distant, locations: loc.locations, movement: loc.movement },
    j - i,
  );
};

/** Cloud and weather words that take a location in remarks. */
const LOCATED_PHENOMENON =
  /^(CB|TCU|CBMAM|ACSL|ACC|SCSL|CCSL|ROTOR|VIRGA|TS|SH|SHRA|SHSN|RA|SN|DZ|FG|BR|HZ|FU|DU|BLSN|BLDU|FC|TORNADO|WATERSPOUT|FUNNEL)$/;

const phenomenonLocation: RemarkParser = (tokens, i) => {
  const m = LOCATED_PHENOMENON.exec(text(tokens, i) ?? '');
  if (!m) return null;
  const loc = readLocations(tokens, i + 1);
  // Everything except VIRGA needs at least one location word to be a location remark.
  if (loc.consumed === 0 && m[1] !== 'VIRGA') return null;
  return matched(
    {
      kind: 'phenomenonLocation',
      phenomenon: m[1]!,
      distant: loc.distant,
      locations: loc.locations,
      movement: loc.movement,
    },
    1 + loc.consumed,
  );
};

const SENSOR = /^(TSNO|PNO|RVRNO|FZRANO|PWINO|CHINO|VISNO)$/;
const SENSOR_LOCATION = /^(?:RWY|RY|R)\d{2}[LRC]?$|^(?:N|NE|E|SE|S|SW|W|NW|ALQDS|LOC)$/;

const sensorStatus: RemarkParser = (tokens, i) => {
  const m = SENSOR.exec(text(tokens, i) ?? '');
  if (!m) return null;
  const sensor = m[1] as SensorName;
  const next = text(tokens, i + 1);
  const hasLocation =
    (sensor === 'CHINO' || sensor === 'VISNO') && next !== undefined && SENSOR_LOCATION.test(next);
  return matched({ kind: 'sensorStatus', sensor, location: hasLocation ? next : null }, hasLocation ? 2 : 1);
};

const elementMissing: RemarkParser = (tokens, i) => {
  const el = text(tokens, i) ?? '';
  if (!/^[A-Z]{1,5}$/.test(el) || text(tokens, i + 1) !== 'MISG') return null;
  return matched({ kind: 'elementMissing', element: el }, 2);
};

const maintenance: RemarkParser = (tokens, i) =>
  text(tokens, i) === '$' ? matched({ kind: 'maintenanceNeeded' }) : null;

const reportSequence: RemarkParser = (tokens, i) => {
  const t = text(tokens, i);
  if (t === 'FIRST' || t === 'LAST') return matched({ kind: 'reportSequence', which: t });
  return null;
};

const snowDepth: RemarkParser = (tokens, i) => {
  const m = /^4\/(\d{3})$/.exec(text(tokens, i) ?? '');
  return m ? matched({ kind: 'snowDepth', inches: inches(Number(m[1])) }) : null;
};

const snowIncreasing: RemarkParser = (tokens, i) => {
  if (text(tokens, i) !== 'SNINCR') return null;
  const m = /^(\d{1,2})\/(\d{1,3})$/.exec(text(tokens, i + 1) ?? '');
  if (!m) return null;
  return matched({ kind: 'snowIncreasing', lastHour: inches(Number(m[1])), depth: inches(Number(m[2])) }, 2);
};

const sunshine: RemarkParser = (tokens, i) => {
  const m = /^98(\d{3})$/.exec(text(tokens, i) ?? '');
  return m ? matched({ kind: 'sunshine', minutes: Number(m[1]) }) : null;
};

const waterEquivalent: RemarkParser = (tokens, i) => {
  const m = /^933(\d{3})$/.exec(text(tokens, i) ?? '');
  return m ? matched({ kind: 'waterEquivalent', inches: inches(Number(m[1]) / 10) }) : null;
};

const densityAltitude: RemarkParser = (tokens, i) => {
  if (text(tokens, i) !== 'DENSITY' || text(tokens, i + 1) !== 'ALT') return null;
  const m = /^(-?\d{1,6})FT$/.exec(text(tokens, i + 2) ?? '');
  return m ? matched({ kind: 'densityAltitude', altitude: feet(Number(m[1])) }, 3) : null;
};

const cloudTypes: RemarkParser = (tokens, i) => {
  const m = /^8\/([\d/])([\d/])([\d/])$/.exec(text(tokens, i) ?? '');
  if (!m) return null;
  const d = (s: string) => (s === '/' ? null : Number(s));
  return matched({ kind: 'cloudTypes', low: d(m[1]!), middle: d(m[2]!), high: d(m[3]!) });
};

/**
 * Tried in order at each remark token; first match wins. Multi-token parsers
 * that share a leading word (`obscuration` and `phenomenonLocation` both
 * start with a weather code; `variableSky` and `obscuration` both involve a
 * layer) are ordered most-specific first.
 */
const REMARK_PARSERS: readonly RemarkParser[] = [
  automatedStation,
  seaLevelPressure,
  altimeter,
  altimeterEstimated,
  preciseTemperature,
  peakWind,
  windShift,
  locationVisibility,
  variableVisibility,
  ceilingRemark,
  variableSky,
  obscuration,
  precipitation,
  temperatureExtreme,
  pressureTendency,
  pressureChangeRapid,
  weatherTiming,
  lightning,
  phenomenonLocation,
  sensorStatus,
  elementMissing,
  maintenance,
  reportSequence,
  snowDepth,
  snowIncreasing,
  sunshine,
  waterEquivalent,
  densityAltitude,
  cloudTypes,
];

export function parseRemark(tokens: readonly Token[], index: number): GroupMatch<Remark> {
  for (const p of REMARK_PARSERS) {
    const r = p(tokens, index);
    if (r) return r;
  }
  return null;
}

export { decodeSignedWhole };
