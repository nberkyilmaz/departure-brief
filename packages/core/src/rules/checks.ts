/**
 * The individual checks, each a pure function of one set of conditions plus
 * the profile/aircraft/airport, producing findings with citations. The
 * caller decides the severity of a violation (hard for prevailing and
 * observed conditions, soft for overlays) — see `evaluate.ts`.
 */

import type { Conditions } from '../decode/conditions.js';
import type { SkyCondition } from '../decode/groups/sky.js';
import type { Visibility } from '../decode/groups/visibility.js';
import { visibilityStatuteMiles } from '../decode/metar/derive.js';
import type { Sourced, Span } from '../decode/span.js';
import { sliceSpan } from '../decode/span.js';
import type { Airport } from '../domain/airport.js';
import type { AirspaceClass } from '../domain/flight.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import type { FeetAgl, FeetMsl } from '../domain/units.js';
import { ftAgl } from '../domain/units.js';
import { analyseCrosswind } from './crosswind.js';
import type { BasisKind, Citation, Finding, Severity } from './types.js';
import { jurisdictionOf, vfrMinima } from './vfrMinima.js';

/** What every check needs to know about where its conditions came from. */
export interface CheckContext {
  readonly waypoint: string;
  readonly at: Date;
  readonly basis: string;
  readonly basisKind: BasisKind;
  /** Severity for a violation in these conditions. */
  readonly violation: Extract<Severity, 'marginal' | 'no-go'>;
  readonly source: { readonly kind: 'taf' | 'metar'; readonly station: string | null; readonly raw: string; readonly sha256: string | null };
  readonly profile: PilotProfile;
  readonly aircraft: AircraftLimits | null;
  readonly airport: Airport | null;
  readonly airspace: AirspaceClass | null;
  readonly cruiseAltitude: FeetMsl;
  readonly night: boolean;
}

function cite(ctx: CheckContext, span: Span | null): Citation {
  return {
    kind: ctx.source.kind,
    station: ctx.source.station,
    raw: ctx.source.raw,
    span,
    text: span ? sliceSpan(ctx.source.raw, span) : null,
    sha256: ctx.source.sha256,
  };
}

const profileCitation = (p: PilotProfile): Citation => ({
  kind: 'profile',
  station: null,
  raw: null,
  span: null,
  text: `${p.name} v${p.version}`,
  sha256: null,
});

/** The aeroplane's own limit, cited to the handbook line when it was read from one. */
function aircraftCitation(aircraft: AircraftLimits): Citation {
  const src = aircraft.demonstratedCrosswindSource;
  return src
    ? { kind: 'aircraft', station: null, raw: src.citedText, span: null, text: `${src.filename}${src.page > 0 ? ` p.${src.page}` : ''}: ${src.citedText}`, sha256: src.sha256 }
    : { kind: 'aircraft', station: null, raw: null, span: null, text: aircraft.type, sha256: null };
}

function finding(ctx: CheckContext, rule: string, severity: Severity, summary: string, values: Record<string, unknown>, citations: Citation[]): Finding {
  return { rule, severity, summary, waypoint: ctx.waypoint, basis: ctx.basis, basisKind: ctx.basisKind, at: ctx.at.toISOString(), values, citations };
}

/** Lowest BKN/OVC base or vertical visibility, with the group it came from. */
export function ceilingOf(sky: readonly Sourced<SkyCondition>[]): Sourced<FeetAgl> | null {
  let best: Sourced<FeetAgl> | null = null;
  for (const layer of sky) {
    const v = layer.value;
    let h: FeetAgl | null = null;
    if (v.kind === 'layer' && (v.amount === 'BKN' || v.amount === 'OVC')) h = v.base;
    else if (v.kind === 'verticalVisibility') h = v.height;
    if (h !== null && (best === null || h < best.value)) best = { value: h, span: layer.span };
  }
  return best;
}

const fmtVis = (v: Visibility): string => {
  switch (v.kind) {
    case 'statute':
      return `${v.qualifier === 'lessThan' ? '<' : v.qualifier === 'greaterThan' ? '>' : ''}${v.miles} SM`;
    case 'meters':
      return `${v.meters} m`;
    case 'cavok':
      return 'CAVOK';
    case 'missing':
      return 'not reported';
  }
};

export function checkCeiling(ctx: CheckContext, c: Conditions): Finding[] {
  const min = ctx.profile.ceiling;
  const cavok = c.visibility?.value.kind === 'cavok';
  if (c.sky.length === 0 && !cavok) {
    return [finding(ctx, 'personal.ceiling', 'advisory', 'no sky condition given — ceiling not evaluated', { minimum: min }, [profileCitation(ctx.profile)])];
  }
  const ceiling = ceilingOf(c.sky);
  if (!ceiling) {
    const groups = c.sky.map((s) => sliceSpan(ctx.source.raw, s.span)).join(' ') || 'CAVOK';
    return [finding(ctx, 'personal.ceiling', 'ok', `no ceiling (${groups}); personal minimum ${min} ft AGL`, { ceiling: null, minimum: min }, [cite(ctx, c.sky[0]?.span ?? c.visibility?.span ?? null), profileCitation(ctx.profile)])];
  }
  const ok = ceiling.value >= min;
  return [
    finding(
      ctx,
      'personal.ceiling',
      ok ? 'ok' : ctx.violation,
      `ceiling ${ceiling.value} ft AGL ${ok ? 'meets' : 'is below'} personal minimum ${min} ft`,
      { ceiling: ceiling.value, minimum: min },
      [cite(ctx, ceiling.span), profileCitation(ctx.profile)],
    ),
  ];
}

