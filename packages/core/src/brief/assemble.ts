import { METAR_DECODER_VERSION } from '../decode/metar/index.js';
import { TAF_DECODER_VERSION } from '../decode/taf/index.js';
import type { FlightPlan } from '../domain/flight.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import type { ResolvedFlight, ResolvedPoint } from '../resolve/flight.js';
import { evaluateFlight } from '../rules/evaluate.js';
import { RULES_VERSION } from '../rules/types.js';
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
  };
}

function reportRefs(points: readonly ResolvedPoint[]): BriefingReportRef[] {
  const seen = new Map<string, BriefingReportRef>();
  for (const p of points) {
    for (const r of [p.forecast?.report, p.metar?.report]) {
      if (r && !seen.has(r.sha256)) {
        seen.set(r.sha256, { kind: r.kind, station: r.station, sha256: r.sha256, issuedAt: r.issuedAt?.toISOString() ?? null });
      }
    }
  }
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
): StoredBriefing {
  const briefing = evaluateFlight(resolved, profile, aircraft);
  const allPoints = [...resolved.points, ...(resolved.alternate ? [resolved.alternate] : [])];
  const document: BriefingDocument = {
    format: 1,
    plan: resolved.plan,
    profile,
    aircraft,
    asOf: resolved.asOf.toISOString(),
    versions: { rules: RULES_VERSION, metarDecoder: METAR_DECODER_VERSION, tafDecoder: TAF_DECODER_VERSION },
    inputs: {
      points: resolved.points.map(pointInputs),
      alternate: resolved.alternate ? pointInputs(resolved.alternate) : null,
      reports: reportRefs(allPoints),
    },
    briefing,
  };
  return { sha256: contentHash(document), flightKey: flightKey(resolved.plan), asOf: resolved.asOf, createdAt, document };
}
