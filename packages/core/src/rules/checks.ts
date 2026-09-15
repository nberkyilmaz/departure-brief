/**
 * The individual checks, each a pure function of one set of conditions plus
 * the profile/aircraft/airport, producing findings with citations. The
 * caller decides the severity of a violation (hard for prevailing and
 * observed conditions, soft for overlays) — see `evaluate.ts`.
 */

import type { Conditions } from '../decode/conditions.js';
import type { WeatherGroup, WeatherPhenomenon } from '../decode/groups/weather.js';
import type { SkyCondition } from '../decode/groups/sky.js';
import type { Visibility } from '../decode/groups/visibility.js';
import { ceilingOf, visibilityStatuteMiles, windKnots } from '../decode/metar/derive.js';
import type { Sourced, Span } from '../decode/span.js';
import { sliceSpan } from '../decode/span.js';
import type { Airport } from '../domain/airport.js';
import type { AirspaceClass } from '../domain/flight.js';
import type { AircraftLimits, PilotProfile } from '../domain/profile.js';
import type { FeetAgl, FeetMsl } from '../domain/units.js';
import { ftAgl } from '../domain/units.js';
import { analyseCrosswind } from './crosswind.js';
import type { Attention, BasisKind, Citation, Finding } from './types.js';
import { jurisdictionOf, vfrMinima } from './vfrMinima.js';

/** What every check needs to know about where its conditions came from. */
export interface CheckContext {
  readonly waypoint: string;
  readonly at: Date;
  readonly basis: string;
  readonly basisKind: BasisKind;
  /**
   * How much attention a crossed limit deserves here: `alert` in the
   * prevailing forecast or the observation, `caution` in a TEMPO, PROB or
   * in-progress BECMG. Not a verdict — a statement about how firmly the
   * product says it.
   */
  readonly violation: Extract<Attention, 'caution' | 'alert'>;
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

function finding(ctx: CheckContext, rule: string, attention: Attention, summary: string, values: Record<string, unknown>, citations: Citation[]): Finding {
  return { rule, attention, summary, waypoint: ctx.waypoint, basis: ctx.basis, basisKind: ctx.basisKind, at: ctx.at.toISOString(), values, citations };
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
    return [finding(ctx, 'personal.ceiling', 'note', 'no sky condition given — ceiling not evaluated', { minimum: min }, [profileCitation(ctx.profile)])];
  }
  const ceiling = ceilingOf(c.sky);
  if (!ceiling) {
    /*
     * `BKN///` and `VV///` mean there is a ceiling and the equipment could
     * not measure its height. Reporting that as "no ceiling" reads as a
     * clear sky, which is the opposite of what the report says — so it is
     * called out, and it cannot be compared against a minimum at all.
     */
    const indeterminate = c.sky.filter((layer) => {
      const v = layer.value;
      return (v.kind === 'layer' && (v.amount === 'BKN' || v.amount === 'OVC') && v.base === null) || (v.kind === 'verticalVisibility' && v.height === null);
    });
    if (indeterminate.length > 0) {
      const groups = indeterminate.map((layer) => sliceSpan(ctx.source.raw, layer.span)).join(' ');
      return [
        finding(
          ctx,
          'personal.ceiling',
          ctx.violation,
          `${groups}: there is a ceiling and its height was not measured, so it cannot be compared against your minimum of ${min} ft AGL`,
          { ceiling: null, indeterminate: true, minimum: min },
          [cite(ctx, indeterminate[0]!.span), profileCitation(ctx.profile)],
        ),
      ];
    }
    const groups = c.sky.map((s) => sliceSpan(ctx.source.raw, s.span)).join(' ') || 'CAVOK';
    return [finding(ctx, 'personal.ceiling', 'routine', `no ceiling (${groups}); personal minimum ${min} ft AGL`, { ceiling: null, minimum: min }, [cite(ctx, c.sky[0]?.span ?? c.visibility?.span ?? null), profileCitation(ctx.profile)])];
  }
  const ok = ceiling.value >= min;
  return [
    finding(
      ctx,
      'personal.ceiling',
      ok ? 'routine' : ctx.violation,
      `ceiling ${ceiling.value} ft AGL ${ok ? 'meets' : 'is below'} personal minimum ${min} ft`,
      { ceiling: ceiling.value, minimum: min },
      [cite(ctx, ceiling.span), profileCitation(ctx.profile)],
    ),
  ];
}

