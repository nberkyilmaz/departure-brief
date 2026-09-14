/**
 * What changed between two briefings of the same flight.
 *
 * The diff is **against the verdict, not the raw text**. A TAF reissued with
 * identical content produces an identical briefing hash and no diff at all.
 * A ceiling moving 2,000 → 1,800 ft with a 1,500 ft minimum is not news; a
 * ceiling moving 1,600 → 1,400 crosses the threshold and is the most
 * important thing on the screen. The rules engine already encodes every
 * threshold in a finding's severity, so "crossed a personal minimum" is
 * exactly "this finding's severity moved across the ok boundary" — no
 * second copy of the limits, and it stays true for rules added later.
 */

import type { BasisKind, Finding, PointVerdict, Severity, Verdict } from '../rules/types.js';
import type { NotamDocumentItem } from '../notam/describe.js';
import type { BriefingDocument, BriefingReportRef } from './types.js';

/** Worse is a larger number. `advisory` never moves a verdict, so it sits with `ok`. */
const WEIGHT: Record<Severity, number> = { ok: 0, advisory: 0, marginal: 1, 'no-go': 2 };

export type FindingChangeKind = 'appeared' | 'resolved' | 'worsened' | 'eased' | 'restated';

export interface FindingChange {
  readonly kind: FindingChangeKind;
  readonly waypoint: string;
  readonly rule: string;
  readonly basisKind: BasisKind;
  readonly before: Finding | null;
  readonly after: Finding | null;
  /**
   * True when the change crosses the go/no-go boundary — a limit newly
   * breached or newly met. These are the lines that matter.
   */
  readonly crossesLimit: boolean;
}

export interface PointDiff {
  readonly waypoint: string;
  readonly verdict: { readonly from: Verdict; readonly to: Verdict } | null;
  readonly changes: readonly FindingChange[];
}

export interface NotamChange {
  readonly kind: 'new' | 'gone' | 'rank-changed';
  readonly id: string | null;
  readonly sha256: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly summary: string;
  /**
   * Worth the pilot's attention on sight. A NOTAM outside the flight's window
   * or area, or judged irrelevant, is still listed — it is simply not news.
   */
  readonly notable: boolean;
}

/** In scope and not dismissed: the ranks a pilot must actually read. */
function notableRank(rank: string | null): boolean {
  return rank !== null && rank !== 'out-of-scope' && rank !== 'irrelevant';
}

export interface BriefingDiff {
  readonly from: { readonly sha256: string; readonly asOf: string; readonly verdict: Verdict };
  readonly to: { readonly sha256: string; readonly asOf: string; readonly verdict: Verdict };
  /** `null` when the overall verdict did not move. */
  readonly verdict: { readonly from: Verdict; readonly to: Verdict } | null;
  readonly points: readonly PointDiff[];
  readonly alternate: PointDiff | null;
  readonly notams: readonly NotamChange[];
  /** Reports that came or went — context for why a finding moved. */
  readonly reports: { readonly added: readonly BriefingReportRef[]; readonly removed: readonly BriefingReportRef[] };
  /** Set when the two briefings judged different flights or profiles; the diff is then not like-for-like. */
  readonly warnings: readonly string[];
  /** True when nothing worth telling the pilot changed. */
  readonly quiet: boolean;
}

/**
 * Pre-`basisKind` briefings: recover the kind from the readable basis.
 *
 * Every basis string the rules can emit needs a case here. Without one a
 * finding falls through to `overlay`, its identity changes, and the diff
 * reports it as having appeared when nothing happened at all.
 */
function basisKindOf(f: Finding): BasisKind {
  if (f.basisKind) return f.basisKind;
  if (f.basis.startsWith('prevailing')) return 'prevailing';
  if (f.basis.startsWith('observed')) return 'observed';
  if (f.basis === 'forecast') return 'forecast';
  if (f.basis === 'time' || f.basis === 'daylight') return 'time';
  if (f.basis.endsWith('upper wind')) return 'forecast';
  return 'overlay';
}

/** Identity of a check across briefings: same waypoint, same rule, same kind of evidence. */
const keyOf = (f: Finding) => `${f.waypoint}|${f.rule}|${basisKindOf(f)}`;

function findingChanges(before: readonly Finding[], after: readonly Finding[]): FindingChange[] {
  const b = new Map(before.map((f) => [keyOf(f), f]));
  const a = new Map(after.map((f) => [keyOf(f), f]));
  const changes: FindingChange[] = [];
  const common = (f: Finding) => ({ waypoint: f.waypoint, rule: f.rule, basisKind: basisKindOf(f) });

  for (const [key, f] of a) {
    const was = b.get(key);
    if (!was) {
      changes.push({ kind: 'appeared', ...common(f), before: null, after: f, crossesLimit: WEIGHT[f.severity] > 0 });
      continue;
    }
    const from = WEIGHT[was.severity];
    const to = WEIGHT[f.severity];
    if (to > from) changes.push({ kind: 'worsened', ...common(f), before: was, after: f, crossesLimit: from === 0 });
    else if (to < from) changes.push({ kind: 'eased', ...common(f), before: was, after: f, crossesLimit: to === 0 });
    else if (was.summary !== f.summary) changes.push({ kind: 'restated', ...common(f), before: was, after: f, crossesLimit: false });
  }
  for (const [key, f] of b) {
    if (!a.has(key)) changes.push({ kind: 'resolved', ...common(f), before: f, after: null, crossesLimit: WEIGHT[f.severity] > 0 });
  }
  // Threshold crossings first, then worsening before easing, then by waypoint.
  const rank: Record<FindingChangeKind, number> = { worsened: 0, appeared: 1, eased: 2, resolved: 3, restated: 4 };
  return changes.sort(
    (x, y) => Number(y.crossesLimit) - Number(x.crossesLimit) || rank[x.kind] - rank[y.kind] || x.waypoint.localeCompare(y.waypoint) || x.rule.localeCompare(y.rule),
  );
}

