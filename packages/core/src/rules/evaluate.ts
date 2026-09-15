import { EMPTY_CONDITIONS, type Conditions } from '../decode/conditions.js';
import { ceilingOf, flightCategory, flightCategoryOf, visibilityStatuteMiles, type DecodedMetar } from '../decode/metar/index.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import { isNight } from '../domain/sun.js';
import { toZulu } from '../domain/time.js';
import type { ResolvedFlight, ResolvedPoint } from '../resolve/flight.js';
import { checkConditions, checkNight, type CheckContext } from './checks.js';
import { checkDaylight } from './daylight.js';
import { checkHazards } from './hazards.js';
import { checkWindAloft } from './windAloft.js';
import { RULES_VERSION, type Briefing, type Finding, type PointReview } from './types.js';

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

/** Prevailing visibility in statute miles, or null when none was forecast. */
const visibilityOf = (c: Conditions) => (c.visibility ? visibilityStatuteMiles(c.visibility.value) : null);

/** How long a METAR is treated as describing "now" for a point's ETA. */
export const OBSERVATION_WINDOW_MS = 90 * 60_000;

/** Departure to the last arrival, which is when an advisory could matter. */
function flightWindow(flight: ResolvedFlight): { from: Date; to: Date } {
  const points = [...flight.points, ...(flight.alternate ? [flight.alternate] : [])];
  const times = points.map((p) => p.point.eta.getTime());
  return { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) };
}

function evaluatePoint(
  p: ResolvedPoint,
  flight: ResolvedFlight,
  profile: PilotProfile,
  aircraft: AircraftLimits | null,
  previous: ResolvedPoint | null,
): PointReview {
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
      findings.push(...checkConditions({ ...base, basis: `prevailing${borrowed}`, basisKind: 'prevailing', violation: 'alert', source }, f.prevailing.conditions));
      for (const o of f.overlays) {
        const label = `${o.probability ? `PROB${o.probability} ` : ''}${o.kind === 'PROB' ? '' : o.kind} ${hhmm(o.window.from)}–${hhmm(o.window.to)}`.replace(/\s+/g, ' ').trim();
        findings.push(...checkConditions({ ...base, basis: `${label}${borrowed}`, basisKind: 'overlay', violation: 'caution', source }, o.conditions));
      }
    } else {
      findings.push({
        rule: 'forecast.coverage',
        attention: 'caution',
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
        attention: 'note',
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
      attention: 'caution',
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
      violation: Math.abs(age) <= OBSERVATION_WINDOW_MS ? 'alert' : 'caution',
      source: { kind: 'metar', station: p.metar.decoded.station?.value ?? null, raw: p.metar.report.body, sha256: p.metar.report.sha256 },
    };
    findings.push(...checkConditions(ctx, metarConditions(p.metar.decoded)));
  }

  findings.push(...checkWindAloft({ waypoint: w.id, at, cruiseAltitude: flight.plan.cruise.altitude }, p.wind));

  findings.push(...checkDaylight({ waypoint: w.id, position: w.position, at, nightAllowed: profile.nightAllowed }));

  /*
   * A hazard belongs to the leg that arrives here, not to the point alone:
   * a route can pass through an area without any of its waypoints being
   * inside one. The departure has no leg before it, so it is judged on its
   * own position.
   */
  const arriving = previous ? [previous.point.waypoint.position, w.position] : [w.position];
  findings.push(
    ...checkHazards(
      {
        waypoint: w.id,
        at,
        route: arriving,
        window: flightWindow(flight),
        cruiseAltitudeFt: flight.plan.cruise.altitude,
      },
      flight.hazards,
    ),
  );

  findings.push(...checkNight({ ...base, basis: 'time', basisKind: 'time', violation: 'alert', source: { kind: 'taf', station: null, raw: '', sha256: null } }));

  /*
   * The category is an objective classification of what the products say —
   * the same one every weather service publishes — not a judgement about
   * this flight. The observation and the forecast are reported separately,
   * because a field that is VFR now and forecast IFR at your arrival is two
   * different facts and collapsing them would lose the one that matters.
   */
  const observed = p.metar ? flightCategory(p.metar.decoded) : null;
  const forecast = p.forecast?.resolved.prevailing ? flightCategoryOf(ceilingOf(p.forecast.resolved.prevailing.conditions.sky)?.value ?? null, visibilityOf(p.forecast.resolved.prevailing.conditions)) : null;
  return { waypoint: w.id, at: at.toISOString(), category: observed, forecastCategory: forecast, night, findings };
}

/**
 * Judge a resolved flight against a profile. Pure and deterministic: the
 * same inputs always give the same briefing, and every finding carries the
 * report text and span it came from.
 */
export function evaluateFlight(flight: ResolvedFlight, profile: PilotProfile, aircraft: AircraftLimits | null): Briefing {
  const points = flight.points.map((p, i) => evaluatePoint(p, flight, profile, aircraft, i > 0 ? (flight.points[i - 1] ?? null) : null));
  const alternate = flight.alternate ? evaluatePoint(flight.alternate, flight, profile, aircraft, flight.points[flight.points.length - 1] ?? null) : null;
  return {
    rulesVersion: RULES_VERSION,
    profile: { name: profile.name, version: profile.version },
    aircraft: aircraft?.type ?? null,
    asOf: flight.asOf.toISOString(),
    points,
    alternate,
  };
}
