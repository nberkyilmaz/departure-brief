/**
 * Whether a hazard advisory has anything to do with this flight.
 *
 * Three questions, all deterministic, and a hazard has to fail none of
 * them: is it in force while you are flying, does it reach the altitude you
 * are at, and does the route go through it. A SIGMET over Kansas is not
 * hidden from a flight in Ontario — it is simply not about it.
 *
 * One the route goes through can still be over before you could get there,
 * or not begin until you could be past it. That is said, as a note, because
 * a hazard ending on paper is a reason to go and look for its reissue.
 *
 * A SIGMET is a warning to everything in the air and a light aircraft
 * should not be flying into one, so crossing a live one at altitude is a
 * no-go. An AIRMET is advice — the conditions it describes are ones a
 * light aircraft meets routinely — so it is marginal, which says "look at
 * this and decide" rather than "do not go".
 */
import type { DecodedSigmet, SigmetHazard } from '../decode/sigmet/types.js';
import type { LatLon } from '../domain/geo.js';
import { areaIsTestable, legInsideArea, routeDistanceToAreaNm } from '../domain/polygon.js';
import { toZulu } from '../domain/time.js';
import type { HazardAdvisory } from '../resolve/hazards.js';
import type { Citation, Finding, Attention } from './types.js';

export type { HazardAdvisory };

/** Close enough to be worth mentioning without being on the route. */
export const NEAR_HAZARD_NM = 25;

/*
 * How far the plan's clock can be out. Its times are distance over true
 * airspeed from a departure on the minute, so they know nothing of a late
 * start or the wind: the winds we have recorded at 6,500 ft ran 27 to 43 kt.
 */
export const DEPARTURE_SLIP_MIN = 30;
export const GROUNDSPEED_MARGIN_KT = 40;
/** A head wind near the airspeed should not stop the clock altogether. */
const SLOWEST_GROUNDSPEED_KT = 30;

const HOUR_MS = 3_600_000;
const hhmm = (d: Date) => toZulu(d).slice(11, 16) + 'Z';

/** How a hazard reads in a sentence. */
export const HAZARD_TEXT: Readonly<Record<SigmetHazard, string>> = {
  thunderstorm: 'thunderstorms',
  turbulence: 'turbulence',
  icing: 'airframe icing',
  'mountain-wave': 'mountain wave',
  'volcanic-ash': 'volcanic ash',
  'tropical-cyclone': 'a tropical cyclone',
  ifr: 'IFR conditions',
  'mountain-obscuration': 'mountain obscuration',
  'low-level-wind-shear': 'low-level wind shear',
  'surface-wind': 'surface winds over 30 kt',
};

export interface TripLeg {
  readonly from: LatLon;
  readonly to: LatLon;
  /** How far along the trip this leg begins. */
  readonly startNm: number;
  readonly distanceNm: number;
}

export interface HazardContext {
  /** The waypoint the finding belongs to. */
  readonly waypoint: string;
  readonly at: Date;
  /** The point, and the leg arriving at it when there is one. */
  readonly route: readonly LatLon[];
  /** The flight's whole window, for deciding whether the advisory is in force. */
  readonly window: { readonly from: Date; readonly to: Date };
  /** When this leg is flown. A G-AIRMET picture is only about these hours, and the next one will say where the hazard has gone by then. */
  readonly leg: { readonly from: Date; readonly to: Date };
  /** Every leg of the trip, for timing the whole way through an area. */
  readonly trip: readonly TripLeg[];
  readonly tasKt: number;
  readonly cruiseAltitudeFt: number;
}

/** Overlapping, treating a missing end as open. */
function inForce(d: DecodedSigmet, window: { from: Date; to: Date }): boolean {
  const from = d.validFrom?.getTime() ?? -Infinity;
  const to = d.validTo?.getTime() ?? Infinity;
  // One G-AIRMET picture ends where the next begins, and the moment between them belongs to the next.
  return from <= window.to.getTime() && (d.snapshotAt ? to > window.from.getTime() : to >= window.from.getTime());
}

/**
 * Why an advisory on the route cannot be in force while you are inside it,
 * or null when it could. Leaving at the edge of the slip and flying at the
 * edge of the margin are what "could" means, so an alert only stops being
 * one when no ordinary version of the flight would meet it. Inside means
 * the whole way through, so every waypoint the area touches says the same.
 */
function outOfTime(d: DecodedSigmet, ctx: HazardContext): string | null {
  const inside = ctx.trip.flatMap((leg) => legInsideArea(leg.from, leg.to, d.area).map((s) => ({ fromNm: leg.startNm + s.from * leg.distanceNm, toNm: leg.startNm + s.to * leg.distanceNm })));
  const first = inside[0];
  const last = inside[inside.length - 1];
  // A route that only touches the edge has no stretch inside to time, so it stays what it was.
  if (!first || !last) return null;
  const enterNm = first.fromNm;
  const leaveNm = last.toNm;
  const departs = ctx.window.from.getTime();
  const slip = DEPARTURE_SLIP_MIN * 60_000;
  const earliest = departs - slip + (enterNm / (ctx.tasKt + GROUNDSPEED_MARGIN_KT)) * HOUR_MS;
  const latest = departs + slip + (leaveNm / Math.max(ctx.tasKt - GROUNDSPEED_MARGIN_KT, SLOWEST_GROUNDSPEED_KT)) * HOUR_MS;
  if (d.validTo && d.validTo.getTime() < earliest) {
    return `it ends ${hhmm(d.validTo)} and you would reach it about ${hhmm(new Date(departs + (enterNm / ctx.tasKt) * HOUR_MS))}. Check whether it has been reissued`;
  }
  if (d.validFrom && d.validFrom.getTime() > latest) {
    return `it begins ${hhmm(d.validFrom)} and you would be past it about ${hhmm(new Date(departs + (leaveNm / ctx.tasKt) * HOUR_MS))}`;
  }
  return null;
}

