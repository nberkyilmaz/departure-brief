import { toZulu } from '../domain/time.js';
import type { BriefingDiff, FindingChange, PointDiff } from './diff.js';

const ARROW = '->';

function changeLine(c: FindingChange): string {
  const mark = c.crossesLimit ? ' **' : '   ';
  const f = c.after ?? c.before!;
  switch (c.kind) {
    case 'appeared':
      return `${mark} new     [${f.basis}] ${f.summary}`;
    case 'resolved':
      return `${mark} gone    [${f.basis}] ${c.before!.summary}`;
    case 'worsened':
      return `${mark} worse   [${f.basis}] ${c.before!.severity} ${ARROW} ${c.after!.severity}: ${c.after!.summary}`;
    case 'eased':
      return `${mark} better  [${f.basis}] ${c.before!.severity} ${ARROW} ${c.after!.severity}: ${c.after!.summary}`;
    case 'restated':
      return `     same    [${f.basis}] ${c.after!.summary}`;
  }
}

function pointLines(p: PointDiff, label = ''): string[] {
  const material = p.changes.filter((c) => c.kind !== 'restated');
  if (!p.verdict && material.length === 0) return [];
  const head = p.verdict ? `${label}${p.waypoint}: ${p.verdict.from.toUpperCase()} ${ARROW} ${p.verdict.to.toUpperCase()}` : `${label}${p.waypoint}:`;
  return [head, ...material.map(changeLine)];
}

/**
 * The diff as a pilot would want to read it: what crossed a limit first,
 * then what else moved, then what the model made of any new NOTAM.
 */
export function diffText(d: BriefingDiff): string {
  const lines: string[] = [
    `Since your ${toZulu(new Date(d.from.asOf))} briefing (now ${toZulu(new Date(d.to.asOf))})`,
    d.verdict ? `VERDICT ${d.verdict.from.toUpperCase()} ${ARROW} ${d.verdict.to.toUpperCase()}` : `verdict unchanged: ${d.to.verdict.toUpperCase()}`,
  ];
  for (const w of d.warnings) lines.push(`! ${w}`);
  if (d.quiet) {
    lines.push('', 'Nothing material changed. Values moved without crossing any of your limits.');
  }
  lines.push('');
  for (const p of d.points) lines.push(...pointLines(p));
  if (d.alternate) lines.push(...pointLines(d.alternate, 'alternate '));

  const newNotams = d.notams.filter((n) => n.kind === 'new');
  const changed = d.notams.filter((n) => n.kind === 'rank-changed');
  const gone = d.notams.filter((n) => n.kind === 'gone');
  if (newNotams.length + changed.length + gone.length > 0) lines.push('', 'NOTAMs:');
  for (const n of newNotams) lines.push(`${n.notable ? ' **' : '   '} new     ${n.id ?? ''} (${n.to}) ${n.summary}`);
  for (const n of changed) lines.push(`${n.notable ? ' **' : '   '} changed ${n.id ?? ''} ${n.from} ${ARROW} ${n.to}: ${n.summary}`);
  for (const n of gone) lines.push(`    gone    ${n.id ?? ''} ${n.summary}`);

  if (d.reports.added.length > 0) {
    lines.push('', `New reports since: ${d.reports.added.map((r) => `${r.kind.toUpperCase()} ${r.station ?? ''}`.trim()).join(', ')}`);
  }
  lines.push('', 'Lines marked ** crossed one of your limits. Study aid only — not an official briefing.');
  return lines.join('\n');
}
