import { METAR_DECODER_VERSION } from '../decode/metar/index.js';
import { TAF_DECODER_VERSION } from '../decode/taf/index.js';
import type { FlightPlan } from '../domain/flight.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import { PROMPT_VERSION } from '../notam/assess.js';
import { NOTAM_DECODER_VERSION } from '../notam/decode.js';
import { notamDocument } from '../notam/describe.js';
import type { NotamBriefing } from '../notam/flight.js';
import type { ResolvedFlight, ResolvedPoint } from '../resolve/flight.js';
import { fuelPlan } from '../navlog/fuel.js';
import { checkFuel } from '../rules/fuel.js';
import { navLog } from '../navlog/compute.js';
import { evaluateFlight } from '../rules/evaluate.js';
import { RULES_VERSION, type Briefing } from '../rules/types.js';
import { contentHash } from './canonical.js';
import type { BriefingDocument, BriefingPointInputs, BriefingReportRef, StoredBriefing } from './types.js';

/** The flight's identity: what it is, not how it is judged. */
export function flightKey(plan: FlightPlan): string {
  return contentHash({
    departure: plan.departure,
    destination: plan.destination,
    alternate: plan.alternate,
    route: plan.route,
    departureTime: plan.departureTime,
    cruise: plan.cruise,
  });
}

function pointInputs(p: ResolvedPoint): BriefingPointInputs {
  return {
    waypoint: p.point.waypoint.id,
    eta: p.point.eta.toISOString(),
    cumulativeNm: p.point.cumulative,
    forecast: p.forecast
      ? { station: p.forecast.station, source: p.forecast.source, distanceNm: p.forecast.distance, sha256: p.forecast.report.sha256 }
      : null,
    metar: p.metar?.report.sha256 ?? null,
    wind: p.wind ? { station: p.wind.station, distanceNm: p.wind.distance, altitudeFt: p.wind.wind.altitudeFt, sha256: p.wind.report.sha256 } : null,
  };
}

function reportRefs(points: readonly ResolvedPoint[], notams: NotamBriefing | null): BriefingReportRef[] {
  const seen = new Map<string, BriefingReportRef>();
  const add = (r: { kind: BriefingReportRef['kind']; station: string | null; sha256: string; issuedAt: Date | null } | undefined) => {
    if (r && !seen.has(r.sha256)) seen.set(r.sha256, { kind: r.kind, station: r.station, sha256: r.sha256, issuedAt: r.issuedAt?.toISOString() ?? null });
  };
  for (const p of points) {
    add(p.forecast?.report);
    add(p.metar?.report);
    add(p.wind?.report);
  }
  for (const n of notams?.items ?? []) add(n.report);
  return [...seen.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

/**
 * Judge a resolved flight and wrap the result with everything it was made
 * from. Pure apart from `createdAt`, which is not part of the hash.
 */
export function assembleBriefing(
  resolved: ResolvedFlight,
  profile: PilotProfile,
  aircraft: AircraftLimits | null,
  createdAt: Date = new Date(),
  notams: NotamBriefing | null = null,
): StoredBriefing {
  const evaluated = evaluateFlight(resolved, profile, aircraft);
  const navlog = navLog(resolved, aircraft?.cruiseFuelGph ?? null);
  /*
   * Fuel is about the flight, not a point, but the reserve has to still be
   * in the tanks at the destination, so that is where the line goes. Night
   * for 602.88(4) is any point of the flight at night — a diversion to the
   * alternate is a different flight and does not count.
   */
  const nightPoint = evaluated.points.find((p) => p.night) ?? null;
  const fuel = fuelPlan(navlog, resolved.plan.fuelAboardGal, nightPoint !== null);
  const destination = evaluated.points[evaluated.points.length - 1];
  const briefing: Briefing = destination
    ? {
        ...evaluated,
        points: evaluated.points.map((p, i) =>
          i === evaluated.points.length - 1
            ? { ...p, findings: [...p.findings, ...checkFuel({ waypoint: p.waypoint, at: new Date(p.at), nightAt: nightPoint?.waypoint ?? null }, fuel)] }
            : p,
        ),
      }
    : evaluated;
  const allPoints = [...resolved.points, ...(resolved.alternate ? [resolved.alternate] : [])];
  const document: BriefingDocument = {
    format: 3,
    plan: resolved.plan,
    profile,
    aircraft,
    asOf: resolved.asOf.toISOString(),
    versions: {
      rules: RULES_VERSION,
      metarDecoder: METAR_DECODER_VERSION,
      tafDecoder: TAF_DECODER_VERSION,
      notamDecoder: NOTAM_DECODER_VERSION,
      notamPrompt: PROMPT_VERSION,
    },
    notams: notams ? notamDocument(notams) : null,
    inputs: {
      points: resolved.points.map(pointInputs),
      alternate: resolved.alternate ? pointInputs(resolved.alternate) : null,
      reports: reportRefs(allPoints, notams),
    },
    briefing,
    navlog,
    fuel,
  };
  return { sha256: contentHash(document), flightKey: flightKey(resolved.plan), asOf: resolved.asOf, createdAt, document };
}
