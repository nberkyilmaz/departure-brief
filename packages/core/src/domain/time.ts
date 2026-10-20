/**
 * Time is Zulu everywhere inside the domain. Local time exists only at the
 * display edge. Nothing in this module knows about time zones.
 */

/** A day-of-month plus UTC hour and minute, as reports encode it (`141851Z`). */
export interface DayTime {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** Day-of-month plus UTC hour, as TAF validity periods encode it (`1418/1518`). */
export interface DayHour {
  readonly day: number;
  readonly hour: number;
}

/**
 * Resolve a report's `ddhhmm` to a full UTC instant, given a reference instant
 * (normally the time the report was fetched).
 *
 * Reports carry no month or year. The rule is: the most recent month in which
 * the given day-of-month falls at or before the reference instant. A report
 * time slightly after the reference (clock skew, reports timestamped ahead)
 * is tolerated up to `toleranceMinutes` and resolved in the current month.
 *
 * Returns `null` if the day does not exist in any candidate month (e.g. day 31
 * when neither the reference month nor the previous two have 31 days).
 */
export function resolveDayTime(
  dt: DayTime,
  reference: Date,
  toleranceMinutes = 120,
): Date | null {
  const refMs = reference.getTime();
  const tolMs = toleranceMinutes * 60_000;
  // Walk back month by month from the reference month.
  for (let back = 0; back < 3; back++) {
    const y = reference.getUTCFullYear();
    const m = reference.getUTCMonth() - back;
    const candidate = new Date(Date.UTC(y, m, dt.day, dt.hour, dt.minute));
    // Date.UTC rolls over invalid days (Feb 30 → Mar 2); reject those.
    if (candidate.getUTCDate() !== dt.day) continue;
    if (candidate.getTime() <= refMs + tolMs) return candidate;
  }
  return null;
}

/**
 * Resolve a forecast group's `ddhh[mm]` to the instant *nearest* a reference
 * (normally the TAF's issue time). Forecast times lie hours to a day and a
 * half either side of issue, so unlike `resolveDayTime` this does not assume
 * the past. Hour 24 means the end of the day (00:00 of the next).
 */
export function resolveNearestDayTime(dt: DayTime, reference: Date): Date | null {
  const refMs = reference.getTime();
  let best: Date | null = null;
  for (let back = -1; back <= 1; back++) {
    const y = reference.getUTCFullYear();
    const m = reference.getUTCMonth() + back;
    const hour = dt.hour === 24 ? 0 : dt.hour;
    const candidate = new Date(Date.UTC(y, m, dt.day, hour, dt.minute));
    if (candidate.getUTCDate() !== dt.day) continue;
    if (dt.hour === 24) candidate.setTime(candidate.getTime() + 24 * 3_600_000);
    if (best === null || Math.abs(candidate.getTime() - refMs) < Math.abs(best.getTime() - refMs)) best = candidate;
  }
  return best;
}

/** ISO 8601 with an explicit `Z`, milliseconds dropped. */
export function toZulu(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
