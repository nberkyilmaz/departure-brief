import type { DayTime } from '../../domain/time.js';
import type { Conditions, TafTemperature } from '../conditions.js';
import type { ValidityPeriod } from '../groups/time.js';
import type { Sourced, Span } from '../span.js';
import type { UnparsedToken } from '../unparsed.js';

/**
 * How a period relates to the forecast.
 *
 * - `base` — the prevailing conditions from the start of validity.
 * - `FM` — a new prevailing state from an instant (`FM071500`); it runs until
 *   the next `FM` or the end of validity, so `validity.to` is `null`.
 * - `BECMG` — a gradual change to the prevailing state over the window.
 * - `TEMPO` / `INTER` — temporary fluctuations within the window; they
 *   qualify the prevailing state, they do not replace it.
 * - `PROB` — a standalone probability period (US practice).
 *
 * `probability` is non-null for `PROB` and for a `TEMPO`/`INTER` preceded by
 * `PROB30`/`PROB40`. Resolving these into a timeline is the resolver's job.
 */
export type PeriodKind = 'base' | 'FM' | 'BECMG' | 'TEMPO' | 'INTER' | 'PROB';

export interface PeriodValidity {
  readonly from: DayTime;
  /** `null` for `FM` periods: they run until superseded. */
  readonly to: DayTime | null;
}

export interface TafPeriod {
  readonly kind: PeriodKind;
  readonly probability: 30 | 40 | null;
  /** The indicator words (`PROB30 TEMPO`, `FM071500`); `null` for the base period. */
  readonly indicator: Sourced<string> | null;
  /**
   * For the base period this references the header validity group. `null`
   * when the indicator was not followed by a valid time group.
   */
  readonly validity: Sourced<PeriodValidity> | null;
  readonly conditions: Conditions;
  /** From the indicator (or first condition token) to the last token of the period. */
  readonly span: Span;
}

export type TafModifier = 'AMD' | 'COR';

/** `NIL` — no forecast; `CNL` — the forecast is cancelled. */
export type TafStatus = 'NIL' | 'CNL';

export interface TafRemarks {
  /** From `RMK` through the end of the report. Tokens are kept in `unparsed`. */
  readonly span: Span;
}

/**
 * Free-text trailers that follow the last period, mostly at US and military
 * stations. Transcribed as text; the kind comes from the leading keyword.
 *
 * - `amendment` — `AMD NOT SKED`, `AMD LTD TO CLD VIS AND WIND TIL 0812`,
 *   `LAST NO AMDS AFT 0702 NEXT 070800`, `AMD 0712`
 * - `correction` — `COR 0712`
 * - `metwatch` — `AUTOMATED SENSOR METWATCH 0708 TIL 0718`
 * - `forecaster` — `FN00298`, `FS00298`
 */
export interface TafNotice {
  readonly kind: 'amendment' | 'correction' | 'metwatch' | 'forecaster';
  readonly text: string;
}

/**
 * A literal, span-annotated transcription of one TAF. Periods are in report
 * order, base first when present. Nothing is resolved: `FM` periods have no
 * end, overlays keep their own windows.
 */
export interface DecodedTaf {
  readonly raw: string;
  readonly reportType: Sourced<'TAF'> | null;
  readonly modifiers: readonly Sourced<TafModifier>[];
  readonly station: Sourced<string> | null;
  readonly issued: Sourced<DayTime> | null;
  readonly validity: Sourced<ValidityPeriod> | null;
  readonly status: Sourced<TafStatus> | null;
  readonly periods: readonly TafPeriod[];
  /** `TX`/`TN` groups wherever they appeared, inside a period or in the trailer. */
  readonly temperatures: readonly Sourced<TafTemperature>[];
  /** Trailer notices after the last period, in order. */
  readonly notices: readonly Sourced<TafNotice>[];
  readonly remarks: TafRemarks | null;
  readonly unparsed: readonly UnparsedToken[];
}
