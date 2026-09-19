/**
 * What you are actually looking at when you read "the weather at CYSN".
 *
 * Two things can be true of an observation and neither is visible in the
 * report itself: it may be somebody else's, and it may be old. A pilot
 * reading `METAR CYSN 122100Z` at four in the morning has no way to know
 * from the text that it is seven hours stale, and a pilot handed KIAG's
 * observation for CYSN has no way to know it came from across the river.
 *
 * So both are said out loud, every time, with the number attached. Neither
 * is a judgement — an eleven-hour-old observation is not wrong, it is old,
 * and how much that matters depends on the day.
 */
import { toZulu } from '../domain/time.js';
import type { WaypointObservation } from '../resolve/observation.js';
import type { Attention, Citation, Finding } from './types.js';

/**
 * When an observation stops being "now". A METAR is issued hourly, so up to
 * an hour is simply the current one; past two hours it is describing a
 * different part of the day, and past six it is barely about today.
 */
export const OBSERVATION_AGE_MINUTES = { current: 60, recent: 120, stale: 360 } as const;

export type ObservationAge = 'current' | 'recent' | 'stale' | 'old';

/** Which band an age falls in. The bands are how it is coloured and ordered. */
export function ageBand(minutes: number): ObservationAge {
  if (minutes <= OBSERVATION_AGE_MINUTES.current) return 'current';
  if (minutes <= OBSERVATION_AGE_MINUTES.recent) return 'recent';
  if (minutes <= OBSERVATION_AGE_MINUTES.stale) return 'stale';
  return 'old';
}

/** How much reading an age asks for. Old data is not wrong; it is old. */
const ATTENTION_FOR: Readonly<Record<ObservationAge, Attention>> = {
  current: 'routine',
  recent: 'note',
  stale: 'caution',
  old: 'caution',
};

export function ageText(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h${m > 0 ? ` ${m} min` : ''} ago`;
}

export interface ObservationContext {
  readonly waypoint: string;
  readonly at: Date;
}

/**
 * One line about the observation itself: when it was taken, how old that
 * makes it, and whose it is. Always emitted when there is an observation —
 * a reading that is current and local still says so, because "this is
 * current" is worth knowing too.
 */
export function checkObservation(ctx: ObservationContext, o: WaypointObservation | null): Finding[] {
  if (!o) return [];
  const band = ageBand(o.ageMinutes);
  const issued = o.report.issuedAt;
  const citation: Citation = {
    kind: 'metar',
    station: o.station,
    raw: o.report.body,
    // The day-and-time group, which is the part of the report this is about.
    span: o.decoded.time?.span ?? null,
    text: o.decoded.time ? o.report.body.slice(o.decoded.time.span.start, o.decoded.time.span.end) : null,
    sha256: o.report.sha256,
  };

  const when = issued ? `issued ${toZulu(issued).slice(11, 16)}Z, ${ageText(o.ageMinutes)}` : 'no issue time given';
  const findings: Finding[] = [
    {
      rule: 'observation.age',
      attention: ATTENTION_FOR[band],
      summary: `${o.station} observation ${when}`,
      waypoint: ctx.waypoint,
      basis: 'observation',
      basisKind: 'observed',
      at: ctx.at.toISOString(),
      values: { station: o.station, ageMinutes: o.ageMinutes, band, issuedAt: issued?.toISOString() ?? null },
      citations: [citation],
    },
  ];

  if (o.source === 'nearby') {
    findings.push({
      rule: 'observation.borrowed',
      attention: 'note',
      summary: `${ctx.waypoint} ${o.ownAsleep ? 'is not reporting at this hour' : 'has no observation of its own'}; the conditions above are ${o.station}'s, ${Math.round(o.distance)} nm away`,
      waypoint: ctx.waypoint,
      basis: 'observation',
      basisKind: 'observed',
      at: ctx.at.toISOString(),
      values: { station: o.station, distanceNm: o.distance, ownAsleep: o.ownAsleep },
      citations: [citation],
    });
  }
  return findings;
}