export function checkVisibility(ctx: CheckContext, c: Conditions): Finding[] {
  const min = ctx.profile.visibility;
  if (!c.visibility) {
    return [finding(ctx, 'personal.visibility', 'note', 'no visibility given — not evaluated', { minimum: min }, [profileCitation(ctx.profile)])];
  }
  const v = c.visibility.value;
  const miles = visibilityStatuteMiles(v);
  if (miles === null) {
    return [finding(ctx, 'personal.visibility', 'note', 'visibility reported missing — not evaluated', { minimum: min }, [cite(ctx, c.visibility.span)])];
  }
  // `M1/4SM` is strictly less than the figure; `P6SM` is more than it.
  const effective = v.kind === 'statute' && v.qualifier === 'lessThan' ? miles - 1e-9 : miles;
  const ok = effective >= min;
  return [
    finding(
      ctx,
      'personal.visibility',
      ok ? 'routine' : ctx.violation,
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
    return [finding(ctx, 'crosswind.personal', 'note', 'no wind given — crosswind not evaluated', { limit }, [profileCitation(ctx.profile)])];
  }
  const analysis = analyseCrosswind(c.wind.value, ctx.airport);
  const windText = sliceSpan(ctx.source.raw, c.wind.span);
  if (!analysis) {
    return [finding(ctx, 'crosswind.personal', 'note', `wind ${windText}: direction or speed not reported — crosswind not evaluated`, { limit }, [cite(ctx, c.wind.span)])];
  }
  const airportCitation: Citation = { kind: 'airport', station: ctx.airport.icaoId ?? ctx.airport.faaId, raw: null, span: null, text: `${ctx.airport.source} ${ctx.airport.cycle}`, sha256: null };
  if (analysis.runways.length === 0) {
    return [finding(ctx, 'crosswind.personal', 'note', `no runway headings known for ${ctx.waypoint} — crosswind not evaluated`, { unknownHeading: analysis.unknownHeading }, [airportCitation])];
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
      ok ? 'routine' : ctx.violation,
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
        within ? 'routine' : ctx.violation,
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
      finding(ctx, 'wind.gustSpread', ok2 ? 'routine' : ctx.violation, `gust spread ${spread} kt ${ok2 ? 'within' : 'exceeds'} personal limit ${ctx.profile.maxGustSpread} kt`, { spread, limit: ctx.profile.maxGustSpread }, [cite(ctx, c.wind.span), profileCitation(ctx.profile)]),
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
    return [finding(ctx, 'vfr.minima', 'note', `${why} — regulatory VFR minima not evaluated`, { airspace: ctx.airspace, country }, [planCitation])];
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
      findings.push(finding(ctx, 'vfr.visibility', ok ? 'routine' : ctx.violation, `visibility ${fmtVis(c.visibility.value)} ${ok ? 'meets' : 'is below'} ${minima.rule} minimum ${minima.visibility} SM`, { visibilitySm: miles, minimum: minima.visibility, rule: minima.rule }, [cite(ctx, c.visibility.span), ruleCitation]));
    }
  }
  const ceiling = ceilingOf(c.sky);
  if (minima.ceiling !== null && ceiling) {
    const ok = ceiling.value >= minima.ceiling;
    findings.push(finding(ctx, 'vfr.ceiling', ok ? 'routine' : ctx.violation, `ceiling ${ceiling.value} ft ${ok ? 'meets' : 'is below'} ${minima.rule} ${minima.ceiling} ft`, { ceiling: ceiling.value, minimum: minima.ceiling, rule: minima.rule }, [cite(ctx, ceiling.span), ruleCitation]));
  }
  if (minima.cloudClearance) {
    // Cruise altitude against each broken/overcast base: below the base by at least the required margin.
    for (const layer of c.sky) {
      const v = layer.value;
      if (v.kind !== 'layer' || v.base === null || (v.amount !== 'BKN' && v.amount !== 'OVC')) continue;
      const baseMsl = v.base + elevation;
      const clearance = baseMsl - ctx.cruiseAltitude;
      const ok = clearance >= minima.cloudClearance.below;
      findings.push(finding(ctx, 'vfr.cloudClearance', ok ? 'routine' : ctx.violation, `${sliceSpan(ctx.source.raw, layer.span)} base ${baseMsl} ft MSL is ${Math.round(clearance)} ft above cruise ${ctx.cruiseAltitude} ft; ${minima.rule} requires ${minima.cloudClearance.below} ft below cloud`, { baseMsl, cruiseMsl: ctx.cruiseAltitude, clearance, required: minima.cloudClearance.below }, [cite(ctx, layer.span), ruleCitation]));
    }
  }
  if (findings.length === 0) {
    findings.push(finding(ctx, 'vfr.minima', 'note', `${minima.rule}: nothing to evaluate in these conditions`, { rule: minima.rule }, [ruleCitation]));
  }
  return findings;
}

