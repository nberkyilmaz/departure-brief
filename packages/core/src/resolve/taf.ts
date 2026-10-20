/**
 * TAF period selection: what does this forecast say for one instant?
 *
 * The prevailing state at `t` is the base period, replaced wholesale by each
 * `FM` at or before `t`, and amended element by element by each `BECMG`
 * whose window has already ended. Everything else that covers `t` — a
 * `BECMG` still in its window, `TEMPO`, `INTER`, `PROB` — is an *overlay*:
 * merged onto the prevailing state so it can be evaluated, but returned
 * separately so it never replaces it. That is the conservative reading the
 * rules engine needs: a `TEMPO` below minimums makes a leg marginal, not go.
 *
 * Every element in the result keeps its span into the TAF text.
 */

import { resolveNearestDayTime } from '../domain/time.js';
import type { Conditions } from '../decode/conditions.js';
import type { DecodedTaf, PeriodKind, TafPeriod } from '../decode/taf/index.js';

export interface PeriodWindow {
  readonly period: TafPeriod;
  readonly from: Date;
  /** `FM` periods end where the next `FM` begins, or at the end of validity. */
  readonly to: Date;
}

export interface Overlay {
  readonly kind: Exclude<PeriodKind, 'base' | 'FM'>;
  readonly probability: 30 | 40 | null;
  readonly window: PeriodWindow;
  /** Prevailing conditions with this period's elements applied. */
  readonly conditions: Conditions;
}

export interface ResolvedForecast {
  readonly at: Date;
  readonly station: string | null;
  readonly raw: string;
  readonly issued: Date;
  readonly validity: { readonly from: Date; readonly to: Date } | null;
  /** `t` is outside the TAF's validity; `prevailing` is then `null`. */
  readonly outsideValidity: boolean;
  readonly prevailing: {
    readonly conditions: Conditions;
    /** The periods that produced it, in application order (base, then FM/BECMG). */
    readonly sources: readonly PeriodWindow[];
  } | null;
  readonly overlays: readonly Overlay[];
  /** Periods that could not be placed in time (no valid time group) — surfaced, never dropped. */
  readonly unplaced: readonly TafPeriod[];
}

/**
 * Apply a change period's elements onto a base. A given element replaces;
 * an absent one inherits. `NSW` clears weather; any sky group replaces the
 * whole sky.
 */
export function mergeConditions(base: Conditions, change: Conditions): Conditions {
  return {
    wind: change.wind ?? base.wind,
    visibility: change.visibility ?? base.visibility,
    weather: change.noSignificantWeather ? [] : change.weather.length > 0 ? change.weather : base.weather,
    noSignificantWeather: change.noSignificantWeather ?? (change.weather.length > 0 ? null : base.noSignificantWeather),
    sky: change.sky.length > 0 ? change.sky : base.sky,
    windShear: change.windShear ?? base.windShear,
    icing: change.icing.length > 0 ? change.icing : base.icing,
    turbulence: change.turbulence.length > 0 ? change.turbulence : base.turbulence,
    altimeter: change.altimeter ?? base.altimeter,
  };
}

/** Place every period on the clock. Returns windows in report order plus the periods that could not be placed. */
export function periodWindows(taf: DecodedTaf, issued: Date): { windows: PeriodWindow[]; unplaced: TafPeriod[] } {
  const at = (d: { day: number; hour: number; minute: number }) => resolveNearestDayTime(d, issued);
  const validityTo = taf.validity ? at(taf.validity.value.to) : null;
  const windows: PeriodWindow[] = [];
  const unplaced: TafPeriod[] = [];
  // FM periods end at the next FM; find each one's successor first.
  const fmStarts = taf.periods
    .map((p) => (p.kind === 'FM' && p.validity ? at(p.validity.value.from) : null))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  for (const period of taf.periods) {
    const v = period.validity?.value;
    const from = v ? at(v.from) : null;
    if (!v || !from) {
      unplaced.push(period);
      continue;
    }
    let to: Date | null;
    if (period.kind === 'FM') {
      to = fmStarts.find((d) => d.getTime() > from.getTime()) ?? validityTo;
    } else if (period.kind === 'base') {
      to = fmStarts[0] ?? validityTo;
    } else {
      to = v.to ? at(v.to) : null;
    }
    if (!to) {
      unplaced.push(period);
      continue;
    }
    windows.push({ period, from, to });
  }
  return { windows, unplaced };
}

const covers = (w: PeriodWindow, t: Date) => w.from.getTime() <= t.getTime() && t.getTime() < w.to.getTime();

/** Resolve a decoded TAF at instant `t`. `issued` anchors the day-of-month groups to a calendar. */
export function resolveTaf(taf: DecodedTaf, issued: Date, t: Date): ResolvedForecast {
  const { windows, unplaced } = periodWindows(taf, issued);
  const validity =
    taf.validity && resolveNearestDayTime(taf.validity.value.from, issued) && resolveNearestDayTime(taf.validity.value.to, issued)
      ? {
          from: resolveNearestDayTime(taf.validity.value.from, issued)!,
          to: resolveNearestDayTime(taf.validity.value.to, issued)!,
        }
      : null;
  const common = { at: t, station: taf.station?.value ?? null, raw: taf.raw, issued, validity, unplaced };

  const outside = validity !== null && (t.getTime() < validity.from.getTime() || t.getTime() >= validity.to.getTime());
  if (outside || taf.status !== null) {
    return { ...common, outsideValidity: outside, prevailing: null, overlays: [] };
  }

  // Pass 1: the prevailing state, in report order.
  let state: Conditions | null = null;
  const sources: PeriodWindow[] = [];
  for (const w of windows) {
    const { period } = w;
    if (period.kind === 'base') {
      state = period.conditions;
      sources.push(w);
    } else if (period.kind === 'FM' && w.from.getTime() <= t.getTime()) {
      state = period.conditions;
      sources.splice(0, sources.length, w);
    } else if (period.kind === 'BECMG' && w.to.getTime() <= t.getTime() && state) {
      state = mergeConditions(state, period.conditions);
      sources.push(w);
    }
  }
  if (!state) {
    return { ...common, outsideValidity: false, prevailing: null, overlays: [] };
  }

  // Pass 2: overlays covering t, merged onto the final prevailing state.
  const overlays: Overlay[] = [];
  for (const w of windows) {
    const { period } = w;
    if (period.kind === 'base' || period.kind === 'FM' || !covers(w, t)) continue;
    overlays.push({
      kind: period.kind,
      probability: period.probability,
      window: w,
      conditions: mergeConditions(state, period.conditions),
    });
  }

  return { ...common, outsideValidity: false, prevailing: { conditions: state, sources }, overlays };
}
