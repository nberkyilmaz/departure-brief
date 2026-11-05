/**
 * When can I go: the same judgement at every hour you might leave.
 *
 * A briefing answers for one departure time. The question that comes
 * straight after it is whether another would be better — an hour later,
 * once the front is through, or before the fog comes in. So the flight is
 * resolved and judged again for each hour ahead, by exactly the code that
 * judges the briefing, with the destination taken at the time you would
 * arrive there. Nothing is reinterpreted: an hour here says what the
 * briefing would have said, had you asked for that hour.
 *
 * Between the ends, the stations along the way are read for the time you
 * would pass each one, and the hour says the worst any of them forecasts.
 *
 * What it leaves out is the observation. The METAR describes now, and now
 * does not move when the departure time does; the briefing already says
 * what it shows. An hour is judged on what is forecast for it and on the
 * clock — the forecast, the advisories, daylight — and nothing else.
 */
import type { FlightCategory } from '../decode/metar/derive.js';
import type { FlightPlan } from '../domain/flight.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import { corridorOf } from '../resolve/enroute.js';
import { resolveFlight } from '../resolve/flight.js';
import { resolveRoute } from '../resolve/route.js';
import { evaluateFlight } from '../rules/evaluate.js';
import type { EnrouteReview, Finding } from '../rules/types.js';
import type { Store } from '../store/types.js';

/** How far ahead the window looks. A TAF covers a day at most, and the useful question is today's. */
export const WINDOW_HOURS = 12;

const HOUR_MS = 3_600_000;

/** Said by the briefing beside the field; an hour that has no forecast says so with `covered` instead. */
const ABOUT_THE_FORECAST: ReadonlySet<string> = new Set(['forecast.coverage', 'forecast.borrowed']);

export interface WindowPoint {
  readonly waypoint: string;
  /** When you would be there, leaving at the slot's time. */
  readonly at: string;
  /** From the prevailing forecast for that time; `null` when it gives neither ceiling nor visibility, or there is none. */
  readonly category: FlightCategory | null;
  /** Whether any forecast, the field's own or a neighbour's, covers that time at all. */
  readonly covered: boolean;
  /** Whose forecast: the field's own, or the station it borrows from. */
  readonly forecastStation: string | null;
  /** Between the end of evening civil twilight and the start of morning's, as the briefing reckons it. */
  readonly night: boolean;
  /** The limits crossed at that time, from the forecast and the clock: alert and caution only. */
  readonly findings: readonly Finding[];
}

/** The stations along the way at one hour, said as one: the worst forecast among them, and every limit any of them crosses. */
export interface WindowAlong {
  /** How many stations along the way have a forecast that classifies the time you would pass them. */
  readonly covered: number;
  /** The worst prevailing category among them; `null` when none has one. */
  readonly category: FlightCategory | null;
  /** The station forecasting it, the first passed when several do. */
  readonly station: string | null;
  /** The limits crossed along the way at that time, from the forecasts: alert and caution only, each naming its station. */
  readonly findings: readonly Finding[];
}

export interface DepartureSlot {
  readonly departAt: string;
  /** The departure and the destination, in that order. */
  readonly points: readonly WindowPoint[];
  readonly along: WindowAlong;
}

const WORSE: Readonly<Record<FlightCategory, number>> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

/** What the window keeps of a point's findings: what the forecast and the clock say crosses a limit. */
const crossing = (f: Finding): boolean =>
  (f.attention === 'alert' || f.attention === 'caution') && f.basisKind !== 'observed' && f.basisKind !== 'plan' && !ABOUT_THE_FORECAST.has(f.rule);

function alongAt(enroute: readonly EnrouteReview[]): WindowAlong {
  const forecast = enroute.filter((s) => s.forecastCategory !== null);
  const worst = forecast.reduce<EnrouteReview | null>((w, s) => (!w || WORSE[s.forecastCategory!] > WORSE[w.forecastCategory!] ? s : w), null);
  return {
    covered: forecast.length,
    category: worst?.forecastCategory ?? null,
    station: worst?.station ?? null,
    findings: enroute.flatMap((s) => s.findings.filter(crossing)),
  };
}

/**
 * Judge the flight for each whole hour from the one after `asOf`, for
 * `hours` hours. The plan's own departure time is ignored: the window is
 * about the alternatives to it.
 */
export async function departureWindow(
  store: Store,
  plan: FlightPlan,
  profile: PilotProfile,
  aircraft: AircraftLimits | null,
  asOf: Date,
  hours: number = WINDOW_HOURS,
): Promise<DepartureSlot[]> {
  const first = Math.ceil(asOf.getTime() / HOUR_MS) * HOUR_MS;
  // Where the stations beside the route are does not move with the hour; only when you pass them does.
  const corridor = await corridorOf(store, await resolveRoute(store, plan));
  const slots: DepartureSlot[] = [];
  for (let h = 0; h < hours; h++) {
    const departAt = new Date(first + h * HOUR_MS).toISOString();
    const resolved = await resolveFlight(store, { ...plan, departureTime: departAt }, asOf, corridor);
    const judged = evaluateFlight(resolved, profile, aircraft);
    const ends = [0, resolved.points.length - 1];
    slots.push({
      departAt,
      points: ends.map((i) => {
        const review = judged.points[i]!;
        const forecast = resolved.points[i]!.forecast;
        return {
          waypoint: review.waypoint,
          at: review.at,
          category: review.forecastCategory,
          covered: forecast?.resolved.prevailing != null,
          forecastStation: forecast?.station ?? null,
          night: review.night,
          findings: review.findings.filter(crossing),
        };
      }),
      along: alongAt(judged.enroute),
    });
  }
  return slots;
}