export function checkNight(ctx: CheckContext): Finding[] {
  if (!ctx.night) return [];
  const ok = ctx.profile.nightAllowed;
  return [finding(ctx, 'personal.night', ok ? 'note' : ctx.violation, ok ? 'night (sun below civil twilight) at this time' : 'night at this time; profile does not allow night flight', { night: true }, [profileCitation(ctx.profile)])];
}


/**
 * How loudly a present-weather group asks to be read.
 *
 * These are not comparisons against anybody's limits — they are facts about
 * what is falling out of the sky, and a pilot decides what to do about them.
 * What this fixes is that the decoder read `+TSRA FZRA` correctly and then
 * no rule looked at it, so a heavy thunderstorm with freezing rain produced
 * three lines saying everything was within limits.
 */
const ALERT_PHENOMENA: ReadonlySet<WeatherPhenomenon> = new Set(['GR', 'FC', 'SQ', 'DS', 'SS', 'VA']);
const CAUTION_PHENOMENA: ReadonlySet<WeatherPhenomenon> = new Set(['SN', 'SG', 'PL', 'IC', 'GS', 'FG', 'PO']);

function weatherAttention(g: WeatherGroup): Attention {
  // A thunderstorm, or anything freezing, whatever else is in the group.
  if (g.descriptor === 'TS' || g.descriptor === 'FZ') return 'alert';
  if (g.phenomena.some((ph) => ALERT_PHENOMENA.has(ph))) return 'alert';
  if (g.intensity === 'heavy') return 'caution';
  if (g.phenomena.some((ph) => CAUTION_PHENOMENA.has(ph))) return 'caution';
  return 'note';
}

/** In a TEMPO or a PROB, everything drops one step: the product is less certain. */
function inContext(level: Attention, ctx: CheckContext): Attention {
  if (ctx.violation === 'alert') return level;
  return level === 'alert' ? 'caution' : level === 'caution' ? 'note' : level;
}

const PHENOMENON_TEXT: Readonly<Record<string, string>> = {
  DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets',
  GR: 'hail', GS: 'small hail', UP: 'unknown precipitation', BR: 'mist', FG: 'fog', FU: 'smoke',
  VA: 'volcanic ash', DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust devils',
  SQ: 'squalls', FC: 'a funnel cloud', SS: 'a sandstorm', DS: 'a duststorm',
};
const DESCRIPTOR_TEXT: Readonly<Record<string, string>> = {
  MI: 'shallow', BC: 'patches of', PR: 'partial', DR: 'drifting', BL: 'blowing',
  SH: 'showers of', TS: 'a thunderstorm with', FZ: 'freezing',
};

/** The group in words, so the line reads without a decoding table beside it. */
export function weatherText(g: WeatherGroup): string {
  const phenomena = g.phenomena.map((ph) => PHENOMENON_TEXT[ph] ?? ph).join(' and ');
  const descriptor = g.descriptor ? DESCRIPTOR_TEXT[g.descriptor] ?? g.descriptor : null;
  const intensity = g.intensity === 'heavy' ? 'heavy ' : g.intensity === 'light' ? 'light ' : '';
  // `TS` alone is a thunderstorm; `TSRA` is a thunderstorm with rain.
  const body = descriptor && phenomena ? `${descriptor} ${intensity}${phenomena}` : descriptor ? descriptor.replace(/ with$/, '') : `${intensity}${phenomena}`;
  return `${g.vicinity ? 'in the vicinity: ' : ''}${body}`.trim();
}

