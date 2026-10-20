/**
 * Plain-text rendering of resolved forecasts, built from the source spans so
 * that what is printed is exactly what the TAF said. Used by the CLI; the
 * web UI will highlight the same spans.
 */

import type { Conditions } from '../decode/conditions.js';
import { sliceSpan } from '../decode/span.js';
import { toZulu } from '../domain/time.js';
import type { ResolvedFlight, ResolvedPoint } from './flight.js';
import type { ResolvedForecast } from './taf.js';

/** The condition groups as written in the report, space-separated. */
export function conditionsText(raw: string, c: Conditions): string {
  const parts: string[] = [];
  const push = (s: { span: { start: number; end: number } } | null) => {
    if (s) parts.push(sliceSpan(raw, s.span));
  };
  push(c.wind);
  push(c.visibility);
  c.weather.forEach(push);
  push(c.noSignificantWeather);
  c.sky.forEach(push);
  push(c.windShear);
  return parts.length > 0 ? parts.join(' ') : '(nothing specified)';
}

const hhmm = (d: Date) => toZulu(d).slice(11, 16) + 'Z';

export function forecastText(f: ResolvedForecast): string[] {
  const lines: string[] = [];
  if (f.outsideValidity || !f.prevailing) {
    lines.push(`  outside TAF validity${f.validity ? ` (${toZulu(f.validity.from)} – ${toZulu(f.validity.to)})` : ''}`);
    return lines;
  }
  lines.push(`  prevailing: ${conditionsText(f.raw, f.prevailing.conditions)}`);
  for (const s of f.prevailing.sources) {
    lines.push(`    from ${s.period.kind === 'base' ? 'base period' : sliceSpan(f.raw, s.period.indicator!.span)} ${hhmm(s.from)}–${hhmm(s.to)}: "${sliceSpan(f.raw, s.period.span)}"`);
  }
  for (const o of f.overlays) {
    const label = o.probability ? `PROB${o.probability} ${o.kind === 'PROB' ? '' : o.kind}`.trim() : o.kind;
    lines.push(`  overlay ${label} ${hhmm(o.window.from)}–${hhmm(o.window.to)}: ${conditionsText(f.raw, o.conditions)}`);
    lines.push(`    "${sliceSpan(f.raw, o.window.period.span)}"`);
  }
  for (const u of f.unplaced) lines.push(`  unplaced period (no time group): "${sliceSpan(f.raw, u.span)}"`);
  return lines;
}

function pointText(p: ResolvedPoint): string[] {
  const w = p.point.waypoint;
  const name = w.airport ? `${w.id} ${w.airport.name}` : w.id;
  const head = `${p.point.cumulative.toFixed(1).padStart(6)} nm  ${name}  ETA ${toZulu(p.point.eta)}`;
  const lines = [head];
  if (p.metar) lines.push(`  METAR ${p.metar.report.issuedAt ? toZulu(p.metar.report.issuedAt) : ''}: ${p.metar.report.body}`);
  if (!p.forecast) {
    lines.push('  no TAF at this field and none within 60 nm — no forecast available');
    return lines;
  }
  const src = p.forecast.source === 'own' ? 'own TAF' : `nearest TAF, ${p.forecast.station} at ${p.forecast.distance.toFixed(0)} nm — interpolated, not this field's forecast`;
  lines.push(`  TAF ${p.forecast.station} issued ${toZulu(p.forecast.resolved.issued)} (${src})`);
  lines.push(...forecastText(p.forecast.resolved));
  return lines;
}

export function flightText(f: ResolvedFlight): string {
  const ids = f.route.points.map((p) => p.waypoint.id).join(' → ');
  const lines = [
    `${ids}${f.route.alternate ? `  alt ${f.route.alternate.point.waypoint.id}` : ''}   dep ${toZulu(new Date(f.plan.departureTime))}   TAS ${f.plan.cruise.tas} kt   ${f.plan.cruise.altitude} ft MSL   total ${f.route.total.toFixed(1)} nm`,
    `briefed as of ${toZulu(f.asOf)} — study aid only, not an official briefing`,
    '',
  ];
  for (const p of f.points) lines.push(...pointText(p), '');
  if (f.alternate) lines.push('alternate:', ...pointText(f.alternate), '');
  return lines.join('\n');
}