export function checkVisibility(ctx: CheckContext, c: Conditions): Finding[] {
  const min = ctx.profile.visibility;
  if (!c.visibility) {
    return [finding(ctx, 'personal.visibility', 'advisory', 'no visibility given — not evaluated', { minimum: min }, [profileCitation(ctx.profile)])];
  }
  const v = c.visibility.value;
  const miles = visibilityStatuteMiles(v);
  if (miles === null) {
    return [finding(ctx, 'personal.visibility', 'advisory', 'visibility reported missing — not evaluated', { minimum: min }, [cite(ctx, c.visibility.span)])];
  }
  // `M1/4SM` is strictly less than the figure; `P6SM` is more than it.
  const effective = v.kind === 'statute' && v.qualifier === 'lessThan' ? miles - 1e-9 : miles;
  const ok = effective >= min;
  return [
    finding(
      ctx,
      'personal.visibility',
      ok ? 'ok' : ctx.violation,
      `visibility ${fmtVis(v)} ${ok ? 'meets' : 'is below'} personal minimum ${min} SM`,
      { visibilitySm: miles, minimum: min },
      [cite(ctx, c.visibility.span), profileCitation(ctx.profile)],
    ),
  ];
}

export function checkCrosswind(ctx: CheckContext, c: Conditions): Finding[] {
  if (!ctx.airport) return [];
  const limit = ctx.profile.crosswind;
  if (!c.wind) {
    return [finding(ctx, 'crosswind.personal', 'advisory', 'no wind given — crosswind not evaluated', { limit }, [profileCitation(ctx.profile)])];
  }
  const analysis = analyseCrosswind(c.wind.value, ctx.airport);
  const windText = sliceSpan(ctx.source.raw, c.wind.span);
  if (!analysis) {
    return [finding(ctx, 'crosswind.personal', 'advisory', `wind ${windText}: direction or speed not reported — crosswind not evaluated`, { limit }, [cite(ctx, c.wind.span)])];
  }
  const airportCitation: Citation = { kind: 'airport', station: ctx.airport.icaoId ?? ctx.airport.faaId, raw: null, span: null, text: `${ctx.airport.source} ${ctx.airport.cycle}`, sha256: null };
  if (analysis.runways.length === 0) {
    return [finding(ctx, 'crosswind.personal', 'advisory', `no runway headings known for ${ctx.waypoint} — crosswind not evaluated`, { unknownHeading: analysis.unknownHeading }, [airportCitation])];
  }
  const best = analysis.runways[0]!;
  const useGust = ctx.profile.crosswindIncludesGust && analysis.gust !== null;
  const value = useGust ? best.crosswindGust : best.crosswind;
  const findings: Finding[] = [];
  const values = {
    wind: windText,
    speedKt: analysis.speed,
    gustKt: analysis.gust,
    variable: analysis.variable,
    bestRunway: best.end,
    bestHeadingTrue: best.heading,
    crosswindKt: value,
    headwindKt: useGust ? best.headwindGust : best.headwind,
    runways: analysis.runways,
    unknownHeading: analysis.unknownHeading,
    limit,
  };
  const how = analysis.calm ? 'calm' : analysis.variable ? `variable, taken as full ${useGust ? 'gust' : 'speed'} across` : `${useGust ? 'gust' : 'sustained'} component on`;
  const ok = value <= limit;
  findings.push(
    finding(
      ctx,
      'crosswind.personal',
      ok ? 'ok' : ctx.violation,
      `wind ${windText}: ${Math.round(value)} kt crosswind (${how} runway ${best.end}, ${Math.round(best.heading)}°T) ${ok ? 'within' : 'exceeds'} personal limit ${limit} kt`,
      values,
      [cite(ctx, c.wind.span), airportCitation, profileCitation(ctx.profile)],
    ),
  );
  if (ctx.aircraft?.demonstratedCrosswind !== null && ctx.aircraft?.demonstratedCrosswind !== undefined) {
    const demo = ctx.aircraft.demonstratedCrosswind;
    const within = value <= demo;
    findings.push(
      finding(
        ctx,
        'crosswind.demonstrated',
        within ? 'ok' : ctx.violation,
        `${Math.round(value)} kt crosswind ${within ? 'within' : 'exceeds'} ${ctx.aircraft.type} demonstrated ${demo} kt`,
        { crosswindKt: value, demonstrated: demo },
        [cite(ctx, c.wind.span), aircraftCitation(ctx.aircraft)],
      ),
    );
  }
  if (ctx.profile.maxGustSpread !== null && analysis.gust !== null) {
    const spread = analysis.gust - analysis.speed;
    const ok2 = spread <= ctx.profile.maxGustSpread;
    findings.push(
      finding(ctx, 'wind.gustSpread', ok2 ? 'ok' : ctx.violation, `gust spread ${spread} kt ${ok2 ? 'within' : 'exceeds'} personal limit ${ctx.profile.maxGustSpread} kt`, { spread, limit: ctx.profile.maxGustSpread }, [cite(ctx, c.wind.span), profileCitation(ctx.profile)]),
    );
  }
  return findings;
}