function pointDiff(before: PointVerdict | undefined, after: PointVerdict): PointDiff {
  const changes = findingChanges(before?.findings ?? [], after.findings);
  const verdict = before && before.verdict !== after.verdict ? { from: before.verdict, to: after.verdict } : null;
  return { waypoint: after.waypoint, verdict, changes };
}

function notamChanges(before: BriefingDocument, after: BriefingDocument): NotamChange[] {
  const b = before.notams?.items ?? [];
  const a = after.notams?.items ?? [];
  if (b.length === 0 && a.length === 0) return [];
  const key = (n: NotamDocumentItem) => n.id ?? n.sha256;
  const byBefore = new Map(b.map((n) => [key(n), n]));
  const byAfter = new Map(a.map((n) => [key(n), n]));
  const out: NotamChange[] = [];
  for (const [k, n] of byAfter) {
    const was = byBefore.get(k);
    const summary = (n.assessment?.result.plain_text ?? n.text ?? n.raw).replace(/\s+/g, ' ').slice(0, 160);
    if (!was) out.push({ kind: 'new', id: n.id, sha256: n.sha256, from: null, to: n.rank, summary, notable: notableRank(n.rank) });
    else if (was.rank !== n.rank) out.push({ kind: 'rank-changed', id: n.id, sha256: n.sha256, from: was.rank, to: n.rank, summary, notable: notableRank(n.rank) || notableRank(was.rank) });
  }
  for (const [k, n] of byBefore) {
    if (!byAfter.has(k)) {
      out.push({ kind: 'gone', id: n.id, sha256: n.sha256, from: n.rank, to: null, summary: (n.text ?? n.raw).replace(/\s+/g, ' ').slice(0, 160), notable: false });
    }
  }
  const order: Record<NotamChange['kind'], number> = { new: 0, 'rank-changed': 1, gone: 2 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || (x.id ?? '').localeCompare(y.id ?? ''));
}

/**
 * Diff two briefings. `before` should be the older one; the caller decides
 * which is which, and a mismatch in flight or profile is warned about rather
 * than refused — seeing the comparison is more useful than being blocked.
 */
export function diffBriefings(
  before: { sha256: string; document: BriefingDocument },
  after: { sha256: string; document: BriefingDocument },
): BriefingDiff {
  const warnings: string[] = [];
  const bp = before.document.plan;
  const ap = after.document.plan;
  if (bp.departure !== ap.departure || bp.destination !== ap.destination || bp.departureTime !== ap.departureTime) {
    warnings.push('these briefings are for different flights; the comparison is not like for like');
  }
  if (before.document.profile.name !== after.document.profile.name || before.document.profile.version !== after.document.profile.version) {
    warnings.push(`judged against different profiles (${before.document.profile.name} v${before.document.profile.version} → ${after.document.profile.name} v${after.document.profile.version})`);
  }
  if (before.document.versions.rules !== after.document.versions.rules) {
    warnings.push(`judged by different rules versions (${before.document.versions.rules} → ${after.document.versions.rules}); some changes may be ours, not the weather's`);
  }

  const bPoints = new Map(before.document.briefing.points.map((p) => [p.waypoint, p]));
  const points = after.document.briefing.points.map((p) => pointDiff(bPoints.get(p.waypoint), p));
  const alternate = after.document.briefing.alternate ? pointDiff(before.document.briefing.alternate ?? undefined, after.document.briefing.alternate) : null;

  const bReports = new Map(before.document.inputs.reports.map((r) => [r.sha256, r]));
  const aReports = new Map(after.document.inputs.reports.map((r) => [r.sha256, r]));
  const added = [...aReports.values()].filter((r) => !bReports.has(r.sha256));
  const removed = [...bReports.values()].filter((r) => !aReports.has(r.sha256));

  const notams = notamChanges(before.document, after.document);
  const verdict = before.document.briefing.verdict !== after.document.briefing.verdict ? { from: before.document.briefing.verdict, to: after.document.briefing.verdict } : null;

  const material =
    verdict !== null ||
    notams.some((n) => n.notable) ||
    [...points, ...(alternate ? [alternate] : [])].some((p) => p.verdict !== null || p.changes.some((c) => c.kind !== 'restated'));

  return {
    from: { sha256: before.sha256, asOf: before.document.asOf, verdict: before.document.briefing.verdict },
    to: { sha256: after.sha256, asOf: after.document.asOf, verdict: after.document.briefing.verdict },
    verdict,
    points,
    alternate,
    notams,
    reports: { added, removed },
    warnings,
    quiet: !material,
  };
}
