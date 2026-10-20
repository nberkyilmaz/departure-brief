import { toZulu } from '../domain/time.js';
import type { Briefing, Finding, PointReview, Attention } from './types.js';

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

export function briefingText(b: Briefing): string {
  const lines = [
    `profile ${b.profile.name} v${b.profile.version}${b.aircraft ? `, ${b.aircraft}` : ''}   as of ${toZulu(new Date(b.asOf))}`,
    'Study and planning aid only — not an official briefing. Every line shows the report text it was judged on.',
    '',
  ];
  for (const p of b.points) lines.push(...pointText(p), '');
  if (b.alternate) lines.push('alternate:', ...pointText(b.alternate), '');
  return lines.join('\n');
}
