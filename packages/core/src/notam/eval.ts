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
  /** Labelled NOTAMs the model was asked about but that produced no usable answer (unverified citation, failed). */
  readonly missing: number;
  /** Labelled NOTAMs the deterministic filter put out of scope, so the model was never asked; not a model error either way. */
  readonly filtered: number;
  /** Of the NOTAMs the model answered usably, the fraction it answered as the labels say. */
  readonly agreement: number;
  /**
   * Of the NOTAMs the model was asked about, the fraction it answered
   * usably at all.
   *
   * Without this the gate has a hole: `agreement` is computed over
   * answered items only, so a model that answers the five easy NOTAMs
   * correctly and returns an unverifiable citation for the other
   * twenty-six scores 100%. Declining to answer is not agreeing, and a
   * model that gets worse by answering less must be seen to get worse.
   */
  readonly coverage: number;
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
  let filtered = 0;
  let agree = 0;
  let catAgree = 0;
  let catTotal = 0;
  for (const label of set.labels) {
    const item = byId.get(label.notamId);
    if (item && item.rank === 'out-of-scope') {
      filtered++;
      continue;
    }
    const actual = item?.rule ? item.rule.relevance : item?.assessment && item.assessment.citation !== 'none' ? item.assessment.assessment.relevance : null;
    if (actual === null) {
      missing++;
      disagreements.push({ notamId: label.notamId, expected: label.relevance, actual: null });
      continue;
    }
    confusion[label.relevance][actual]++;
    if (actual === label.relevance) agree++;
    else disagreements.push({ notamId: label.notamId, expected: label.relevance, actual });
    if (label.category && item!.assessment) {
      catTotal++;
      if (item!.assessment.assessment.category === label.category) catAgree++;
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
    filtered,
    agreement: total - missing - filtered > 0 ? agree / (total - missing - filtered) : 0,
    coverage: total - filtered > 0 ? (total - filtered - missing) / (total - filtered) : 0,
    perClass,
    confusion,
    categoryAgreement: catTotal > 0 ? catAgree / catTotal : null,
    disagreements,
  };
}