/**
 * Report the present weather. Every group gets a line — nothing is
 * summarised away — and the ones that matter are the ones that sort to the
 * top.
 */
export function checkWeather(ctx: CheckContext, c: Conditions): Finding[] {
  return c.weather.map((group) =>
    finding(
      ctx,
      'weather.present',
      inContext(weatherAttention(group.value), ctx),
      `${sliceSpan(ctx.source.raw, group.span)} — ${weatherText(group.value)}`,
      { intensity: group.value.intensity, descriptor: group.value.descriptor, phenomena: [...group.value.phenomena], vicinity: group.value.vicinity },
      [cite(ctx, group.span)],
    ),
  );
}

/**
 * The surface wind, whatever direction it is from.
 *
 * The crosswind check answers "can I hold the centreline"; it says nothing
 * about a gale straight down the runway, which is how forty-five knots
 * gusting sixty used to pass without a word. The speed is always reported;
 * whether it is too much is the pilot's call unless they have said what
 * their limit is.
 */
export function checkWind(ctx: CheckContext, c: Conditions): Finding[] {
  if (!c.wind) return [];
  const w = windKnots(c.wind.value);
  if (w.speed === null) return [];
  const gust = w.gust;
  const direction = c.wind.value.direction;
  const from = direction === 'VRB' ? 'variable' : typeof direction === 'number' ? `from ${String(direction).padStart(3, '0')}°T` : 'from an unreported direction';
  const text = `wind ${from} at ${w.speed} kt${gust !== null ? ` gusting ${gust}` : ''}`;
  // The gust is what the aeroplane actually meets, so it is what is compared.
  const against = gust ?? w.speed;
  const citations = [cite(ctx, c.wind.span), profileCitation(ctx.profile)];

  const limit = ctx.profile.maxWind;
  if (limit !== null) {
    const ok = against <= limit;
    return [
      finding(
        ctx,
        'wind.surface',
        ok ? 'routine' : ctx.violation,
        `${text} — ${ok ? 'within' : 'above'} your total wind limit of ${limit} kt`,
        { speedKt: w.speed, gustKt: gust, limit, comparedAgainst: against },
        citations,
      ),
    ];
  }

  /*
   * No total wind limit set, so there is nothing to compare against
   * directly — but the total wind is an upper bound on the crosswind
   * component, and that limit does exist. A wind stronger than the
   * crosswind limit means some runway orientations are outside it; how much
   * of it lands across the runway is arithmetic the crosswind check does
   * per runway. This is not a judgement about the flight, it is what the
   * pilot's own number implies about that wind speed.
   */
  const crosswindLimit = ctx.profile.crosswind;
  if (against > crosswindLimit) {
    const angle = Math.round((Math.asin(Math.min(1, crosswindLimit / against)) * 180) / Math.PI);
    return [
      finding(
        ctx,
        'wind.surface',
        /*
         * A look, not a violation. Where the aerodrome is known, the
         * crosswind check works out what this wind actually does on each
         * runway, and that is the number to act on; this says the wind is
         * strong in absolute terms, which that check cannot say.
         */
        'caution',
        `${text} — more than your ${crosswindLimit} kt crosswind limit in total, so any runway more than ${angle}° off the wind is outside it`,
        { speedKt: w.speed, gustKt: gust, crosswindLimit, comparedAgainst: against, anglePastLimitDeg: angle },
        citations,
      ),
    ];
  }
  return [
    finding(
      ctx,
      'wind.surface',
      'routine',
      `${text} — below your ${crosswindLimit} kt crosswind limit whatever the runway`,
      { speedKt: w.speed, gustKt: gust, crosswindLimit, comparedAgainst: against },
      citations,
    ),
  ];
}

/** All checks over one set of conditions. */
export function checkConditions(ctx: CheckContext, c: Conditions): Finding[] {
  return [...checkWeather(ctx, c), ...checkCeiling(ctx, c), ...checkVisibility(ctx, c), ...checkWind(ctx, c), ...checkCrosswind(ctx, c), ...checkRegulatory(ctx, c)];
}