export function checkRegulatory(ctx: CheckContext, c: Conditions): Finding[] {
  const country = ctx.airport?.country ?? null;
  const jurisdiction = jurisdictionOf(country);
  const planCitation: Citation = { kind: 'plan', station: null, raw: null, span: null, text: ctx.airspace ? `airspace ${ctx.airspace}` : null, sha256: null };
  if (!ctx.airspace || !jurisdiction) {
    const why = !ctx.airspace ? `airspace class for ${ctx.waypoint} not given` : `no VFR minima table for country ${country ?? 'unknown'}`;
    return [finding(ctx, 'vfr.minima', 'advisory', `${why} — regulatory VFR minima not evaluated`, { airspace: ctx.airspace, country }, [planCitation])];
  }
  const elevation = ctx.airport?.elevation ?? 0;
  const agl = ftAgl(ctx.cruiseAltitude - elevation);
  const minima = vfrMinima({ jurisdiction, airspace: ctx.airspace, altitudeMsl: ctx.cruiseAltitude, altitudeAgl: agl, night: ctx.night });
  const findings: Finding[] = [];
  const ruleCitation: Citation = { kind: 'plan', station: null, raw: null, span: null, text: minima.rule, sha256: null };

  if (c.visibility) {
    const miles = visibilityStatuteMiles(c.visibility.value);
    if (miles !== null) {
      const ok = miles >= minima.visibility;
      findings.push(finding(ctx, 'vfr.visibility', ok ? 'ok' : ctx.violation, `visibility ${fmtVis(c.visibility.value)} ${ok ? 'meets' : 'is below'} ${minima.rule} minimum ${minima.visibility} SM`, { visibilitySm: miles, minimum: minima.visibility, rule: minima.rule }, [cite(ctx, c.visibility.span), ruleCitation]));
    }
  }
  const ceiling = ceilingOf(c.sky);
  if (minima.ceiling !== null && ceiling) {
    const ok = ceiling.value >= minima.ceiling;
    findings.push(finding(ctx, 'vfr.ceiling', ok ? 'ok' : ctx.violation, `ceiling ${ceiling.value} ft ${ok ? 'meets' : 'is below'} ${minima.rule} ${minima.ceiling} ft`, { ceiling: ceiling.value, minimum: minima.ceiling, rule: minima.rule }, [cite(ctx, ceiling.span), ruleCitation]));
  }
  if (minima.cloudClearance) {
    // Cruise altitude against each broken/overcast base: below the base by at least the required margin.
    for (const layer of c.sky) {
      const v = layer.value;
      if (v.kind !== 'layer' || v.base === null || (v.amount !== 'BKN' && v.amount !== 'OVC')) continue;
      const baseMsl = v.base + elevation;
      const clearance = baseMsl - ctx.cruiseAltitude;
      const ok = clearance >= minima.cloudClearance.below;
      findings.push(finding(ctx, 'vfr.cloudClearance', ok ? 'ok' : ctx.violation, `${sliceSpan(ctx.source.raw, layer.span)} base ${baseMsl} ft MSL is ${Math.round(clearance)} ft above cruise ${ctx.cruiseAltitude} ft; ${minima.rule} requires ${minima.cloudClearance.below} ft below cloud`, { baseMsl, cruiseMsl: ctx.cruiseAltitude, clearance, required: minima.cloudClearance.below }, [cite(ctx, layer.span), ruleCitation]));
    }
  }
  if (findings.length === 0) {
    findings.push(finding(ctx, 'vfr.minima', 'advisory', `${minima.rule}: nothing to evaluate in these conditions`, { rule: minima.rule }, [ruleCitation]));
  }
  return findings;
}

export function checkNight(ctx: CheckContext): Finding[] {
  if (!ctx.night) return [];
  const ok = ctx.profile.nightAllowed;
  return [finding(ctx, 'personal.night', ok ? 'advisory' : ctx.violation, ok ? 'night (sun below civil twilight) at this time' : 'night at this time; profile does not allow night flight', { night: true }, [profileCitation(ctx.profile)])];
}

/** All checks over one set of conditions. */
export function checkConditions(ctx: CheckContext, c: Conditions): Finding[] {
  return [...checkCeiling(ctx, c), ...checkVisibility(ctx, c), ...checkCrosswind(ctx, c), ...checkRegulatory(ctx, c)];
}