/**
 * A missing base is the surface and a missing top is unlimited: the
 * cautious reading, and the one the products intend when they leave a
 * bound out.
 */
function reachesAltitude(d: DecodedSigmet, altitudeFt: number): boolean {
  return altitudeFt >= (d.baseFt ?? 0) && altitudeFt <= (d.topFt ?? Infinity);
}

function citationFor(h: HazardAdvisory): Citation {
  const cited = h.decoded.bulletin ?? h.decoded.hazardCode;
  return {
    kind: 'sigmet',
    station: h.decoded.region,
    raw: h.report.body,
    span: cited?.span ?? null,
    text: h.decoded.bulletin?.value ?? null,
    sha256: h.report.sha256,
  };
}

function describe(d: DecodedSigmet): string {
  const what = `${d.hazard ? HAZARD_TEXT[d.hazard] : (d.hazardCode?.value ?? 'a hazard')}${d.dueTo ? ` (${d.dueTo})` : ''}`;
  const severity = d.qualifier?.value ? `${d.qualifier.value.toLowerCase()} ` : '';
  const band =
    d.baseFt === null && d.topFt === null
      ? ''
      : ` between ${(d.baseFt ?? 0).toLocaleString('en')} and ${d.topFt === null ? 'unlimited' : `${d.topFt.toLocaleString('en')} ft`}`;
  const name = `${d.kind === 'airmet' ? 'AIRMET' : 'SIGMET'}${d.series ? ` ${d.series}` : ''}${d.region ? ` (${d.region})` : ''}`;
  return `${name}: ${severity}${what}${band}`;
}

/**
 * The findings for one waypoint, given everything the store holds. Only
 * advisories that reach this flight are reported; the rest are about
 * somewhere else.
 */
export function checkHazards(ctx: HazardContext, advisories: readonly HazardAdvisory[]): Finding[] {
  const findings: Finding[] = [];
  /*
   * The pictures of one G-AIRMET are one hazard, however many of them this
   * leg's hours touch: said once, and on-route rather than near if any of
   * them puts the route inside it.
   */
  const pictures = new Map<string, Finding>();
  const put = (d: DecodedSigmet, finding: Finding) => {
    if (!d.snapshotAt) {
      findings.push(finding);
      return;
    }
    const key = `${d.series}|${d.hazard}`;
    const held = pictures.get(key);
    if (!held) {
      pictures.set(key, finding);
      findings.push(finding);
    } else if (held.rule !== 'hazard.onRoute' && finding.rule === 'hazard.onRoute') {
      pictures.set(key, finding);
      findings[findings.indexOf(held)] = finding;
    }
  };
  for (const advisory of advisories) {
    const d = advisory.decoded;
    if (!inForce(d, d.snapshotAt ? ctx.leg : ctx.window) || !reachesAltitude(d, ctx.cruiseAltitudeFt)) continue;

    const problem = areaIsTestable(d.area);
    if (problem) {
      /*
       * An area this cannot test is reported rather than dropped. It is the
       * one case where saying nothing would be hiding something: the
       * advisory is in force at this altitude and only the geometry is
       * beyond us.
       */
      put(d, {
        rule: 'hazard.untestable',
        attention: 'note',
        summary: `${describe(d)} — ${problem.reason}, so whether your route goes through it has to be checked by eye`,
        waypoint: ctx.waypoint,
        basis: d.kind === 'airmet' ? 'AIRMET' : 'SIGMET',
        basisKind: 'forecast',
        at: ctx.at.toISOString(),
        values: { region: d.region, hazard: d.hazard, reason: problem.reason },
        citations: [citationFor(advisory)],
      });
      continue;
    }

    const distance = routeDistanceToAreaNm(ctx.route, d.area);
    if (distance > NEAR_HAZARD_NM) continue;

    const crossing = distance === 0;
    // A G-AIRMET picture has already been chosen by the hours of the leg.
    const elsewhen = crossing && !d.snapshotAt ? outOfTime(d, ctx) : null;
    const attention: Attention = !crossing || elsewhen ? 'note' : d.kind === 'airmet' ? 'caution' : 'alert';
    const where = elsewhen ? `on your route, but ${elsewhen}` : crossing ? 'your route goes through it' : `your route passes ${Math.round(distance)} nm from it`;
    put(d, {
      rule: elsewhen ? 'hazard.notInForce' : crossing ? 'hazard.onRoute' : 'hazard.near',
      attention,
      summary: `${describe(d)} — ${where}`,
      waypoint: ctx.waypoint,
      basis: d.kind === 'airmet' ? 'AIRMET' : 'SIGMET',
      basisKind: 'forecast',
      at: ctx.at.toISOString(),
      values: {
        region: d.region,
        hazard: d.hazard,
        qualifier: d.qualifier?.value ?? null,
        baseFt: d.baseFt,
        topFt: d.topFt,
        distanceNm: Math.round(distance),
      },
      citations: [citationFor(advisory)],
    });
  }
  return findings;
}
