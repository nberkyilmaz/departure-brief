import { toZulu } from '../domain/time.js';
import type { Briefing, EnrouteReview, Finding, PointReview, Attention } from './types.js';

const MARK: Record<Attention, string> = { routine: '  ·    ', note: '  info ', caution: '  LOOK ', alert: '  READ ' };

function findingLine(f: Finding): string {
  const src = f.citations.find((c) => c.text !== null && (c.kind === 'taf' || c.kind === 'metar'));
  const quote = src?.text ? `  ← "${src.text}"` : '';
  return `${MARK[f.attention]}  [${f.basis}] ${f.summary}${quote}`;
}

function pointText(p: PointReview): string[] {
  const lines = [`${(p.category ?? '—').padEnd(5)} ${p.waypoint}  at ${toZulu(new Date(p.at))}${p.night ? '  (night)' : ''}`];
  for (const f of p.findings) lines.push(findingLine(f));
  return lines;
}

/** Where beside the track a station is: `82 nm along, 6 nm right`. */
function abeamText(s: Pick<EnrouteReview, 'alongNm' | 'offsetNm'>): string {
  const off = Math.round(Math.abs(s.offsetNm));
  return `${Math.round(s.alongNm)} nm along, ${off === 0 ? 'on the track' : `${off} nm ${s.offsetNm > 0 ? 'right' : 'left'}`}`;
}

function enrouteText(s: EnrouteReview): string[] {
  const lines = [`${(s.forecastCategory ?? s.category ?? '—').padEnd(5)} ${s.station}  ${abeamText(s)}, abeam at ${toZulu(new Date(s.at))}${s.night ? '  (night)' : ''}`];
  for (const f of s.findings) lines.push(findingLine(f));
  return lines;
}

export function briefingText(b: Briefing): string {
  const lines = [
    `profile ${b.profile.name} v${b.profile.version}${b.aircraft ? `, ${b.aircraft}` : ''}   as of ${toZulu(new Date(b.asOf))}`,
    'Study and planning aid only — not an official briefing. Every line shows the report text it was judged on.',
    '',
  ];
  b.points.forEach((p, i) => {
    lines.push(...pointText(p), '');
    const along = b.enroute.filter((s) => s.leg === i);
    if (along.length > 0) lines.push(`along the way to ${b.points[i + 1]?.waypoint ?? ''}:`, ...along.flatMap(enrouteText), '');
  });
  if (b.alternate) lines.push('alternate:', ...pointText(b.alternate), '');
  return lines.join('\n');
}
