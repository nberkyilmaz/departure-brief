import type { DayTime } from '../../domain/time.js';
import type { Conditions } from '../conditions.js';
import type { Altimeter } from '../groups/pressure.js';
import type { RunwayState } from '../groups/runwayState.js';
import type { RunwayVisualRange } from '../groups/rvr.js';
import type { SkyCondition } from '../groups/sky.js';
import type { TemperatureGroup } from '../groups/temperature.js';
import type { Visibility } from '../groups/visibility.js';
import type { WeatherGroup } from '../groups/weather.js';
import type { Wind } from '../groups/wind.js';
import type { Sourced, Span } from '../span.js';
import type { Remark } from './remarks.js';

export type { Section, UnparsedToken } from '../unparsed.js';

export type ReportType = 'METAR' | 'SPECI';

/**
 * `AUTO` — fully automated; `COR` — correction (also `CCA`, `CCB`… in Canada);
 * `NIL` — report missing; `RTD` — routine delayed.
 */
export type Modifier = 'AUTO' | 'COR' | 'NIL' | 'RTD';

/** `WS ALL RWY`, `WS RWY22`, `WS R22L`. */
export interface WindShear {
  readonly runway: string | 'ALL';
}

export type TrendIndicator = 'NOSIG' | 'TEMPO' | 'BECMG';

/** `FM1200`, `TL1300`, `AT1230` — the time bounds of an ICAO trend, hours and minutes UTC. */
export interface TrendTime {
  readonly hour: number;
  readonly minute: number;
}

/**
 * An ICAO trend forecast: `NOSIG`, or `TEMPO`/`BECMG` with optional
 * `FM`/`TL`/`AT` bounds and the conditions expected. Runs to the next
 * indicator or `RMK`.
 */
export interface MetarTrend {
  readonly indicator: TrendIndicator;
  readonly from: Sourced<TrendTime> | null;
  readonly until: Sourced<TrendTime> | null;
  readonly at: Sourced<TrendTime> | null;
  readonly conditions: Conditions;
}

export interface Remarks {
  /** From `RMK` through the end of the report. */
  readonly span: Span;
  readonly items: readonly Sourced<Remark>[];
}

/**
 * A literal, span-annotated transcription of one METAR or SPECI.
 *
 * Every field is either decoded from a specific span of `raw`, or `null` /
 * empty when the report does not contain that group. Anything the decoder
 * did not recognise is in `unparsed`, never dropped. No field is derived or
 * interpreted here — see `derive.ts` for ceiling, flight category, etc.
 */
export interface DecodedMetar {
  readonly raw: string;
  readonly reportType: Sourced<ReportType> | null;
  readonly station: Sourced<string> | null;
  readonly time: Sourced<DayTime> | null;
  readonly modifiers: readonly Sourced<Modifier>[];
  readonly wind: Sourced<Wind> | null;
  readonly visibility: Sourced<Visibility> | null;
  readonly rvr: readonly Sourced<RunwayVisualRange>[];
  readonly weather: readonly Sourced<WeatherGroup>[];
  readonly sky: readonly Sourced<SkyCondition>[];
  readonly temperature: Sourced<TemperatureGroup> | null;
  readonly altimeter: Sourced<Altimeter> | null;
  /** A second altimeter in the other unit, e.g. `Q1010 A2983`. */
  readonly altimeterAlternate: Sourced<Altimeter> | null;
  /** `RERA`, `RETS` — recent weather since the last report. */
  readonly recentWeather: readonly Sourced<WeatherGroup>[];
  readonly windShear: readonly Sourced<WindShear>[];
  readonly runwayState: readonly Sourced<RunwayState>[];
  /** Each trend's span covers its indicator, time bounds and conditions. */
  readonly trends: readonly Sourced<MetarTrend>[];
  readonly remarks: Remarks | null;
  readonly unparsed: readonly import('../unparsed.js').UnparsedToken[];
}
