/**
 * Whether a hazard advisory has anything to do with this flight.
 *
 * Three questions, all deterministic, and a hazard has to fail none of
 * them: is it in force while you are flying, does it reach the altitude you
 * are at, and does the route go through it. A SIGMET over Kansas is not
 * hidden from a flight in Ontario — it is simply not about it.
 *
 * A SIGMET is a warning to everything in the air and a light aircraft
 * should not be flying into one, so crossing a live one at altitude is a
 * no-go. An AIRMET is advice — the conditions it describes are ones a
 * light aircraft meets routinely — so it is marginal, which says "look at
 * this and decide" rather than "do not go".
 */
import type { DecodedSigmet, SigmetHazard } from '../decode/sigmet/types.js';
import type { LatLon } from '../domain/geo.js';
import { areaIsTestable, routeDistanceToAreaNm } from '../domain/polygon.js';
import type { HazardAdvisory } from '../resolve/hazards.js';
import type { Citation, Finding, Severity } from './types.js';

export type { HazardAdvisory };

/** Close enough to be worth mentioning without being on the route. */
export const NEAR_HAZARD_NM = 25;

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
};

export interface HazardContext {
  /** The waypoint the finding belongs to. */
  readonly waypoint: string;
  readonly at: Date;
  /** The point, and the leg arriving at it when there is one. */
  readonly route: readonly LatLon[];
  /** The flight's whole window, for deciding whether the advisory is in force. */
  readonly window: { readonly from: Date; readonly to: Date };
  readonly cruiseAltitudeFt: number;
}

/** Overlapping, treating a missing end as open. */
function inForce(d: DecodedSigmet, window: { from: Date; to: Date }): boolean {
  const from = d.validFrom?.getTime() ?? -Infinity;
  const to = d.validTo?.getTime() ?? Infinity;
  return from <= window.to.getTime() && to >= window.from.getTime();
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
  const what = d.hazard ? HAZARD_TEXT[d.hazard] : (d.hazardCode?.value ?? 'a hazard');
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
  for (const advisory of advisories) {
    const d = advisory.decoded;
    if (!inForce(d, ctx.window) || !reachesAltitude(d, ctx.cruiseAltitudeFt)) continue;

    const problem = areaIsTestable(d.area);
    if (problem) {
      /*
       * An area this cannot test is reported rather than dropped. It is the
       * one case where saying nothing would be hiding something: the
       * advisory is in force at this altitude and only the geometry is
       * beyond us.
       */
      findings.push({
        rule: 'hazard.untestable',
        severity: 'advisory',
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
    const severity: Severity = !crossing ? 'advisory' : d.kind === 'airmet' ? 'marginal' : 'no-go';
    findings.push({
      rule: crossing ? 'hazard.onRoute' : 'hazard.near',
      severity,
      summary: `${describe(d)} — ${crossing ? 'your route goes through it' : `your route passes ${Math.round(distance)} nm from it`}`,
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
