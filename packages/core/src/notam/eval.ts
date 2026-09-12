/**
 * The eval harness: a labelled set scored against what the model said.
 * Labels are per NOTAM per flight context. Agreement is the headline;
 * per-class precision and recall show where it fails; the confusion table
 * shows how.
 */

import type { Category, Relevance } from './assess.js';
import { RELEVANCES } from './assess.js';
import type { RankedNotam } from './flight.js';

export interface LabelledNotam {
  /** The NOTAM id (`J5067/26`); the raw hash is not stable across re-issues. */
  readonly notamId: string;
  readonly relevance: Relevance;
  readonly category: Category | null;
  /** Who labelled it and how confident: the owner, or a provisional panel. */
  readonly labelledBy: string;
  readonly note: string | null;
}

export interface LabelledSet {
  readonly flight: string;
  readonly description: string;
  readonly labels: readonly LabelledNotam[];
}

export interface EvalScore {
  readonly total: number;
  /** Labelled NOTAMs the run produced no assessment for (out of scope, unverified, failed). */
  readonly missing: number;
  readonly agreement: number;
  readonly perClass: Readonly<Record<Relevance, { precision: number; recall: number; support: number }>>;
  readonly confusion: Readonly<Record<Relevance, Readonly<Record<Relevance, number>>>>;
  readonly categoryAgreement: number | null;
  readonly disagreements: readonly { readonly notamId: string; readonly expected: Relevance; readonly actual: Relevance | null }[];
}

export function scoreAssessments(set: LabelledSet, items: readonly RankedNotam[]): EvalScore {
  const byId = new Map(items.map((i) => [i.decoded.id?.value.text ?? i.report.sha256, i]));
  const confusion: Record<Relevance, Record<Relevance, number>> = Object.fromEntries(
    RELEVANCES.map((e) => [e, Object.fromEntries(RELEVANCES.map((a) => [a, 0])) as Record<Relevance, number>]),
  ) as Record<Relevance, Record<Relevance, number>>;
  const disagreements: { notamId: string; expected: Relevance; actual: Relevance | null }[] = [];
  let missing = 0;
  let agree = 0;
  let catAgree = 0;
  let catTotal = 0;
  for (const label of set.labels) {
    const item = byId.get(label.notamId);
    const actual = item?.assessment && item.assessment.citation !== 'none' ? item.assessment.assessment.relevance : null;
    if (actual === null) {
      missing++;
      disagreements.push({ notamId: label.notamId, expected: label.relevance, actual: null });
      continue;
    }
    confusion[label.relevance][actual]++;
    if (actual === label.relevance) agree++;
    else disagreements.push({ notamId: label.notamId, expected: label.relevance, actual });
    if (label.category) {
      catTotal++;
      if (item!.assessment!.assessment.category === label.category) catAgree++;
    }
  }
  const perClass = Object.fromEntries(
    RELEVANCES.map((c) => {
      const tp = confusion[c][c];
      const predicted = RELEVANCES.reduce((s, e) => s + confusion[e][c], 0);
      const support = RELEVANCES.reduce((s, a) => s + confusion[c][a], 0);
      return [c, { precision: predicted ? tp / predicted : 0, recall: support ? tp / support : 0, support }];
    }),
  ) as EvalScore['perClass'];
  const total = set.labels.length;
  return {
    total,
    missing,
    agreement: total - missing > 0 ? agree / (total - missing) : 0,
    perClass,
    confusion,
    categoryAgreement: catTotal > 0 ? catAgree / catTotal : null,
    disagreements,
  };
}
