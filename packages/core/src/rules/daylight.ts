/**
 * How much daylight is left when you get there.
 *
 * The night check already answers whether the flight is at night at all.
 * This answers the question before it, the one that catches people out on
 * a late afternoon flight: you arrive in daylight, but with how much of it
 * to spare — enough for a circuit, a go-around, a diversion, or not?
 *
 * In Canada night is defined by civil twilight (CARs 101.01), which is the
 * same boundary the night rules use, so last light here is the legal
 * beginning of night and not an approximation of it.
 */
import { solarEvents } from '../domain/sun.js';
import type { LatLon } from '../domain/geo.js';
import { toZulu } from '../domain/time.js';
import type { Citation, Finding } from './types.js';

/** Below this much daylight left on arrival, it is worth saying so out loud. */
export const THIN_MARGIN_MINUTES = 60;

export interface DaylightContext {
  readonly waypoint: string;
  readonly position: LatLon;
  readonly at: Date;
  /** Whether this pilot flies at night at all; a no changes what a thin margin means. */
  readonly nightAllowed: boolean;
}

const hhmm = (d: Date) => `${toZulu(d).slice(11, 16)}Z`;

function since(from: Date, to: Date): string {
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `${h > 0 ? `${h} h ` : ''}${m} min`;
}

/**
 * The daylight finding for one point. Always emitted when the sun does
 * something there that day, because "you land 40 minutes before last
 * light" is worth reading even when nothing is wrong with it.
 */
export function checkDaylight(ctx: DaylightContext): Finding[] {
  const events = solarEvents(ctx.position, ctx.at);
  /*
   * There is no report behind this one: it is the sun's position computed
   * for a place and an instant. So it cites the place and the instant,
   * which is what it was actually derived from — the same standard every
   * other finding is held to, not an exemption from it.
   */
  const citation: Citation = {
    kind: 'airport',
    station: ctx.waypoint,
    raw: null,
    span: null,
    text: `${ctx.position.lat.toFixed(3)}, ${ctx.position.lon.toFixed(3)} at ${toZulu(ctx.at)}`,
    sha256: null,
  };
  const base = {
    waypoint: ctx.waypoint,
    basis: 'daylight',
    basisKind: 'time' as const,
    at: ctx.at.toISOString(),
    citations: [citation],
  };

  if (events.allDay) {
    return [{ ...base, rule: 'daylight.margin', attention: 'routine', summary: 'the sun does not set here today', values: { allDay: true } }];
  }
  if (events.allNight) {
    return [{ ...base, rule: 'daylight.margin', attention: 'routine', summary: 'the sun does not rise here today — the whole flight is at night', values: { allNight: true } }];
  }

  const dusk = events.civilDusk;
  const dawn = events.civilDawn;
  if (!dusk) return [];

  /*
   * Arriving in the dark is a different statement from arriving with the
   * light going: if the next event is first light rather than last light,
   * it is already night here.
   */
  const alreadyNight = dawn !== null && dawn.getTime() < dusk.getTime();
  if (alreadyNight) {
    return [
      {
        ...base,
        rule: 'daylight.margin',
        attention: 'routine',
        summary: `night here; first light ${hhmm(dawn!)}, in ${since(ctx.at, dawn!)}`,
        values: { night: true, civilDawn: dawn!.toISOString() },
      },
    ];
  }

  const margin = Math.round((dusk.getTime() - ctx.at.getTime()) / 60_000);
  const thin = margin <= THIN_MARGIN_MINUTES;
  return [
    {
      ...base,
      rule: 'daylight.margin',
      /*
       * Advisory rather than a violation: an hour of daylight is plenty for
       * a circuit and not much for a diversion, and which of those it is
       * belongs to the pilot. Whether they fly at night changes what the
       * margin means, so it changes what is said, not how loudly.
       */
      attention: thin ? 'note' : 'routine',
      summary: `last light ${hhmm(dusk)}${events.sunset ? ` (sunset ${hhmm(events.sunset)})` : ''} — ${since(ctx.at, dusk)} of daylight after arrival${
        thin && !ctx.nightAllowed ? ', and this profile does not fly at night' : ''
      }`,
      values: { marginMinutes: margin, civilDusk: dusk.toISOString(), sunset: events.sunset?.toISOString() ?? null },
    },
  ];
}
