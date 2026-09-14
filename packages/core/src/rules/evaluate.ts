import { EMPTY_CONDITIONS, type Conditions } from '../decode/conditions.js';
import type { DecodedMetar } from '../decode/metar/index.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import { isNight } from '../domain/sun.js';
import { toZulu } from '../domain/time.js';
import type { ResolvedFlight, ResolvedPoint } from '../resolve/flight.js';
import { checkConditions, checkNight, type CheckContext } from './checks.js';
import { checkDaylight } from './daylight.js';
import { checkWindAloft } from './windAloft.js';
import { RULES_VERSION, verdictOf, worst, type Briefing, type Finding, type PointVerdict } from './types.js';

/** A METAR's body as forecast-shaped conditions, so the same checks apply. */
export function metarConditions(m: DecodedMetar): Conditions {
  return {
    ...EMPTY_CONDITIONS,
    wind: m.wind,
    visibility: m.visibility,
    weather: m.weather,
    sky: m.sky,
    altimeter: m.altimeter,
  };
}

const hhmm = (d: Date) => toZulu(d).slice(11, 16) + 'Z';

/** How long a METAR is treated as describing "now" for a point's ETA. */
export const OBSERVATION_WINDOW_MS = 90 * 60_000;

function evaluatePoint(p: ResolvedPoint, flight: ResolvedFlight, profile: PilotProfile, aircraft: AircraftLimits | null): PointVerdict {
  const w = p.point.waypoint;
  const at = p.point.eta;
  const night = isNight(w.position, at);
  const base = {
    waypoint: w.id,
    at,
    profile,
    aircraft,
    airport: w.airport,
    airspace: flight.plan.airspace?.[w.id] ?? null,
    cruiseAltitude: flight.plan.cruise.altitude,
    night,
  };
  const findings: Finding[] = [];

  if (p.forecast) {
    const f = p.forecast.resolved;
    const source = { kind: 'taf' as const, station: p.forecast.station, raw: f.raw, sha256: p.forecast.report.sha256 };
    const borrowed = p.forecast.source === 'nearby' ? ` (TAF ${p.forecast.station}, ${Math.round(p.forecast.distance)} nm away)` : '';
    if (f.prevailing) {
      findings.push(...checkConditions({ ...base, basis: `prevailing${borrowed}`, basisKind: 'prevailing', violation: 'no-go', source }, f.prevailing.conditions));
      for (const o of f.overlays) {
        const label = `${o.probability ? `PROB${o.probability} ` : ''}${o.kind === 'PROB' ? '' : o.kind} ${hhmm(o.window.from)}–${hhmm(o.window.to)}`.replace(/\s+/g, ' ').trim();
        findings.push(...checkConditions({ ...base, basis: `${label}${borrowed}`, basisKind: 'overlay', violation: 'marginal', source }, o.conditions));
      }
    } else {
      findings.push({
        rule: 'forecast.coverage',
        severity: 'marginal',
        summary: `TAF ${p.forecast.station} does not cover ${toZulu(at)}${f.outsideValidity ? ' (outside its validity)' : ''} — no forecast to evaluate`,
        waypoint: w.id,
        basis: 'forecast',
        basisKind: 'forecast',
        at: at.toISOString(),
        values: { outsideValidity: f.outsideValidity },
        citations: [{ kind: 'taf', station: p.forecast.station, raw: f.raw, span: null, text: null, sha256: p.forecast.report.sha256 }],
      });
    }
    if (p.forecast.source === 'nearby') {
      findings.push({
        rule: 'forecast.borrowed',
        severity: 'advisory',
        summary: `${w.id} has no TAF; conditions above are from ${p.forecast.station}, ${Math.round(p.forecast.distance)} nm away`,
        waypoint: w.id,
        basis: 'forecast',
        basisKind: 'forecast',
        at: at.toISOString(),
        values: { station: p.forecast.station, distanceNm: p.forecast.distance },
        citations: [],
      });
    }
  } else {
    findings.push({
      rule: 'forecast.coverage',
      severity: 'marginal',
      summary: `no TAF for ${w.id} and none within reach — nothing to evaluate at ETA`,
      waypoint: w.id,
      basis: 'forecast',
      basisKind: 'forecast',
      at: at.toISOString(),
      values: {},
      citations: [],
    });
  }

  if (p.metar && p.metar.report.issuedAt) {
    const age = at.getTime() - p.metar.report.issuedAt.getTime();
    const ctx: CheckContext = {
      ...base,
      basis: `observed ${hhmm(p.metar.report.issuedAt)}`,
      basisKind: 'observed',
      // A current observation is hard evidence at departure; hours before an ETA it is context.
      violation: Math.abs(age) <= OBSERVATION_WINDOW_MS ? 'no-go' : 'marginal',
      source: { kind: 'metar', station: p.metar.decoded.station?.value ?? null, raw: p.metar.report.body, sha256: p.metar.report.sha256 },
    };
    findings.push(...checkConditions(ctx, metarConditions(p.metar.decoded)));
  }

  findings.push(...checkWindAloft({ waypoint: w.id, at, cruiseAltitude: flight.plan.cruise.altitude }, p.wind));

  findings.push(...checkDaylight({ waypoint: w.id, position: w.position, at, nightAllowed: profile.nightAllowed }));

  findings.push(...checkNight({ ...base, basis: 'time', basisKind: 'time', violation: 'no-go', source: { kind: 'taf', station: null, raw: '', sha256: null } }));

  return { waypoint: w.id, at: at.toISOString(), verdict: verdictOf(findings), night, findings };
}

/**
 * Judge a resolved flight against a profile. Pure and deterministic: the
 * same inputs always give the same briefing, and every finding carries the
 * report text and span it came from.
 */
export function evaluateFlight(flight: ResolvedFlight, profile: PilotProfile, aircraft: AircraftLimits | null): Briefing {
  const points = flight.points.map((p) => evaluatePoint(p, flight, profile, aircraft));
  const alternate = flight.alternate ? evaluatePoint(flight.alternate, flight, profile, aircraft) : null;
  return {
    rulesVersion: RULES_VERSION,
    profile: { name: profile.name, version: profile.version },
    aircraft: aircraft?.type ?? null,
    asOf: flight.asOf.toISOString(),
    // The alternate informs the decision but does not by itself ground the flight.
    verdict: worst(...points.map((p) => p.verdict)),
    points,
    alternate,
  };
}
