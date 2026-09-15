/**
 * What the forecast wind at cruise means for this flight.
 *
 * Two things a pilot takes from the upper wind column. The wind itself,
 * which sets the groundspeed and therefore the fuel — reported here,
 * computed into a nav log later. And the temperature, which is the first
 * question about airframe icing: below freezing, cloud or precipitation on
 * the route stops being merely inconvenient.
 *
 * Neither grounds a flight on its own, so neither is more than advisory.
 * The one that could — ice in cloud at a temperature below freezing —
 * needs the cloud as well, and that comes from the forecast the other
 * checks already read.
 */
import type { WaypointWind } from '../resolve/wind.js';
import type { Citation, Finding, Attention } from './types.js';

/** The temperature at or below which ice is possible in visible moisture. */
export const FREEZING_C = 0;

const compass = (deg: number): string => String(Math.round(deg) === 0 ? 360 : Math.round(deg)).padStart(3, '0');

/** How the wind reads on a briefing sheet: `330° at 22 kt`, or light and variable. */
export function windText(wind: WaypointWind['wind']): string {
  if (wind.directionTrue === null) return wind.speedKt === 0 ? 'light and variable' : `variable at ${wind.speedKt} kt`;
  return `${compass(wind.directionTrue)}°T at ${wind.speedKt} kt`;
}

/**
 * One citation per forecast level the answer came from. An interpolated
 * wind is made of two levels and cites both: a single span covering them
 * would also cover everything printed in between, which is not what was
 * read.
 */
function citationsFor(w: WaypointWind): Citation[] {
  return w.wind.from.map((level) => ({
    kind: 'upperwind' as const,
    station: w.station,
    raw: w.report.body,
    span: level.span,
    text: null,
    sha256: w.report.sha256,
  }));
}

export interface WindAloftContext {
  readonly waypoint: string;
  readonly at: Date;
  readonly cruiseAltitude: number;
}

export function checkWindAloft(ctx: WindAloftContext, w: WaypointWind | null): Finding[] {
  if (!w) return [];
  const findings: Finding[] = [];
  const citations = citationsFor(w);
  const altitude = `${w.wind.altitudeFt.toLocaleString('en')} ft`;
  const borrowed = w.source === 'nearby' ? `, from ${w.station} ${Math.round(w.distance)} nm away` : '';
  const basis = w.forecast.bulletin?.value ? `${w.forecast.bulletin.value} upper wind` : 'upper wind';

  /*
   * Below the lowest forecast level the answer is the 3,000 ft wind, not
   * the wind at the altitude asked for. Saying which is the difference
   * between a figure a pilot can use and one that quietly misleads.
   */
  const reach =
    w.wind.basis === 'below-lowest'
      ? ` — the lowest level forecast; below it the wind is heading for the surface and this says nothing about that`
      : w.wind.basis === 'above-highest'
        ? ' — the highest level forecast'
        : '';

  findings.push({
    rule: 'wind.aloft',
    attention: 'routine',
    summary: `wind at ${altitude}: ${windText(w.wind)}${w.wind.tempC !== null ? `, ${w.wind.tempC > 0 ? '+' : ''}${w.wind.tempC} °C` : ''}${borrowed}${reach}`,
    waypoint: ctx.waypoint,
    basis,
    basisKind: 'forecast',
    at: ctx.at.toISOString(),
    values: {
      altitudeFt: w.wind.altitudeFt,
      directionTrue: w.wind.directionTrue,
      speedKt: w.wind.speedKt,
      tempC: w.wind.tempC,
      station: w.station,
      distanceNm: w.distance,
      basis: w.wind.basis,
    },
    citations,
  });

  if (w.wind.tempC !== null && w.wind.tempC <= FREEZING_C) {
    findings.push({
      rule: 'wind.freezing',
      attention: 'note' as Attention,
      summary: `${w.wind.tempC} °C at ${altitude} — at or below freezing, so ice is possible in cloud or precipitation at cruise`,
      waypoint: ctx.waypoint,
      basis,
      basisKind: 'forecast',
      at: ctx.at.toISOString(),
      values: { tempC: w.wind.tempC, altitudeFt: w.wind.altitudeFt },
      citations,
    });
  }
  return findings;
}
