/**
 * What pilots have found along the route, for the picture.
 *
 * The only source of cloud tops, icing and turbulence there is, and a thin
 * one: reports come from whoever happened to be flying and had time to say
 * something, mostly airliners, mostly near big airports. So this draws what
 * there is and judges nothing. A report here is not a finding, and no
 * report at all says nothing about the air.
 *
 * Each one is placed at the point of the route nearest to it, and read
 * against the same ninety minutes the rules allow an observation: one you
 * would reach well after it was made is still shown, as what somebody found
 * then, but marked as not speaking for when you get there.
 */
import { decodePirep, PIREP_DECODER_VERSION } from '../decode/pirep/decode.js';
import type { DecodedPirep, PirepCloud, PirepIcing, PirepTurbulence } from '../decode/pirep/types.js';
import { distanceNm, trackPosition, type LatLon } from '../domain/geo.js';
import type { ResolvedFlight } from '../resolve/flight.js';
import { OBSERVATION_WINDOW_MS } from '../rules/evaluate.js';
import type { Store } from '../store/types.js';

/** How far either side of the route a report counts: wider than the corridor for stations, because there are so few. */
export const PIREP_CORRIDOR_NM = 50;
/** Reports this far above the cruise are not about air this flight will be in. */
export const PIREP_ABOVE_CRUISE_FT = 6000;
/** The AWC's file holds ninety minutes of the world's reports, of which a few hundred at most are PIREPs. */
const MAX_PIREPS = 1000;

export interface PicturePirep {
  /** The station it was filed through. */
  readonly station: string | null;
  /** The report as filed. */
  readonly text: string;
  readonly at: string;
  readonly lat: number;
  readonly lon: number;
  /** From the departure, along the route, to the point nearest it. */
  readonly nm: number;
  /** Off the route, positive to the right of it. */
  readonly offsetNm: number;
  readonly passAt: string;
  /** Made within ninety minutes of when you would pass it. */
  readonly speaksForThen: boolean;
  readonly altitudeFt: number | null;
  readonly phase: DecodedPirep['phase'];
  readonly aircraft: string | null;
  readonly urgent: boolean;
  readonly tempC: number | null;
  readonly clouds: readonly PirepCloud[];
  readonly turbulence: readonly PirepTurbulence[];
  readonly icing: readonly PirepIcing[];
}

/** Where on the route a position is nearest: past either end of a leg, that is the end. */
function nearestOnRoute(flight: ResolvedFlight, p: LatLon): { nm: number; offsetNm: number } {
  let best: { nm: number; offsetNm: number } | null = null;
  flight.route.legs.forEach((leg, i) => {
    const start = flight.route.points[i]!.cumulative;
    const { alongNm, offsetNm } = trackPosition(leg.from.position, leg.to.position, p);
    const along = Math.min(Math.max(alongNm, 0), leg.distance);
    const away = along === alongNm ? Math.abs(offsetNm) : distanceNm(p, alongNm < 0 ? leg.from.position : leg.to.position);
    if (!best || away < Math.abs(best.offsetNm)) best = { nm: start + along, offsetNm: offsetNm < 0 ? -away : away };
  });
  return best!;
}

/** The reports beside this flight, first passed first, and how many were held for anywhere at all. */
export async function pirepsAlong(store: Store, flight: ResolvedFlight): Promise<{ pireps: PicturePirep[]; held: number }> {
  const asOf = flight.asOf.getTime();
  const departs = flight.route.points[0]!.eta.getTime();
  const highest = flight.plan.cruise.altitude + PIREP_ABOVE_CRUISE_FT;
  const pireps: PicturePirep[] = [];
  let held = 0;
  for (const report of await store.listRaw({ kind: 'pirep', limit: MAX_PIREPS, knownBy: flight.asOf })) {
    const made = report.issuedAt?.getTime();
    if (made === undefined || asOf - made > OBSERVATION_WINDOW_MS) continue;
    held++;
    const stored = await store.getDecoded(report.sha256, PIREP_DECODER_VERSION);
    const d = stored ? (stored.decoded as DecodedPirep) : decodePirep(report.body);
    if (!d.position || !d.text || (d.altitudeFt !== null && d.altitudeFt > highest)) continue;
    const { nm, offsetNm } = nearestOnRoute(flight, d.position);
    if (Math.abs(offsetNm) > PIREP_CORRIDOR_NM) continue;
    const pass = departs + (nm / flight.plan.cruise.tas) * 3_600_000;
    pireps.push({
      station: report.station,
      text: d.text.value,
      at: report.issuedAt!.toISOString(),
      lat: d.position.lat,
      lon: d.position.lon,
      nm,
      offsetNm,
      passAt: new Date(pass).toISOString(),
      speaksForThen: Math.abs(pass - made) <= OBSERVATION_WINDOW_MS,
      altitudeFt: d.altitudeFt,
      phase: d.phase,
      aircraft: d.aircraft,
      urgent: d.urgent,
      tempC: d.tempC,
      clouds: d.clouds,
      turbulence: d.turbulence,
      icing: d.icing,
    });
  }
  return { pireps: pireps.sort((a, b) => a.nm - b.nm), held };
}
