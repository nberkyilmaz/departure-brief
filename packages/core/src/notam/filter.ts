/**
 * Deterministic classification of a NOTAM against a flight, applied before
 * any token is spent on it. Nothing here drops a NOTAM: the result says
 * whether it is in the flight's time window and near the route, and why,
 * and the caller shows everything with the classification attached.
 * Whenever the answer cannot be determined, the conservative answer wins:
 * a schedule that cannot be read counts as active, a NOTAM with no
 * position counts as near.
 */

import { distanceNm, type LatLon } from '../domain/geo.js';
import type { DecodedNotam } from './types.js';

export interface FlightWindow {
  /** First instant that matters (departure, minus any margin the caller wants). */
  readonly start: Date;
  /** Last instant that matters (last ETA, plus margin). */
  readonly end: Date;
}

export type TimeStatus = 'active' | 'not-yet-effective' | 'expired' | 'schedule-inactive' | 'unknown';

export interface NotamClassification {
  readonly time: TimeStatus;
  /** Schedule text was read and applied (`true`), unreadable (`false`), or absent (`null`). */
  readonly scheduleUnderstood: boolean | null;
  /** Nearest route point to the NOTAM's centre; `null` when it has no position. */
  readonly distanceNm: number | null;
  /** Within the NOTAM's own radius (plus margin) of the route, or FIR-wide, or no position. */
  readonly near: boolean;
  /** `time === 'active' && near` — the set worth a model's attention. */
  readonly inScope: boolean;
  readonly reasons: readonly string[];
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

interface Interval {
  readonly start: Date;
  readonly end: Date;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** `0400-1059` on a given UTC day; a range ending before it starts crosses midnight. */
function dayInterval(y: number, m: number, d: number, hhmm: string): Interval | null {
  const r = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(hhmm);
  if (!r) return null;
  const start = new Date(Date.UTC(y, m, d, Number(r[1]), Number(r[2])));
  let end = new Date(Date.UTC(y, m, d, Number(r[3]), Number(r[4])));
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);
  return { start, end };
}

/**
 * Expand a D) schedule into concrete intervals inside the NOTAM's own
 * validity. Understands `DAILY hhmm-hhmm` and `MON dd [dd…] hhmm-hhmm`
 * lists separated by commas. Returns `null` for anything else — the
 * caller then treats the NOTAM as active throughout.
 */
export function scheduleIntervals(schedule: string, validity: Interval): Interval[] | null {
  const text = schedule.replace(/\s+/g, ' ').trim().toUpperCase();
  const out: Interval[] = [];
  const daily = /^DAILY (\d{4}-\d{4})$/.exec(text);
  if (daily) {
    for (let t = Date.UTC(validity.start.getUTCFullYear(), validity.start.getUTCMonth(), validity.start.getUTCDate()); t <= validity.end.getTime(); t += 86_400_000) {
      const d = new Date(t);
      const iv = dayInterval(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), daily[1]!);
      if (!iv) return null;
      if (overlaps(iv, validity)) out.push(iv);
    }
    return out;
  }
  // `SEP 11 14 1100-2100, SEP 15 1000-1800`
  const parts = text.split(/\s*,\s*/);
  const year = validity.start.getUTCFullYear();
  for (const part of parts) {
    const m = /^([A-Z]{3}) ((?:\d{1,2} )+)(\d{4}-\d{4})$/.exec(part.trim());
    if (!m) return null;
    const month = MONTHS[m[1]!];
    if (month === undefined) return null;
    for (const day of m[2]!.trim().split(/\s+/)) {
      // A schedule in January for a NOTAM starting in December belongs to the next year.
      const y = month < validity.start.getUTCMonth() ? year + 1 : year;
      const iv = dayInterval(y, month, Number(day), m[3]!);
      if (!iv) return null;
      out.push(iv);
    }
  }
  return out;
}

export function classifyNotam(n: DecodedNotam, window: FlightWindow, route: readonly LatLon[], marginNm = 5): NotamClassification {
  const reasons: string[] = [];

  // Time.
  let time: TimeStatus = 'unknown';
  let scheduleUnderstood: boolean | null = null;
  const from = n.from ? new Date(n.from.value.iso) : null;
  const to = n.to && !('permanent' in n.to.value) ? new Date(n.to.value.iso) : null;
  if (!from) {
    reasons.push('no start time — treated as active');
    time = 'unknown';
  } else if (from.getTime() > window.end.getTime()) {
    time = 'not-yet-effective';
    reasons.push(`effective from ${n.from!.value.iso}, after the flight`);
  } else if (to && to.getTime() < window.start.getTime()) {
    time = 'expired';
    reasons.push(`ended ${n.to && !('permanent' in n.to.value) ? n.to.value.iso : ''}${n.to && !('permanent' in n.to.value) && n.to.value.estimated ? ' (estimated)' : ''}, before the flight`);
  } else {
    time = 'active';
    if (n.schedule) {
      const validity = { start: from, end: to ?? new Date(window.end.getTime() + 86_400_000) };
      const intervals = scheduleIntervals(n.schedule.value, validity);
      if (intervals === null) {
        scheduleUnderstood = false;
        reasons.push(`schedule "${n.schedule.value.replace(/\s+/g, ' ')}" not understood — treated as active`);
      } else {
        scheduleUnderstood = true;
        if (!intervals.some((iv) => overlaps(iv, window))) {
          time = 'schedule-inactive';
          reasons.push(`schedule "${n.schedule.value.replace(/\s+/g, ' ')}" has no period during the flight`);
        }
      }
    }
  }

  // Geography.
  let distance: number | null = null;
  let near = true;
  const q = n.q?.value;
  if (q?.centre && q.radiusNm !== null) {
    distance = Math.min(...route.map((p) => distanceNm(p, q.centre!)));
    if (q.radiusNm >= 999) reasons.push('FIR-wide');
    else if (distance <= q.radiusNm + marginNm) reasons.push(`${Math.round(distance)} nm from the route, within its ${q.radiusNm} nm radius`);
    else {
      near = false;
      reasons.push(`${Math.round(distance)} nm from the route, outside its ${q.radiusNm} nm radius`);
    }
  } else {
    reasons.push('no position in Q line — treated as near');
  }

  const inScope = (time === 'active' || time === 'unknown') && near;
  return { time, scheduleUnderstood, distanceNm: distance, near, inScope, reasons };
}
