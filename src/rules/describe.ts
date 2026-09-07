import { toZulu } from '../domain/time.js';
import type { Briefing, Finding, PointVerdict, Severity } from './types.js';

const MARK: Record<Severity, string> = { ok: '  ok   ', advisory: '  info ', marginal: '  MARG ', 'no-go': '  NO-GO' };

function findingLine(f: Finding): string {
  const src = f.citations.find((c) => c.text !== null && (c.kind === 'taf' || c.kind === 'metar'));
  const quote = src?.text ? `  ← "${src.text}"` : '';
  return `${MARK[f.severity]}  [${f.basis}] ${f.summary}${quote}`;
}

function pointText(p: PointVerdict): string[] {
  const lines = [`${p.verdict.toUpperCase().padEnd(8)} ${p.waypoint}  at ${toZulu(new Date(p.at))}${p.night ? '  (night)' : ''}`];
  for (const f of p.findings) lines.push(findingLine(f));
  return lines;
}

export function briefingText(b: Briefing): string {
  const lines = [
    `VERDICT: ${b.verdict.toUpperCase()}   profile ${b.profile.name} v${b.profile.version}${b.aircraft ? `, ${b.aircraft}` : ''}   as of ${toZulu(new Date(b.asOf))}`,
    'Study and planning aid only — not an official briefing. Every line shows the report text it was judged on.',
    '',
  ];
  for (const p of b.points) lines.push(...pointText(p), '');
  if (b.alternate) lines.push('alternate:', ...pointText(b.alternate), '');
  return lines.join('\n');
}
